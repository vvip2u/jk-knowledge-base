#!/usr/bin/env node
/**
 * 建库引擎测试：node:test + node:assert/strict，直接 `node tools/engine-test.mjs` 即可跑。
 * 全部读写都发生在 os.tmpdir() 下的临时目录，结束即删。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ENGINE_VERSION,
  EngineError,
  archiveItems,
  archiveSkillPage,
  curate,
  fingerprintArtifacts,
  listRecentNotes,
  maintain,
  renderSkillPage,
  bootstrap,
  inspect,
  planDirs,
  preflight,
  reindex,
  verify,
} from '../host/engine/index.js';
import { assertPathLength, ensureDir, replaceFile, safeJoin, sanitizeSegment, writeAtomic } from '../host/engine/paths.js';
import { parseFrontmatter, readTags, splitLines, stripBom } from '../host/engine/scan.js';
import { SKILLS, byId } from '../host/skills/catalog.js';
import { renderHeading } from '../host/engine/curate.js';
import { PATH_ERROR_CODES, PATH_GUARD_VERSION, assertWritable, assertWritableSync, authorizeRoot, isPathInside } from '../host/engine/guard.js';

console.log(`[engine-test] platform=${process.platform} arch=${process.arch}`);

/** win32 默认没有创建 symlink 的权限（需开发者模式），相关用例整组跳过并打印原因。 */
function skipSymlinkOnWin32(t, name) {
  if (process.platform !== 'win32') return false;
  console.log(`SKIP ${name}：win32 创建 symlink 需要开发者模式/管理员权限，跳过该用例`);
  t.skip('win32 symlink 需要开发者模式');
  return true;
}

const ASSET_DIRS = [
  '00_系统与索引', '01_收件箱', '02_原始资料库', '03_研究与洞察', '04_思考与假设',
  '05_验证与证据', '06_知识与模型', '07_素材与组件', '08_作品与成果', '09_项目与运营',
  '10_决策与复盘', '11_岗位技能库', '12_归档与历史',
];
const SPEC_NAMES = ['元数据规范.md', '标签体系.md', '原子化笔记标准.md', '编号与溯源链.md', '置信度标准.md'];

async function tmpRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jkkb-engine-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function listDir(dir) {
  return (await fs.readdir(dir, { withFileTypes: true }))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((e) => ({ name: e.name, dir: e.isDirectory() }));
}

async function mtimesBelow(dir, base = dir, acc = new Map()) {
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) await mtimesBelow(abs, base, acc);
    else acc.set(path.relative(base, abs), (await fs.stat(abs)).mtimeMs);
  }
  return acc;
}

async function hasErrorCode(fn, code) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof EngineError, `期望 EngineError，实际 ${err && err.constructor && err.constructor.name}`);
    assert.equal(err.code, code, `期望 code=${code}，实际 ${err.code}`);
    assert.equal(typeof err.message, 'string');
    assert.ok(err.message.length > 0);
    return err;
  }
  assert.fail(`期望抛出 code=${code}，但没有抛错`);
}

test('1. bootstrap(asset) 建出 13 目录 + 5 规范 + 10 模板 + vault.json', async (t) => {
  const root = await tmpRoot(t);
  const steps = [];
  const res = await bootstrap({ root, mode: 'asset', onStep: (e) => steps.push(e) });

  assert.equal(ENGINE_VERSION, '1.0.0');
  assert.equal(PATH_GUARD_VERSION, 1);
  assert.deepEqual([...PATH_ERROR_CODES], ['PATH_ESCAPE', 'PATH_DENIED']);
  assert.equal(res.root, path.resolve(root));
  assert.equal(res.mode, 'asset');
  assert.ok(Array.isArray(res.created) && res.created.length > 0);
  assert.deepEqual(res.conflicts, []);

  const top = await listDir(root);
  const topDirs = top.filter((e) => e.dir && !e.name.startsWith('.')).map((e) => e.name);
  assert.equal(topDirs.length, 13);
  assert.deepEqual(topDirs, ASSET_DIRS);

  for (const name of ASSET_DIRS) {
    const readme = await fs.readFile(path.join(root, name, '_说明.md'), 'utf8');
    assert.ok(readme.length > 100, `${name}/_说明.md 太短`);
    assert.ok(readme.includes('## 这个目录放什么'), `${name}/_说明.md 缺结构`);
    assert.ok(readme.includes('## 不放什么'));
    assert.ok(readme.includes('## 命名规则'));
  }
  const a = await fs.readFile(path.join(root, '00_系统与索引', '_说明.md'), 'utf8');
  const b = await fs.readFile(path.join(root, '02_原始资料库', '_说明.md'), 'utf8');
  assert.notEqual(a, b, '每个目录的 _说明.md 必须按目录定制');

  const specsDir = path.join(root, '00_系统与索引', '03_标签与元数据字典');
  for (const name of SPEC_NAMES) {
    const text = await fs.readFile(path.join(specsDir, name), 'utf8');
    assert.ok(text.startsWith('---'), `${name} 缺 frontmatter`);
    assert.ok(text.includes('confidence: 高'));
    assert.ok(text.length > 800, `${name} 内容太薄`);
  }

  const tplDir = path.join(root, '00_系统与索引', '07_标准模板');
  const tpls = (await fs.readdir(tplDir)).filter((f) => f.endsWith('.md') && f !== '_说明.md');
  assert.equal(tpls.length, 10, `模板应有 10 个，实际 ${tpls.length}：${tpls.join(',')}`);

  const moc = await fs.readFile(path.join(root, '00_系统与索引', '00_知识库首页.md'), 'utf8');
  assert.ok(moc.includes('<!-- jkkb:moc-map:start -->'));
  assert.ok(moc.includes('目录地图'));
  assert.ok(moc.includes('元数据规范'));

  const vault = JSON.parse(await fs.readFile(path.join(root, '.jkkb', 'vault.json'), 'utf8'));
  assert.equal(vault.version, '1.0');
  assert.equal(vault.mode, 'asset');
  assert.equal(vault.root, path.resolve(root));
  assert.equal(vault.dirs.length, 13);
  assert.ok(vault.createdAt && vault.updatedAt);
  assert.ok(vault.seq && typeof vault.seq.DOC === 'number');

  const stepNames = steps.map((s) => `${s.step}:${s.status}`);
  assert.ok(stepNames.includes('dirs:ok'));
  assert.ok(stepNames.includes('contract:ok'));

  const v = await verify({ root });
  assert.equal(v.root, path.resolve(root));
  assert.ok(v.ok, `bootstrap 后体检应通过，实际：${v.errors.map((e) => e.message).join(';')}`);
  assert.equal(v.counts.error, 0);
  assert.ok(v.warnings.some((w) => w.id === 'index_missing'), '未建索引时应提示 index_missing');
});

test('2. 二次 bootstrap 幂等：created 为空、mtime 不变、用户改过的 _说明.md 不被覆盖', async (t) => {
  const root = await tmpRoot(t);
  await bootstrap({ root });

  const readme = path.join(root, '05_验证与证据', '_说明.md');
  const userText = '# 我自己改过的说明\n\n这里只放实验记录。\n';
  await fs.writeFile(readme, userText, 'utf8');
  const before = await mtimesBelow(root);

  const second = await bootstrap({ root });
  assert.deepEqual(second.created, [], `二次 bootstrap 不应新建文件：${second.created.join(',')}`);
  assert.deepEqual(second.conflicts, []);
  assert.ok(second.skipped.length > 20);

  const after = await mtimesBelow(root);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [rel, ms] of before) {
    if (rel.endsWith('_说明.md') && rel.startsWith('05_验证与证据')) continue;
    assert.equal(after.get(rel), ms, `${rel} 被改写（mtime 变了）`);
  }
  assert.equal(await fs.readFile(readme, 'utf8'), userText, '用户改过的 _说明.md 被覆盖了');

  // force 才覆盖
  const forced = await bootstrap({ root, force: true });
  assert.ok(forced.created.length > 20);
  assert.ok((await fs.readFile(readme, 'utf8')).includes('## 这个目录放什么'));
});

test('3. mode=topic 产出与 asset 不同', async (t) => {
  const root = await tmpRoot(t);
  await bootstrap({ root, mode: 'topic' });

  const topDirs = (await listDir(root)).filter((e) => e.dir && !e.name.startsWith('.')).map((e) => e.name);
  assert.deepEqual(topDirs, ['00-规范', '99-收件箱', '_模板']);
  assert.ok(!topDirs.includes('00_系统与索引'));

  const vault = JSON.parse(await fs.readFile(path.join(root, '.jkkb', 'vault.json'), 'utf8'));
  assert.equal(vault.mode, 'topic');
  assert.equal(vault.dirs.length, 3);

  for (const name of SPEC_NAMES) {
    await fs.access(path.join(root, '00-规范', name));
  }
  const tpls = (await fs.readdir(path.join(root, '_模板'))).filter((f) => f.endsWith('.md') && f !== '_说明.md');
  assert.equal(tpls.length, 10);

  const topicIdx = await reindex({ root });
  assert.equal(topicIdx.indexDir, '00-规范/05_索引');
  const tv = await verify({ root });
  assert.ok(tv.ok, tv.errors.map((e) => e.message).join(';'));
  assert.equal(tv.counts.warn, 0, `topic 库不应有告警：${tv.warnings.map((w) => w.id).join(',')}`);

  const preview = await planDirs({ mode: 'topic' });
  assert.equal(preview.mode, 'topic');
  assert.equal(preview.dirs.length, 3);
  await hasErrorCode(() => planDirs({ mode: 'nope' }), 'MODE_INVALID');

  // 已有 asset 库时切 topic 必须显式 force
  const assetRoot = await tmpRoot(t);
  await bootstrap({ root: assetRoot, mode: 'asset' });
  await hasErrorCode(() => bootstrap({ root: assetRoot, mode: 'topic' }), 'MODE_CONFLICT');
});

test('4. verify 能检出缺目录 / vault 损坏 / 孤儿文件', async (t) => {
  const root = await tmpRoot(t);
  await bootstrap({ root });
  assert.ok((await verify({ root })).ok);

  // ① 删掉一个顶层目录
  await fs.rm(path.join(root, '07_素材与组件'), { recursive: true, force: true });
  let v = await verify({ root });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.id === 'top_dirs_missing' && e.message.includes('07_素材与组件')), '未检出缺目录');
  assert.ok(v.errors.find((e) => e.id === 'top_dirs_missing').fix, 'error 应带 fix');
  await bootstrap({ root });

  // ② vault.json 损坏
  const vaultPath = path.join(root, '.jkkb', 'vault.json');
  const good = await fs.readFile(vaultPath, 'utf8');
  await fs.writeFile(vaultPath, '{ not json', 'utf8');
  v = await verify({ root });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.id === 'vault_invalid'), '未检出 vault 损坏');

  // schema 不对（合法 JSON 但缺字段）
  await fs.writeFile(vaultPath, JSON.stringify({ mode: 'asset' }), 'utf8');
  v = await verify({ root });
  assert.ok(v.errors.some((e) => e.id === 'vault_schema'), '未检出 vault schema 错误');
  await fs.writeFile(vaultPath, good, 'utf8');
  assert.ok((await verify({ root })).ok);

  // ③ 顶层塞入孤儿文件与孤儿目录
  await fs.writeFile(path.join(root, '孤儿笔记.md'), '# 孤儿\n', 'utf8');
  await fs.mkdir(path.join(root, '随手建的目录'), { recursive: true });
  v = await verify({ root });
  assert.ok(v.warnings.some((w) => w.id === 'orphan_files' && w.message.includes('孤儿笔记.md')), '未检出孤儿文件');
  assert.ok(v.warnings.some((w) => w.id === 'orphan_dirs' && w.message.includes('随手建的目录')), '未检出孤儿目录');
  assert.ok(v.warnings.some((w) => w.id === 'dir_naming'), '未检出目录命名不合规');

  // ④ 缺 _说明.md
  await fs.rm(path.join(root, '01_收件箱', '_说明.md'));
  v = await verify({ root });
  assert.ok(v.errors.some((e) => e.id === 'readme_missing' && e.message.includes('01_收件箱')), '未检出缺 _说明.md');
});

test('5. reindex 生成索引，条目数与真实文件数一致', async (t) => {
  const root = await tmpRoot(t);
  await bootstrap({ root });
  await fs.writeFile(path.join(root, '01_收件箱', '随手记一.md'), '# 一\n', 'utf8');
  await fs.writeFile(path.join(root, '01_收件箱', '随手记二.md'), '# 二\n', 'utf8');

  const steps = [];
  const noteOne = path.join(root, '01_收件箱', '随手记一.md');
  const res = await reindex({ root, onStep: (e) => steps.push(e) });
  assert.equal(await fs.readFile(noteOne, 'utf8'), '# 一\n', 'reindex 不得修改用户笔记内容');
  assert.equal(res.indexDir, '00_系统与索引/05_索引');
  const notesIdx = path.join(root, '00_系统与索引', '05_索引', '笔记索引.md');
  const dirIdx = path.join(root, '00_系统与索引', '05_索引', '目录索引.md');
  const notesText = await fs.readFile(notesIdx, 'utf8');
  const dirText = await fs.readFile(dirIdx, 'utf8');

  const rows = notesText.split('\n').filter((l) => l.startsWith('| ') && !l.includes('---') && !l.startsWith('| 文件名'));
  assert.equal(rows.length, res.notes, '索引条目数应等于扫描到的笔记数');
  assert.ok(rows.some((l) => l.includes('随手记一.md')));

  const marker = notesText.match(/<!-- jkkb:index files=(\d+) notes=(\d+) dirs=(\d+)/);
  assert.ok(marker, '索引页缺统计标记');
  assert.equal(Number(marker[1]), res.files);
  assert.equal(Number(marker[2]), res.notes);

  const dirRows = dirText.split('\n').filter((l) => l.startsWith('| ') && !l.includes('---') && !l.startsWith('| 目录'));
  assert.equal(dirRows.length, res.dirs);

  // 真实文件数（排除索引目录自身）
  let realNotes = 0;
  async function walk(dir) {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs);
      if (rel === '00_系统与索引/05_索引' || ent.name.startsWith('.')) continue;
      if (ent.isDirectory()) await walk(abs);
      else if (ent.name.endsWith('.md')) realNotes += 1;
    }
  }
  await walk(root);
  assert.equal(res.notes, realNotes, '扫描笔记数应等于真实 md 文件数');
  assert.equal(res.notes, rows.length);

  const v = await verify({ root });
  assert.ok(v.ok, v.errors.map((e) => e.message).join(';'));
  assert.ok(v.infos.some((i) => i.id === 'index_ok'), '索引应与文件数一致');

  // 索引是刷新的：再写一篇，索引数字应过期
  await fs.writeFile(path.join(root, '01_收件箱', '随手记三.md'), '# 三\n', 'utf8');
  const stale = await verify({ root });
  assert.ok(stale.warnings.some((w) => w.id === 'index_stale'), '新增笔记后索引应被判为过期');

  // 备份文件名带时间戳且 Windows 安全（不含冒号）
  await reindex({ root });
  const backups = await fs.readdir(path.join(root, '.jkkb', 'backup'));
  assert.ok(backups.length > 0, '第二次 reindex 应留下索引备份');
  for (const name of backups) {
    assert.equal(name.includes(':'), false, `备份文件名不得含冒号：${name}`);
    assert.match(name, /^\d{8}-\d{6}-.+\.prev\.md$/);
  }

  const info = await inspect({ root });
  assert.equal(info.exists, true);
  assert.equal(info.hasVault, true);
  assert.equal(info.mode, 'asset');
  assert.equal(info.topDirs, 13);
  assert.ok(info.noteCount >= res.notes + 1);
  assert.ok(info.lastModified);
  assert.ok(info.vaultUpdatedAt);
});

test('6. root 校验：不存在 / 相对路径 / 指向文件 / 系统目录', async (t) => {
  const root = await tmpRoot(t);

  await hasErrorCode(() => bootstrap({ root: path.join(root, '不存在') }), 'ROOT_NOT_FOUND');
  await hasErrorCode(() => bootstrap({ root: 'relative/dir' }), 'INVALID_ROOT');
  await hasErrorCode(() => bootstrap({ root: '' }), 'INVALID_ROOT');

  const file = path.join(root, 'a-file.txt');
  await fs.writeFile(file, 'x', 'utf8');
  await hasErrorCode(() => bootstrap({ root: file }), 'NOT_DIRECTORY');
  await hasErrorCode(() => verify({ root: path.join(root, '不存在') }), 'ROOT_NOT_FOUND');
  await hasErrorCode(() => reindex({ root: path.join(root, '不存在') }), 'ROOT_NOT_FOUND');

  await hasErrorCode(() => bootstrap({ root: '/' }), 'FORBIDDEN_ROOT');
  await hasErrorCode(() => bootstrap({ root: os.homedir() }), 'FORBIDDEN_ROOT');

  // 合法但还没有契约：reindex 应报 VAULT_INVALID，inspect 不抛
  const empty = await tmpRoot(t);
  await hasErrorCode(() => reindex({ root: empty }), 'VAULT_INVALID');
  const info = await inspect({ root: empty });
  assert.equal(info.exists, true);
  assert.equal(info.hasVault, false);
  assert.equal(info.mode, null);
  assert.equal(info.topDirs, 0);
  assert.equal(info.noteCount, 0);

  const missing = await inspect({ root: path.join(empty, '还没有') });
  assert.equal(missing.exists, false);
  assert.equal(missing.fileCount, 0);
});

test('7. 路径逃逸：.. 与绝对路径都写不出 root', async (t) => {
  const parent = await tmpRoot(t);
  const root = path.join(parent, 'vault');
  await fs.mkdir(root);

  await hasErrorCode(() => Promise.resolve(safeJoin(root, '../evil.md')), 'PATH_ESCAPE');
  await hasErrorCode(() => Promise.resolve(safeJoin(root, 'a/../../evil.md')), 'PATH_ESCAPE');
  await hasErrorCode(() => Promise.resolve(safeJoin(root, '/etc/passwd')), 'PATH_ESCAPE');
  // 正常路径照常工作，但含 .. 的一律拒绝（宁可严一点）
  assert.equal(safeJoin(root, '02_原始资料库/a.md'), path.join(root, '02_原始资料库', 'a.md'));
  await hasErrorCode(() => Promise.resolve(safeJoin(root, '02_原始资料库/../a.md')), 'PATH_ESCAPE');

  // 带 .. 的 root：解析后落在 tmp 内但不存在 → ROOT_NOT_FOUND，且不创建任何目录
  const outside = path.join(parent, 'outside');
  await hasErrorCode(() => bootstrap({ root: path.join(root, '..', 'outside') }), 'ROOT_NOT_FOUND');
  let created = true;
  try {
    await fs.access(outside);
  } catch {
    created = false;
  }
  assert.equal(created, false, 'root 之外不应被创建');

  // 正常 bootstrap 只在 root 内产生东西
  await bootstrap({ root });
  const siblings = await fs.readdir(parent);
  assert.deepEqual(siblings.sort(), ['vault']);
});

test('8. symlink 逃逸：assertWritable 抛 PATH_ESCAPE，bootstrap 在写该目录前失败', async (t) => {
  if (skipSymlinkOnWin32(t, 'test 8')) return;
  const parent = await tmpRoot(t);
  const root = path.join(parent, 'vault');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'sentinel.txt'), 'outside\n', 'utf8');
  // root/01_收件箱 → root 外目录的软链
  await fs.symlink(outside, path.join(root, '01_收件箱'), 'dir');

  const real = await authorizeRoot(root);
  assert.equal(real.root, path.resolve(root));
  assert.ok(real.realpath.endsWith('/vault'));

  await hasErrorCode(() => assertWritable(root, path.join(root, '01_收件箱', '_说明.md')), 'PATH_ESCAPE');
  await hasErrorCode(() => assertWritable(root, path.join(root, '01_收件箱')), 'PATH_ESCAPE');
  await hasErrorCode(() => bootstrap({ root }), 'PATH_ESCAPE');

  // root 外不得被写出任何东西：outside 里只有哨兵文件
  assert.deepEqual((await fs.readdir(outside)).sort(), ['sentinel.txt']);
  assert.equal(await fs.readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside\n');
  await assert.rejects(fs.access(path.join(outside, '_说明.md')));

  // 正常子树不受影响（软链之外照常写）
  assert.ok(await fs.access(path.join(root, '00_系统与索引', '_说明.md')).then(() => true).catch(() => false));
});

test('9. 保留区：/、/System、~/.dsh 等一律 PATH_DENIED', async (t) => {
  const root = await tmpRoot(t);
  const home = os.homedir();
  await hasErrorCode(() => assertWritable(root, '/'), 'PATH_DENIED');
  await hasErrorCode(() => assertWritable(root, '/System/Library/anything.txt'), 'PATH_DENIED');
  await hasErrorCode(() => assertWritable(root, '/Library/Preferences/x.plist'), 'PATH_DENIED');
  await hasErrorCode(() => assertWritable(root, path.join(home, '.dsh', 'x.json')), 'PATH_DENIED');
  await hasErrorCode(() => assertWritable(root, path.join(home, '.ssh', 'id_ed25519')), 'PATH_DENIED');
  await hasErrorCode(() => assertWritable(root, path.join(home, 'Library', 'Keychains', 'login.keychain')), 'PATH_DENIED');
  await hasErrorCode(() => assertWritable(root, home), 'PATH_DENIED');
  await hasErrorCode(() => authorizeRoot('/'), 'PATH_DENIED');
  await hasErrorCode(() => authorizeRoot(home), 'PATH_DENIED');

  // root 自身正常
  await assertWritable(root, path.join(root, '02_原始资料库', '笔记.md'));
});

test('10. .jkkb 白名单：非白名单条目 PATH_DENIED，runs/backup/vault 放行', async (t) => {
  const root = await tmpRoot(t);
  await hasErrorCode(() => assertWritable(root, path.join(root, '.jkkb', 'evil.txt')), 'PATH_DENIED');
  await hasErrorCode(() => assertWritable(root, path.join(root, '.jkkb', 'nested', 'x.json')), 'PATH_DENIED');

  for (const rel of ['.jkkb/vault.json', '.jkkb/lock.json', '.jkkb/DEGRADED.txt', '.jkkb/runs/r1.jsonl', '.jkkb/backup/a.md']) {
    await assertWritable(root, path.join(root, rel)); // 不抛即通过
  }
  await assertWritable(root, path.join(root, '.jkkb'));
});

test('11. 守卫接入 writeAtomic：.jkkb/runs 可写，.jkkb/evil 与 root 外均被拒', async (t) => {
  const parent = await tmpRoot(t);
  const root = path.join(parent, 'vault');
  await fs.mkdir(root);

  const runLog = path.join(root, '.jkkb', 'runs', 'r1.jsonl');
  assert.equal(await writeAtomic(runLog, '{"step":"x"}\n', { root }), 'created');
  assert.equal(await fs.readFile(runLog, 'utf8'), '{"step":"x"}\n');
  await writeAtomic(path.join(root, '.jkkb', 'backup', 'a.md'), 'old\n', { root });
  await writeAtomic(path.join(root, '.jkkb', 'vault.json'), '{}\n', { root });

  await hasErrorCode(() => writeAtomic(path.join(root, '.jkkb', 'evil.txt'), 'x', { root }), 'PATH_DENIED');
  await hasErrorCode(() => writeAtomic(path.join(parent, 'escape.txt'), 'x', { root }), 'PATH_ESCAPE');
  await assert.rejects(fs.access(path.join(parent, 'escape.txt')));

  // 目标已存在且是文件：明确报 NOT_DIRECTORY，而不是裸抛 EEXIST/ENOTDIR
  const conflict = path.join(root, 'name-conflict');
  await fs.writeFile(conflict, 'x', 'utf8');
  await hasErrorCode(() => ensureDir(root, conflict), 'NOT_DIRECTORY');

  // 未传 root 时不启用守卫（内部资源读取等只读场景）
  const plain = path.join(parent, 'plain.txt');
  await writeAtomic(plain, 'ok\n');
  assert.equal(await fs.readFile(plain, 'utf8'), 'ok\n');
});

test('12. shouldAbort：dirs 第 2 个目录中断，抛 ABORTED 且留 error step', async (t) => {
  const root = await tmpRoot(t);
  const steps = [];
  let calls = 0;
  const err = await hasErrorCode(
    () => bootstrap({
      root,
      onStep: (e) => steps.push(e),
      shouldAbort: () => (++calls >= 3 ? '用户取消：测试中断' : false),
    }),
    'ABORTED',
  );
  assert.match(err.message, /用户取消：测试中断/);

  const topDirs = (await listDir(root)).filter((e) => e.dir && !e.name.startsWith('.')).map((e) => e.name);
  assert.ok(topDirs.length < 13, `中断后不应建满 13 个目录，实际 ${topDirs.length}`);
  assert.ok(topDirs.length >= 1);
  const errStep = steps.find((s) => s.status === 'error');
  assert.ok(errStep, '中断前必须留一条 status=error 的 step');
  assert.equal(errStep.step, 'dir');
  assert.match(String(errStep.detail), /用户取消/);
  await assert.rejects(fs.access(path.join(root, '.jkkb', 'vault.json')), '中断不应留下半成品契约');

  // 同一 root 重跑（不中断）仍能完成
  const done = await bootstrap({ root });
  assert.ok(done.created.length > 0);
  const top = (await listDir(root)).filter((e) => e.dir && !e.name.startsWith('.')).map((e) => e.name);
  assert.equal(top.length, 13);

  // reindex / verify 也支持中断
  await hasErrorCode(() => reindex({ root, shouldAbort: () => '停止索引' }), 'ABORTED');
  await hasErrorCode(() => verify({ root, shouldAbort: () => '停止体检' }), 'ABORTED');
  await hasErrorCode(() => bootstrap({ root, shouldAbort: () => '非法' }), 'ABORTED');
  await hasErrorCode(() => bootstrap({ root, shouldAbort: 'not-a-fn' }), 'INVALID_ROOT');
});

test('13. assertWritableSync：root 内正常路径放行，且与异步版判定一致', async (t) => {
  const root = await tmpRoot(t);
  assert.doesNotThrow(() => assertWritableSync(root, path.join(root, '00_系统与索引', 'x.md')));
  assert.doesNotThrow(() => assertWritableSync(root, path.join(root, '.jkkb', 'runs', 'r1.jsonl')));
  assert.doesNotThrow(() => assertWritableSync(root, path.join(root, '.jkkb', 'vault.json')));

  const cases = [
    [path.join(root, '.jkkb', 'evil.txt'), 'PATH_DENIED'],
    [path.join(root, '.jkkb', 'nested', 'x.json'), 'PATH_DENIED'],
    ['/System/Library/x', 'PATH_DENIED'],
    [path.join(path.dirname(root), 'outside.txt'), 'PATH_ESCAPE'],
  ];
  for (const [target, code] of cases) {
    await hasErrorCode(() => assertWritable(root, target), code);
    await hasErrorCode(() => assertWritableSync(root, target), code); // 同步版同一判定
  }
});

test('14. assertWritableSync：库外软链抛 PATH_ESCAPE', async (t) => {
  if (skipSymlinkOnWin32(t, 'test 14')) return;
  const parent = await tmpRoot(t);
  const root = path.join(parent, 'vault');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, '外部链'), 'dir');

  await hasErrorCode(() => assertWritableSync(root, path.join(root, '外部链', 'x.md')), 'PATH_ESCAPE');
  await hasErrorCode(() => assertWritableSync(root, path.join(root, '外部链')), 'PATH_ESCAPE');
  await assert.rejects(fs.access(path.join(outside, 'x.md')));
});

test('15. assertWritableSync：.jkkb 非白名单条目抛 PATH_DENIED', async (t) => {
  const root = await tmpRoot(t);
  await hasErrorCode(() => assertWritableSync(root, path.join(root, '.jkkb', 'evil.txt')), 'PATH_DENIED');
  await hasErrorCode(() => assertWritableSync(root, path.join(root, '.jkkb', 'backupx', 'a.md')), 'PATH_DENIED');
  assert.doesNotThrow(() => assertWritableSync(root, path.join(root, '.jkkb', 'backup', 'a.md')));
});

test('16. sanitizeSegment：非法字符、Windows 保留名、结尾点空格、长度双限', async () => {
  assert.equal(sanitizeSegment('a<b>c:d"e/f\\g|h?i*j'), 'abcdefghij');
  assert.equal(sanitizeSegment('tab\tname'), 'tabname');
  assert.equal(sanitizeSegment('  name. . '), 'name');
  assert.equal(sanitizeSegment('name...'), 'name');
  assert.equal(sanitizeSegment('CON'), 'CON_');
  assert.equal(sanitizeSegment('con.txt'), 'con_.txt');
  assert.equal(sanitizeSegment('NUL'), 'NUL_');
  assert.equal(sanitizeSegment('LPT9.md'), 'LPT9_.md');
  assert.equal(sanitizeSegment('COM1'), 'COM1_');
  assert.equal(sanitizeSegment('console'), 'console');
  assert.equal(sanitizeSegment(''), '_');
  assert.equal(sanitizeSegment('..'), '_');
  const long = sanitizeSegment('a'.repeat(500));
  assert.equal(long.length, 200);
  const cjk = sanitizeSegment('中'.repeat(500));
  assert.ok(Buffer.byteLength(cjk, 'utf8') <= 200, `UTF-8 字节超限：${Buffer.byteLength(cjk, 'utf8')}`);
  assert.ok(cjk.length <= 200);
  assert.ok(cjk.length > 0);
});

test('17. assertPathLength：模拟 win32 超 240 抛 PATH_TOO_LONG，其他平台不限制', async () => {
  const root = 'C:\\vault';
  assert.doesNotThrow(() => assertPathLength(root, '00_系统与索引/00_知识库首页.md', { platform: 'win32' }));
  await hasErrorCode(() => assertPathLength(root, `deep/${'x'.repeat(300)}.md`, { platform: 'win32' }), 'PATH_TOO_LONG');
  // 边界：总长恰好 240 放行，241 抛（total = root.length + 1 + rel.length）
  const pad = 240 - root.length - 1;
  assert.equal(root.length + 1 + pad, 240);
  assert.doesNotThrow(() => assertPathLength(root, 'a'.repeat(pad), { platform: 'win32', limit: 240 }));
  await hasErrorCode(() => assertPathLength(root, 'a'.repeat(pad + 1), { platform: 'win32', limit: 240 }), 'PATH_TOO_LONG');
  // darwin / linux 不限制
  assert.doesNotThrow(() => assertPathLength('/tmp/vault', `deep/${'x'.repeat(500)}.md`, { platform: 'darwin' }));
  assert.doesNotThrow(() => assertPathLength('/tmp/vault', `deep/${'x'.repeat(500)}.md`, { platform: 'linux' }));
});

test('18. replaceFile：覆盖已存在文件成功（POSIX rename 与 win32 unlink+rename 两条分支）', async (t) => {
  const root = await tmpRoot(t);
  const dest = path.join(root, 'dest.md');
  const tmpA = path.join(root, 'a.tmp');
  await fs.writeFile(dest, 'old\n', 'utf8');
  await fs.writeFile(tmpA, 'new\n', 'utf8');
  const r1 = await replaceFile(tmpA, dest);
  assert.equal(r1, 'renamed');
  assert.equal(await fs.readFile(dest, 'utf8'), 'new\n');
  await assert.rejects(fs.access(tmpA));

  // 在非 win32 上强制走 win32 分支（unlink 后 rename），验证覆盖已存在目标
  const tmpB = path.join(root, 'b.tmp');
  await fs.writeFile(tmpB, 'win\n', 'utf8');
  const r2 = await replaceFile(tmpB, dest, { platform: 'win32', baseDelayMs: 1 });
  assert.equal(r2, 'replaced');
  assert.equal(await fs.readFile(dest, 'utf8'), 'win\n');

  // 目标不存在时也应成功
  const tmpC = path.join(root, 'c.tmp');
  await fs.writeFile(tmpC, 'fresh\n', 'utf8');
  await replaceFile(tmpC, path.join(root, 'fresh.md'), { platform: 'win32', baseDelayMs: 1 });
  assert.equal(await fs.readFile(path.join(root, 'fresh.md'), 'utf8'), 'fresh\n');
});

test('19. 包含判定不接受同前缀兄弟目录（root=/a/b 时 /a/bc 必须拒绝）', async (t) => {
  const parent = await tmpRoot(t);
  const root = path.join(parent, 'a', 'b');
  const sibling = path.join(parent, 'a', 'bc');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(sibling, { recursive: true });
  await fs.mkdir(path.join(parent, 'a', 'b2'), { recursive: true });

  await hasErrorCode(() => assertWritable(root, path.join(sibling, 'x.md')), 'PATH_ESCAPE');
  await hasErrorCode(() => assertWritable(root, path.join(parent, 'a', 'b2', 'x.md')), 'PATH_ESCAPE');
  await hasErrorCode(() => assertWritableSync(root, path.join(sibling, 'x.md')), 'PATH_ESCAPE');
  await assert.rejects(fs.access(path.join(sibling, 'x.md')));

  // 真正的子路径照常放行
  assert.doesNotThrow(() => assertWritableSync(root, path.join(root, 'sub', 'x.md')));
});

test('20. BOM 文件：frontmatter 能解析，title/tags 不丢', async (t) => {
  const root = await tmpRoot(t);
  const file = path.join(root, 'bom-note.md');
  await fs.writeFile(file, '\uFEFF---\ntitle: BOM 笔记\nl1: 资料/一手\nl2: [实施顾问, 突发事故应急]\n---\n\n正文\n', 'utf8');

  const fm = parseFrontmatter(await fs.readFile(file, 'utf8'));
  assert.equal(fm.title, 'BOM 笔记');
  assert.equal(fm.l1, '资料/一手');

  const tags = await readTags(file);
  assert.equal(tags, '资料/一手 / 实施顾问 / 突发事故应急');

  assert.equal(stripBom('\uFEFF---'), '---');
  assert.equal(stripBom('\uFEFF\uFEFF\uFEFF---'), '---');
  assert.equal(stripBom('\uFEFF\uFEFF\uFEFF\uFEFF---'), '\uFEFF---'); // 最多剥 3 个
});

test('21. CRLF 文件：解析值无尾随 \r（长度与结尾字符断言）', async (t) => {
  const root = await tmpRoot(t);
  const text = '---\r\ntitle: CRLF 笔记\r\nl1: 研究/行业\r\nl2: [内容运营]\r\nsource: "现场访谈"\r\n---\r\n\r\n正文\r\n';
  const file = path.join(root, 'crlf-note.md');
  await fs.writeFile(file, text, 'utf8');

  const fm = parseFrontmatter(text);
  assert.equal(fm.title, 'CRLF 笔记');
  assert.equal(fm.title.length, 'CRLF 笔记'.length);
  assert.notEqual(fm.title.slice(-1), '\r');
  assert.equal(fm.source, '现场访谈');
  assert.equal(fm.l2, '[内容运营]');
  for (const [key, value] of Object.entries(fm)) {
    assert.equal(value.includes('\r'), false, `${key} 仍带 \r：${JSON.stringify(value)}`);
  }
  assert.deepEqual(splitLines('a\r\nb\r\nc'), ['a', 'b', 'c']);
  assert.deepEqual(splitLines('a\nb'), ['a', 'b']);

  const tags = await readTags(file);
  assert.equal(tags, '研究/行业 / 内容运营');
});

test('22. BOM+CRLF 组合：解析正确，reindex/inspect 计数不受影响', async (t) => {
  const root = await tmpRoot(t);
  await bootstrap({ root });
  const dir = path.join(root, '01_收件箱');
  const bomCrlf = path.join(dir, 'BOM与CRLF.md');
  const crlfOnly = path.join(dir, '仅CRLF.md');
  const body1 = '\uFEFF---\r\ntitle: 甲\r\nl1: 资料/一手\r\nl2: [交付中]\r\n---\r\n\r\n正文甲\r\n';
  const body2 = '---\r\ntitle: 乙\r\nl1: 思考/假设\r\n---\r\n\r\n正文乙\r\n';
  await fs.writeFile(bomCrlf, body1, 'utf8');
  await fs.writeFile(crlfOnly, body2, 'utf8');

  assert.equal(parseFrontmatter(body1).title, '甲');
  assert.equal(await readTags(bomCrlf), '资料/一手 / 交付中');

  const res = await reindex({ root });
  assert.equal(res.notes, 37, `bootstrap 35 篇 + 新增 2 篇，实际 ${res.notes}`);

  const notesText = await fs.readFile(path.join(root, '00_系统与索引', '05_索引', '笔记索引.md'), 'utf8');
  const rows = notesText.split('\n').filter((l) => l.startsWith('| ') && !l.includes('---') && !l.startsWith('| 文件名'));
  assert.equal(rows.length, res.notes);
  assert.ok(rows.some((l) => l.includes('BOM与CRLF.md')));
  assert.ok(rows.some((l) => l.includes('仅CRLF.md')));
  assert.ok(rows.some((l) => l.includes('资料/一手 / 交付中')), '索引里的标签应能读到');

  const info = await inspect({ root });
  assert.ok(info.noteCount >= res.notes);
  assert.equal(await fs.readFile(bomCrlf, 'utf8'), body1, 'reindex 不得改写用户文件（含 BOM/CRLF）');

  const v = await verify({ root });
  assert.ok(v.ok, v.errors.map((e) => e.message).join(';'));
  assert.ok(v.infos.some((i) => i.id === 'index_ok'));
});

test('23. preflight：空目录返回 ok 且 freeBytes 为数字或 null', async (t) => {
  const root = await tmpRoot(t);
  const r = await preflight({ root, mode: 'asset' });

  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.equal(r.code, 'OK');
  assert.ok(Number.isFinite(r.elapsedMs) && r.elapsedMs >= 0);
  assert.ok(r.freeBytes === null || typeof r.freeBytes === 'number');
  assert.deepEqual(r.counts, { files: 0, notes: 0, limit: 5000, truncated: false });
  assert.equal(r.counts.limit, 5000);

  const ids = r.checks.map((c) => c.id);
  for (const id of ['root', 'guard', 'files', 'vault', 'disk', 'writable']) {
    assert.ok(ids.includes(id), `缺少检查项 ${id}`);
  }
  assert.ok(r.checks.every((c) => ['ok', 'warn', 'error'].includes(c.level)));
  assert.ok(r.checks.every((c) => typeof c.title === 'string' && typeof c.detail === 'string'));

  // 探针不得留下任何文件
  const runs = await fs.readdir(path.join(root, '.jkkb', 'runs')).catch(() => []);
  assert.deepEqual(runs, []);
});

test('24. preflight：root 不存在 → ROOT_UNAVAILABLE（detail 带路径与 errno）', async (t) => {
  const parent = await tmpRoot(t);
  const missing = path.join(parent, '还没有这个目录');
  const r = await preflight({ root: missing });

  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROOT_UNAVAILABLE');
  const rootCheck = r.checks.find((c) => c.id === 'root');
  assert.equal(rootCheck.level, 'error');
  assert.ok(rootCheck.detail.includes(missing));
  assert.match(rootCheck.detail, /errno=ENOENT/);
  await assert.rejects(fs.access(missing));
});

test('25. preflight：不可写目录 → ROOT_NOT_WRITABLE，detail 含 errno', async (t) => {
  if (process.platform === 'win32') {
    console.log('SKIP test 25：win32 无 POSIX 权限位（管理员还会绕过 chmod），跳过只读目录用例');
    t.skip('win32 无 POSIX 权限位');
    return;
  }
  const root = await tmpRoot(t);
  await fs.chmod(root, 0o555);
  try {
    const r = await preflight({ root });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ROOT_NOT_WRITABLE');
    const probe = r.checks.find((c) => c.id === 'writable');
    assert.equal(probe.level, 'error');
    assert.match(probe.detail, /errno=(EACCES|EPERM)/);
  } finally {
    await fs.chmod(root, 0o755);
  }
});

test('26. preflight：statfs 不可用 → 降级 warn、freeBytes null、ok 仍为 true', async (t) => {
  const root = await tmpRoot(t);
  const r = await preflight({
    root,
    deps: {
      statfs: async () => {
        const err = new Error('mock statfs unavailable');
        err.code = 'ENOSYS';
        throw err;
      },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'OK');
  assert.equal(r.freeBytes, null);
  const disk = r.checks.find((c) => c.id === 'disk');
  assert.equal(disk.level, 'warn');
  assert.match(disk.detail, /ENOSYS/);
});

test('27. preflight：文件数超限 → TOO_MANY_FILES，短路且不写任何文件', async (t) => {
  const root = await tmpRoot(t);
  for (let i = 1; i <= 6; i += 1) {
    await fs.writeFile(path.join(root, `file-${i}.txt`), 'x', 'utf8');
  }
  const started = Date.now();
  const r = await preflight({ root, limits: { maxFiles: 5 } });
  const wall = Date.now() - started;

  assert.equal(r.ok, false);
  assert.equal(r.code, 'TOO_MANY_FILES');
  assert.ok(r.counts.files >= 6, `实际计数 ${r.counts.files}`);
  assert.equal(r.counts.limit, 5);
  const filesCheck = r.checks.find((c) => c.id === 'files');
  assert.equal(filesCheck.level, 'error');
  assert.ok(filesCheck.detail.includes('5'));
  assert.ok(filesCheck.fix && filesCheck.fix.includes('更小的子目录') && filesCheck.fix.includes('maxFiles'));
  assert.ok(wall < 1000, `短路耗时 ${wall}ms 超过 1s`);
  await assert.rejects(fs.access(path.join(root, '.jkkb')), '超限时不得开始写任何文件');
});

test('28. preflight：vault.json 损坏 → VAULT_INVALID；mode 冲突 → MODE_CONFLICT', async (t) => {
  const root = await tmpRoot(t);
  const jkkb = path.join(root, '.jkkb');
  await fs.mkdir(jkkb, { recursive: true });
  const vaultPath = path.join(jkkb, 'vault.json');

  await fs.writeFile(vaultPath, '{ not json', 'utf8');
  let r = await preflight({ root });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VAULT_INVALID');
  assert.equal(r.checks.find((c) => c.id === 'vault').level, 'error');

  await fs.writeFile(vaultPath, JSON.stringify({ version: '1.0', mode: 'asset', status: 'scaffolded' }), 'utf8');
  r = await preflight({ root, mode: 'topic' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MODE_CONFLICT');
  assert.match(r.checks.find((c) => c.id === 'vault').detail, /asset.*topic|topic.*asset/);

  r = await preflight({ root, mode: 'asset' });
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.equal(r.code, 'OK');
  await assert.rejects(fs.access(path.join(root, '..', 'outside')));
});

test('29. bootstrap 的 onStep key 序列稳定且向后兼容', async (t) => {
  const root = await tmpRoot(t);
  const steps = [];
  const res = await bootstrap({ root, onStep: (e) => steps.push(e) });
  assert.ok(res.created.length > 0);

  const keyed = steps.filter((s) => s.key);
  assert.deepEqual(keyed.map((s) => s.key), ['validate', 'dirs', 'specs', 'templates', 'index', 'moc', 'contract']);
  for (const s of keyed) {
    assert.equal(s.status, 'ok', `${s.key} 状态应为 ok`);
    assert.equal(typeof s.detail, 'string');
    assert.ok(s.detail.length > 0, `${s.key} 缺 detail`);
  }
  // 原有字段仍存在且 detail 仍是中文说明
  assert.ok(keyed.find((s) => s.key === 'specs').detail.includes('份'));
  assert.ok(keyed.find((s) => s.key === 'dirs').detail.includes('文件'));
  assert.ok(Array.isArray(keyed.find((s) => s.key === 'dirs').artifacts));

  // 第二次运行（全部文件已存在）key 序列不变
  const steps2 = [];
  await bootstrap({ root, onStep: (e) => steps2.push(e) });
  assert.deepEqual(steps2.filter((s) => s.key).map((s) => s.key), keyed.map((s) => s.key));
});

test('30. dirs 步 artifacts 数量等于目录数，且都在 root 内', async (t) => {
  const root = await tmpRoot(t);
  const steps = [];
  await bootstrap({ root, onStep: (e) => steps.push(e) });

  const dirsEvent = steps.find((s) => s.key === 'dirs');
  assert.ok(dirsEvent, '缺少 key=dirs 的步骤');
  const topDirs = (await listDir(root)).filter((e) => e.dir && !e.name.startsWith('.'));
  assert.equal(dirsEvent.artifacts.length, topDirs.length);
  assert.equal(dirsEvent.artifacts.length, 13);
  for (const p of dirsEvent.artifacts) {
    assert.ok(path.isAbsolute(p), `artifact 必须是绝对路径：${p}`);
    assert.ok(isPathInside(root, p), `artifact 逃逸出 root：${p}`);
    assert.equal(path.basename(p), '_说明.md');
    await fs.access(p);
  }
  // 每篇 _说明.md 与目录一一对应
  const parents = new Set(dirsEvent.artifacts.map((p) => path.basename(path.dirname(p))));
  assert.deepEqual([...parents].sort(), topDirs.map((d) => d.name).sort());
});

test('31. specs/templates/contract 步 artifacts 非空且文件真实存在', async (t) => {
  const root = await tmpRoot(t);
  const steps = [];
  await bootstrap({ root, onStep: (e) => steps.push(e) });
  const byKey = (k) => steps.find((s) => s.key === k);

  const specs = byKey('specs').artifacts;
  assert.equal(specs.length, 5);
  for (const p of specs) {
    assert.ok(path.isAbsolute(p));
    assert.ok(isPathInside(root, p));
    await fs.access(p);
  }

  const tpls = byKey('templates').artifacts;
  assert.ok(tpls.length >= 10, `模板 artifacts 只有 ${tpls.length} 个`);
  for (const p of tpls) assert.ok(isPathInside(root, p));

  const contract = byKey('contract').artifacts;
  assert.equal(contract.length, 1);
  assert.ok(contract[0].endsWith(path.join('.jkkb', 'vault.json')));
  await fs.access(contract[0]);

  const moc = byKey('moc').artifacts;
  assert.equal(moc.length, 1);
  await fs.access(moc[0]);
});

test('32. fingerprintArtifacts：存在返回数字，缺失返回 null 且不抛', async (t) => {
  const root = await tmpRoot(t);
  const file = path.join(root, 'exists.md');
  const missing = path.join(root, 'missing.md');
  await fs.writeFile(file, 'hello\n', 'utf8');

  const fp = await fingerprintArtifacts([file, missing, '', null, 42]);
  assert.equal(fp.length, 2);
  assert.equal(fp[0].path, file);
  assert.equal(typeof fp[0].size, 'number');
  assert.equal(typeof fp[0].mtimeMs, 'number');
  assert.equal(fp[1].path, missing);
  assert.equal(fp[1].size, null);
  assert.equal(fp[1].mtimeMs, null);

  assert.deepEqual(await fingerprintArtifacts(), []);
  assert.deepEqual(await fingerprintArtifacts('not-an-array'), []);

  // 文件被删后再取指纹 → null，不抛
  await fs.unlink(file);
  const fp2 = await fingerprintArtifacts([file]);
  assert.equal(fp2[0].size, null);
});

test('33. reindex 的 key 序列为 validate/scan/index/moc/vault', async (t) => {
  const root = await tmpRoot(t);
  await bootstrap({ root });
  const steps = [];
  const res = await reindex({ root, onStep: (e) => steps.push(e) });

  const keyed = steps.filter((s) => s.key);
  assert.deepEqual(keyed.map((s) => s.key), ['validate', 'scan', 'index', 'moc', 'vault']);
  for (const s of keyed) {
    assert.equal(s.status, 'ok');
    assert.equal(typeof s.detail, 'string');
    assert.ok(s.detail.length > 0);
  }

  const indexEvent = keyed.find((s) => s.key === 'index');
  assert.ok(indexEvent.artifacts.length >= 2, 'index 步至少写出两份索引页');
  for (const p of indexEvent.artifacts) {
    assert.ok(path.isAbsolute(p));
    assert.ok(isPathInside(root, p));
    await fs.access(p);
  }
  assert.equal(keyed.find((s) => s.key === 'moc').artifacts.length, 1);
  assert.equal(keyed.find((s) => s.key === 'vault').artifacts.length, 1);
  assert.ok(res.notes > 0);
});

test('34. .jkkb/store 已放行：合法 namespace 可写', async (t) => {
  const root = await tmpRoot(t);

  assert.doesNotThrow(() => assertWritableSync(root, path.join(root, '.jkkb', 'store')));
  for (const ns of ['numbering', 'skills', 'skill_calls', 'cards', 'reports']) {
    const target = path.join(root, '.jkkb', 'store', ns, 'x.json');
    assert.doesNotThrow(() => assertWritableSync(root, target), `${ns} 应放行`);
    await assertWritable(root, target);
  }

  const file = path.join(root, '.jkkb', 'store', 'skills', 'SK001.json');
  assert.equal(await writeAtomic(file, '{"id":"SK001"}\n', { root }), 'created');
  assert.equal(await fs.readFile(file, 'utf8'), '{"id":"SK001"}\n');
  assert.equal(await writeAtomic(path.join(root, '.jkkb', 'store', 'skills', 'index.json'), '{}\n', { root }), 'created');
});

test('35. .jkkb/store 未知 namespace 仍拒绝（PATH_DENIED）', async (t) => {
  const root = await tmpRoot(t);
  for (const bad of ['evil', 'numbers', 'skills_old', 'SKILLS2']) {
    const target = path.join(root, '.jkkb', 'store', bad, 'x.json');
    await hasErrorCode(() => assertWritable(root, target), 'PATH_DENIED');
    await hasErrorCode(() => assertWritableSync(root, target), 'PATH_DENIED');
  }
  await hasErrorCode(
    () => writeAtomic(path.join(root, '.jkkb', 'store', 'evil', 'x.json'), 'x', { root }),
    'PATH_DENIED',
  );
  await assert.rejects(fs.access(path.join(root, '.jkkb', 'store', 'evil', 'x.json')));
});

test('36. .jkkb 其它未登记条目仍拒绝（store 只开它自己）', async (t) => {
  const root = await tmpRoot(t);
  for (const bad of ['evil.txt', 'storex/a.json', 'runsx/x.json', 'backup2/x.json', 'store2/skills/x.json']) {
    await hasErrorCode(() => assertWritable(root, path.join(root, '.jkkb', bad)), 'PATH_DENIED');
    await hasErrorCode(() => assertWritableSync(root, path.join(root, '.jkkb', bad)), 'PATH_DENIED');
  }
  // 既有白名单项不受影响
  assert.doesNotThrow(() => assertWritableSync(root, path.join(root, '.jkkb', 'runs', 'r.jsonl')));
  assert.doesNotThrow(() => assertWritableSync(root, path.join(root, '.jkkb', 'backup', 'b.md')));
  assert.doesNotThrow(() => assertWritableSync(root, path.join(root, '.jkkb', 'vault.json')));
});

const CURATE_SKILL = 'biz.customer_interview';   // capture → 02_原始资料库
const QUICK_SKILL = 'common.quick_capture';      // capture 例外 → 01_收件箱
const RESEARCH_SKILL = 'biz.need_digest';        // research → 03_研究与洞察

function curateArgs(root, extra = {}) {
  return {
    root,
    skillId: CURATE_SKILL,
    title: '客户访谈-示例',
    body: '受访者提到：续费主要看响应速度。',
    tags: ['访谈', '客户'],
    confidence: '高',
    source: '现场访谈第 7 场',
    nextId: 'R-2026-101',
    now: '2026-10-17T12:00:00',
    ...extra,
  };
}

async function mdFilesUnder(dir) {
  const out = [];
  async function walk(d, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs, depth + 1);
      else if (e.name.endsWith('.md')) out.push(abs);
    }
  }
  await walk(dir, 0);
  return out;
}

test('37. curate 正常入柜：capture 落 02、快速收件卡落 01，frontmatter 关键字段齐全', async (t) => {
  const root = await tmpRoot(t);
  const steps = [];
  const r = await curate(curateArgs(root, { onStep: (e) => steps.push(e) }));

  assert.equal(r.ok, true);
  assert.equal(r.id, 'R-2026-101');
  assert.equal(r.skill.outputDir, '02_原始资料库');
  assert.equal(r.skill.idPrefix, 'R');
  // body 没有二级标题：整段进第一个内容节，其余模板节标缺（缺省只写提示，不编造）
  assert.ok(r.warnings.length > 0);
  assert.ok(r.warnings.every((w) => w.code === 'SECTION_MISSING'), JSON.stringify(r.warnings));
  assert.ok(r.warnings.some((w) => w.section === '原始内容摘要'));

  const expected = path.join(root, '02_原始资料库', 'R-2026-101-客户访谈-示例.md');
  assert.equal(r.path, expected);
  const text = await fs.readFile(expected, 'utf8');
  const fm = parseFrontmatter(text);
  for (const key of ['id', 'title', 'date', 'tags', 'confidence']) {
    assert.ok(fm[key], `frontmatter 缺 ${key}`);
  }
  assert.equal(fm.id, 'R-2026-101');
  assert.equal(fm.title, '客户访谈-示例');
  assert.equal(fm.date, '2026-10-17');
  assert.ok(fm.tags.includes('访谈') && fm.tags.includes('客户'), fm.tags);
  assert.equal(fm.confidence, '高');
  assert.equal(fm.skill, CURATE_SKILL);
  assert.equal(fm.schema_version, '1');
  assert.ok(text.includes('受访者提到：续费主要看响应速度。'));
  assert.match(text, /^# /m);

  const keys = [...new Set(steps.filter((s) => s.key).map((s) => s.key))];
  assert.deepEqual(keys, ['validate', 'allocate', 'render', 'write', 'record']);

  // 快速收件卡 → 01_收件箱（低置信度必须写理由）
  const r2 = await curate(curateArgs(root, {
    skillId: QUICK_SKILL,
    title: '随手记',
    body: '一个还没想清楚的想法',
    tags: ['收件'],
    confidence: '低',
    confWhy: '来源不明，待核实',
    nextId: 'DOC-2026-001',
  }));
  assert.equal(r2.skill.outputDir, '01_收件箱');
  const p2 = path.join(root, '01_收件箱', 'DOC-2026-001-随手记.md');
  assert.equal(r2.path, p2);
  assert.equal(parseFrontmatter(await fs.readFile(p2, 'utf8')).conf_why, '来源不明，待核实');
});

test('38. curate 的 id 由 nextId 注入，且只调用一次', async (t) => {
  const root = await tmpRoot(t);
  let calls = 0;
  const r = await curate(curateArgs(root, {
    skillId: RESEARCH_SKILL,
    nextId: () => { calls += 1; return 'S-2026-042'; },
  }));
  assert.equal(calls, 1);
  assert.equal(r.id, 'S-2026-042');
  assert.equal(r.skill.outputDir, '03_研究与洞察');
  assert.ok(r.path.endsWith(path.join('03_研究与洞察', 'S-2026-042-客户访谈-示例.md')));
  await fs.access(r.path);
});

test('39. confidence=低 缺 confWhy → CONFIDENCE_REQUIRED，且不落盘', async (t) => {
  const root = await tmpRoot(t);
  const err = await hasErrorCode(
    () => curate(curateArgs(root, { confidence: '低', confWhy: '' })),
    'CONFIDENCE_REQUIRED',
  );
  assert.match(err.message, /confWhy/);
  assert.deepEqual(await mdFilesUnder(path.join(root, '02_原始资料库')).catch(() => []), []);
  await assert.rejects(fs.access(path.join(root, '02_原始资料库')));

  // confWhy 太短同样拒绝
  await hasErrorCode(() => curate(curateArgs(root, { confidence: '低', confWhy: '短' })), 'CONFIDENCE_REQUIRED');
});

test('40. tags 空 → TAGS_REQUIRED', async (t) => {
  const root = await tmpRoot(t);
  await hasErrorCode(() => curate(curateArgs(root, { tags: [] })), 'TAGS_REQUIRED');
  await hasErrorCode(() => curate(curateArgs(root, { tags: 'not-array' })), 'TAGS_REQUIRED');
  await hasErrorCode(() => curate(curateArgs(root, { tags: ['ok', '  '] })), 'TAGS_REQUIRED');
});

test('41. title 必填且 ≤120 字符', async (t) => {
  const root = await tmpRoot(t);
  await hasErrorCode(() => curate(curateArgs(root, { title: '   ' })), 'TITLE_INVALID');
  await hasErrorCode(() => curate(curateArgs(root, { title: '标'.repeat(121) })), 'TITLE_INVALID');
  // 恰好 120 放行
  const r = await curate(curateArgs(root, { title: '标'.repeat(120), nextId: 'R-2026-102' }));
  assert.equal(r.ok, true);
});

test('42. 未知 skillId → UNKNOWN_SKILL，且不落盘', async (t) => {
  const root = await tmpRoot(t);
  await hasErrorCode(() => curate(curateArgs(root, { skillId: 'nope.nothing' })), 'UNKNOWN_SKILL');
  await hasErrorCode(() => curate(curateArgs(root, { skillId: '' })), 'UNKNOWN_SKILL');
  await assert.rejects(fs.access(path.join(root, '02_原始资料库')));
});

test('43. 技能目录没有 00 落位；capture 分别落 02 / 01；preflight kind=curate 跳过全库计数', async (t) => {
  assert.equal(SKILLS.filter((s) => s.outputDir === '00_系统与索引').length, 0);
  for (const s of SKILLS.filter((x) => x.stage === 'capture')) {
    assert.equal(s.outputDir, s.id === QUICK_SKILL ? '01_收件箱' : '02_原始资料库', `${s.id} 落位不符`);
  }
  assert.equal(byId.get(CURATE_SKILL).outputDir, '02_原始资料库');
  assert.equal(byId.get(QUICK_SKILL).outputDir, '01_收件箱');

  // 入柜不需要扫全库：6 个文件 + maxFiles=5，kind=curate 仍应通过
  const root = await tmpRoot(t);
  for (let i = 1; i <= 6; i += 1) await fs.writeFile(path.join(root, `f-${i}.txt`), 'x', 'utf8');
  const boot = await preflight({ root, limits: { maxFiles: 5 } });
  assert.equal(boot.code, 'TOO_MANY_FILES');
  const cur = await preflight({ root, kind: 'curate', limits: { maxFiles: 5 } });
  assert.equal(cur.ok, true, JSON.stringify(cur.checks));
  assert.equal(cur.code, 'OK');
  assert.equal(cur.counts.files, 0);
  assert.ok(cur.checks.find((c) => c.id === 'files').detail.includes('不扫描全库'));
});

test('44. 同 title+body 二次提交：生成新 id 并返回同标题 warning', async (t) => {
  const root = await tmpRoot(t);
  const first = await curate(curateArgs(root, { nextId: 'R-2026-201' }));
  const second = await curate(curateArgs(root, { nextId: 'R-2026-202' }));

  assert.notEqual(first.id, second.id);
  const dups = second.warnings.filter((w) => w.code === 'DUPLICATE_TITLE');
  assert.equal(dups.length, 1);
  assert.ok(dups[0].message.includes('库里已有同标题卡片'), dups[0].message);
  assert.ok(dups[0].message.includes(first.path), 'warning 应给出已存在的路径');
  await fs.access(first.path);
  await fs.access(second.path);
  assert.equal((await mdFilesUnder(path.join(root, '02_原始资料库'))).length, 2);
});

test('45. curate 落盘标题使用真实 id/title，不沿用模板占位编号', async (t) => {
  const root = await tmpRoot(t);
  const r = await curate(curateArgs(root, {
    nextId: 'R-2026-301',
    title: '客户访谈-续费动因',
  }));
  const text = await fs.readFile(r.path, 'utf8');
  const heading = text.split('\n').find((line) => line.startsWith('# '));
  assert.equal(heading, '# R-2026-301 · 客户访谈-续费动因');
  assert.ok(heading.includes('R-2026-301'));
  assert.ok(heading.includes('客户访谈-续费动因'));
  assert.ok(!text.includes('R-2026-001'), '不得出现模板里的占位编号');
  assert.ok(!text.includes('〈待填'), '标题不得残留模板占位');
  // frontmatter 与标题里的 id 必须一致
  assert.equal(parseFrontmatter(text).id, 'R-2026-301');
});

test('46. 模板缺一级标题时仍补出真实标题；标题占位被清掉', async (t) => {
  assert.equal(renderHeading('K-2026-001', '知识卡-测试'), '# K-2026-001 · 知识卡-测试');
  assert.equal(renderHeading('K-2026-001', '标题〈待填：主题〉'), '# K-2026-001 · 标题');

  const root = await tmpRoot(t);
  const r = await curate(curateArgs(root, {
    skillId: RESEARCH_SKILL,
    nextId: 'S-2026-999',
    title: '没有标题的模板',
    templateText: '这是一段没有任何一级标题的模板正文\n\n## 小节\n',
  }));
  const text = await fs.readFile(r.path, 'utf8');
  const heading = text.split('\n').find((line) => line.startsWith('# '));
  assert.equal(heading, '# S-2026-999 · 没有标题的模板');
  assert.ok(text.includes('受访者提到：续费主要看响应速度。'));
  assert.ok(!text.includes('R-2026-001'));
});

const FIXED_NOW = '2026-10-17T12:00:00';
const DAY = 24 * 60 * 60 * 1000;

function agoDate(days) {
  return new Date(new Date(FIXED_NOW).getTime() - days * DAY).toISOString().slice(0, 10);
}

async function writeNote(root, rel, text) {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
  return abs;
}

async function snapshotTree(root) {
  const out = new Map();
  async function walk(dir, base) {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(base, abs);
      if (ent.isDirectory()) await walk(abs, base);
      else {
        const st = await fs.stat(abs);
        out.set(rel, { size: st.size, mtimeMs: st.mtimeMs, text: ent.name.endsWith('.md') ? await fs.readFile(abs, 'utf8') : null });
      }
    }
  }
  await walk(root, root);
  return out;
}

test('47. maintain M01：收件箱文件超过 7 天命中，basis/threshold 齐全', async (t) => {
  const root = await tmpRoot(t);
  const f = await writeNote(root, '01_收件箱/随手记.md', '---\ntitle: 随手记\nconfidence: 中\n---\n\n内容\n');
  const old = new Date(new Date(FIXED_NOW).getTime() - 10 * DAY);
  await fs.utimes(f, old, old);

  const r = await maintain({ root, rules: ['M01'], now: FIXED_NOW });
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 1);
  const hit = r.findings[0];
  assert.equal(hit.ruleId, 'M01');
  assert.ok(hit.relPath.startsWith('01_收件箱/'));
  assert.equal(hit.path, f);
  assert.ok(hit.basis.includes('mtimeMs'), hit.basis);
  assert.ok(hit.threshold.includes('7'), hit.threshold);
  assert.equal(r.byRule.M01, 1);
  assert.deepEqual(r.scanned, { files: 1, notes: 1 });
});

test('48. maintain M03：低置信度 40 天未验证命中；有实验引用不命中', async (t) => {
  const root = await tmpRoot(t);
  await writeNote(root, '04_思考与假设/low.md',
    `---\nid: DOC-2026-001\ntitle: 低置信度旧卡\ncreated: ${agoDate(40)}\nconfidence: 低\nconf_why: 来源不明，待核实\n---\n\n一个还没验证的判断\n`);
  let r = await maintain({ root, rules: ['M03'], now: FIXED_NOW });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].ruleId, 'M03');
  assert.ok(r.findings[0].relPath.endsWith('low.md'));
  assert.ok(r.findings[0].basis.includes('confidence'));
  assert.ok(r.findings[0].threshold.includes('30'));

  await writeNote(root, '04_思考与假设/linked.md',
    `---\nid: DOC-2026-002\ntitle: 有实验引用\ncreated: ${agoDate(40)}\nconfidence: 低\nconf_why: 待验证\nref_experiment: E-2026-001\n---\n\n已被实验引用\n`);
  r = await maintain({ root, rules: ['M03'], now: FIXED_NOW });
  assert.equal(r.findings.length, 1, '有实验引用的低置信度卡不应命中');
  assert.ok(r.findings[0].relPath.endsWith('low.md'));
});

test('49. maintain M04：断链命中；补齐目标编号后不再命中', async (t) => {
  const root = await tmpRoot(t);
  await writeNote(root, '06_知识与模型/bad.md',
    '---\nid: K-2026-001\ntitle: 断链卡\nconfidence: 高\nref_experiment: E-2026-999\n---\n\n正文\n');

  let r = await maintain({ root, rules: ['M04'], now: FIXED_NOW });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].ruleId, 'M04');
  assert.ok(r.findings[0].detail.includes('E-2026-999'));
  assert.equal(r.findings[0].basis, 'ref_experiment');

  await writeNote(root, '05_验证与证据/exp.md',
    '---\nid: E-2026-999\ntitle: 实验记录\nconfidence: 高\n---\n\n实验正文\n');
  r = await maintain({ root, rules: ['M04'], now: FIXED_NOW });
  assert.equal(r.findings.length, 0, '目标编号存在后不应再报断链');
});

test('50. maintain M08：缺 confidence 与低置信度缺理由都命中', async (t) => {
  const root = await tmpRoot(t);
  await writeNote(root, '06_知识与模型/missing.md', '---\ntitle: 没有置信度\n---\n\n正文\n');
  await writeNote(root, '06_知识与模型/low-nowhy.md', '---\ntitle: 低档无理由\nconfidence: 低\nconf_why: ""\n---\n\n正文\n');

  const r = await maintain({ root, rules: ['M08'], now: FIXED_NOW });
  assert.equal(r.findings.length, 2);
  const details = r.findings.map((x) => x.detail).join(' | ');
  assert.ok(details.includes('缺 confidence'), details);
  assert.ok(details.includes('conf_why 为空'), details);
  assert.ok(r.findings.every((x) => x.basis.includes('confidence')));
});

test('51. maintain：健康笔记不产生任何 finding', async (t) => {
  const root = await tmpRoot(t);
  await writeNote(root, '06_知识与模型/healthy.md',
    `---\nid: K-2026-010\ntitle: 健康卡\ncreated: ${agoDate(1)}\nconfidence: 高\nconf_src: [R-2026-001]\nconf_why: ""\nstatus: active\n---\n\n结论\n`);
  const r = await maintain({ root, now: FIXED_NOW });
  assert.equal(r.findings.length, 0, JSON.stringify(r.findings));
  assert.deepEqual(r.byRule, { M01: 0, M03: 0, M04: 0, M06: 0, M07: 0, M08: 0 });
});

test('52. maintain：每条 finding 都带 basis + threshold + 可定位路径', async (t) => {
  const root = await tmpRoot(t);
  const inbox = await writeNote(root, '01_收件箱/old.md', '---\ntitle: 旧件\nconfidence: 中\n---\n\n内容\n');
  const old = new Date(new Date(FIXED_NOW).getTime() - 20 * DAY);
  await fs.utimes(inbox, old, old);
  await writeNote(root, '04_思考与假设/low.md',
    `---\nid: DOC-2026-003\ntitle: 低档旧卡\ncreated: ${agoDate(40)}\nconfidence: 低\nconf_why: 待核实\n---\n\n正文\n`);
  await writeNote(root, '06_知识与模型/broken.md',
    '---\nid: K-2026-002\ntitle: 断链\nconfidence: 高\nref_hypothesis: H-2026-404\n---\n\n正文\n');
  await writeNote(root, '06_知识与模型/no-conf.md', '---\ntitle: 无置信度\n---\n\n正文\n');

  const r = await maintain({ root, now: FIXED_NOW });
  assert.ok(r.findings.length >= 4, `findings=${r.findings.length}`);
  for (const f of r.findings) {
    assert.ok(typeof f.basis === 'string' && f.basis.trim().length > 0, `${f.ruleId} 缺 basis`);
    assert.ok(typeof f.threshold === 'string' && f.threshold.trim().length > 0, `${f.ruleId} 缺 threshold`);
    assert.ok(path.isAbsolute(f.path));
    assert.ok(f.relPath && !path.isAbsolute(f.relPath));
    assert.ok(f.title.length > 0);
    assert.equal(f.level, 'warn');
  }
});

test('53. maintain 只读：扫描前后文件数、mtime、内容完全不变', async (t) => {
  const root = await tmpRoot(t);
  const inbox = await writeNote(root, '01_收件箱/旧.md', '---\ntitle: 旧\n---\n\n内容\n');
  const old = new Date(new Date(FIXED_NOW).getTime() - 30 * DAY);
  await fs.utimes(inbox, old, old);
  await writeNote(root, '04_思考与假设/low.md',
    `---\nid: DOC-2026-004\ntitle: 低\ncreated: ${agoDate(60)}\nconfidence: 低\nconf_why: 待核实\n---\n\n正文\n`);

  const before = await snapshotTree(root);
  const r = await maintain({ root, now: FIXED_NOW });
  assert.ok(r.findings.length >= 2);
  const after = await snapshotTree(root);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [rel, snap] of before) {
    assert.deepEqual(after.get(rel), snap, `${rel} 被改动`);
  }
});

test('54. maintain onStep key 序列 + byRule 全键 + 不支持的规则只告警', async (t) => {
  const root = await tmpRoot(t);
  const steps = [];
  const r = await maintain({ root, now: FIXED_NOW, onStep: (e) => steps.push(e) });
  const keys = [...new Set(steps.filter((e) => e.key).map((e) => e.key))];
  assert.deepEqual(keys, ['validate', 'scan', 'rules', 'report']);
  assert.deepEqual(r.byRule, { M01: 0, M03: 0, M04: 0, M06: 0, M07: 0, M08: 0 });
  assert.equal(r.ok, true);
  assert.ok(Number.isFinite(r.elapsedMs));
  assert.ok(!Number.isNaN(Date.parse(r.generatedAt)));

  const r2 = await maintain({ root, rules: ['M05'], now: FIXED_NOW });
  assert.equal(r2.ok, true);
  assert.equal(r2.findings.length, 0);
  assert.ok(r2.warnings.some((w) => w.includes('M05')));
});

const SOURCE_CARD_SECTIONS = ['采集信息', '原始内容摘要', '原文 / 附件', '已知局限', '下游链接'];

test('55. 契约 A：模板各节都填好时没有 SECTION_MISSING warning', async (t) => {
  const root = await tmpRoot(t);
  const body = [
    '## 采集信息', '', '来源：现场访谈第 7 场', '',
    '## 原始内容摘要', '', '续费主要看响应速度，价格不是第一因素。', '',
    '## 原文 / 附件', '', '录音：/tmp/interview-7.m4a', '',
    '## 已知局限', '', '样本仅 1 人，不能代表全体客户。', '',
    '## 下游链接', '', 'S-2026-001',
  ].join('\n');
  const r = await curate(curateArgs(root, { body }));
  assert.deepEqual(r.warnings, []);
  const text = await fs.readFile(r.path, 'utf8');
  for (const heading of SOURCE_CARD_SECTIONS) assert.ok(text.includes(`## ${heading}`), heading);
  assert.ok(text.includes('样本仅 1 人，不能代表全体客户。'));
  assert.ok(!text.includes('本节未填写'));
});

test('56. 契约 A：缺一节 → warning + 该节只写「本节未填写」', async (t) => {
  const root = await tmpRoot(t);
  const body = ['## 采集信息', '', '来源：现场访谈', '', '## 原始内容摘要', '', '一句摘要'].join('\n');
  const r = await curate(curateArgs(root, { body }));

  const missing = r.warnings.filter((w) => w.code === 'SECTION_MISSING');
  assert.deepEqual(missing.map((w) => w.section).sort(), ['下游链接', '已知局限', '原文 / 附件'].sort());
  const text = await fs.readFile(r.path, 'utf8');
  assert.ok(text.includes('## 原文 / 附件\n\n> ⚠ 本节未填写'));
  assert.ok(text.includes('## 已知局限\n\n> ⚠ 本节未填写'));
  assert.ok(text.includes('来源：现场访谈'));
  assert.ok(!text.includes('## 采集信息\n\n> ⚠ 本节未填写'));
});

test('57. 契约 A：agent 多出来的节追加到「## 补充」', async (t) => {
  const root = await tmpRoot(t);
  const body = ['## 采集信息', '', '来源：访谈', '', '## 额外发现', '', '客户主动提到竞品续费更便宜'].join('\n');
  const r = await curate(curateArgs(root, { body }));
  assert.ok(!r.warnings.some((w) => w.section === '额外发现'), '多出的节不应算缺节');
  const text = await fs.readFile(r.path, 'utf8');
  assert.ok(text.includes('## 补充'));
  assert.ok(text.includes('### 额外发现'));
  assert.ok(text.includes('客户主动提到竞品续费更便宜'));
  // 补充段在末尾
  assert.ok(text.indexOf('## 补充') > text.indexOf('## 下游链接'));
});

test('58. 契约 A：body 无二级标题 → 整段进第一节，其余全标缺', async (t) => {
  const root = await tmpRoot(t);
  const r = await curate(curateArgs(root, { body: '受访者说：续费主要看响应速度。' }));
  const missing = r.warnings.filter((w) => w.code === 'SECTION_MISSING');
  assert.equal(missing.length, SOURCE_CARD_SECTIONS.length - 1);
  const text = await fs.readFile(r.path, 'utf8');
  assert.ok(text.includes('## 采集信息\n\n受访者说：续费主要看响应速度。'));
  assert.equal((text.match(/> ⚠ 本节未填写/g) || []).length, SOURCE_CARD_SECTIONS.length - 1);
});

test('59. 契约 B：renderSkillPage 的 relPath 与 frontmatter 正确', () => {
  const page = renderSkillPage({
    skill: { id: 'SK001', name: '资料卡', purpose: '把资料收进来', scenario: '看到好文章时', keywords: ['资料', '卡片'], fields: ['来源', '密级'], version: '1.0.0' },
    now: '2026-10-17T12:00:00',
  });
  assert.equal(page.relPath, path.join('11_岗位技能库', '通用', 'SK001-资料卡.md'));
  const fm = parseFrontmatter(page.content);
  for (const key of ['id', 'name', 'version', 'status', 'keywords', 'fields', 'created', 'updated']) {
    assert.ok(fm[key] !== undefined && fm[key] !== '', `缺 ${key}`);
  }
  assert.equal(fm.id, 'SK001');
  assert.equal(fm.version, '1.0.0');
  assert.equal(fm.status, 'active');
  assert.equal(fm.created, '2026-10-17');
  assert.ok(page.content.includes('## 用途'));
  assert.ok(page.content.includes('## 调用方式'));

  const withProf = renderSkillPage({
    skill: { id: 'SK002', name: '视觉参考', profession: '设计与创意', keywords: [], fields: [], version: '2.0.0' },
  });
  assert.equal(withProf.relPath, path.join('11_岗位技能库', '设计与创意', 'SK002-视觉参考.md'));
});

test('60. 契约 B：archiveSkillPage 四要素齐全且落在历史版本目录', async (t) => {
  const root = await tmpRoot(t);
  const skill = { id: 'SK003', name: '复盘模板', purpose: '复盘', scenario: '阶段结束', keywords: ['复盘'], fields: ['预期'], version: '1.0.0' };
  const r = await archiveSkillPage({
    root,
    skill,
    reason: '升级到 1.1.0（新增证据字段）',
    nextVersionLink: '[[11_岗位技能库/通用/SK003-复盘模板]]',
    now: '2026-10-17T12:00:00',
  });
  assert.equal(r.relPath, path.join('12_归档与历史', '03_历史版本', 'SK003-1.0.0-复盘模板.md'));
  assert.equal(r.archivedPath, path.join(root, r.relPath));
  for (const key of ['原始位置：', '归档时间：', '归档原因：', '继任版本链接：']) {
    assert.ok(r.content.includes(key), `缺 ${key}`);
  }
  assert.ok(r.content.includes('升级到 1.1.0（新增证据字段）'));
  assert.ok(r.content.includes('11_岗位技能库'));
  assert.equal(parseFrontmatter(r.content).status, 'archived');
  const onDisk = await fs.readFile(r.archivedPath, 'utf8');
  assert.equal(onDisk, r.content);
});

test('61. 契约 B：SKILL 页标题用真实 id/name，不含模板占位', () => {
  const page = renderSkillPage({ skill: { id: 'SK004', name: '客户访谈', purpose: '收访谈', keywords: [], fields: [], version: '1.2.3' }, now: '2026-10-17' });
  const heading = page.content.split('\n').find((line) => line.startsWith('# '));
  assert.equal(heading, '# SK004 · 客户访谈');
  assert.ok(!page.content.includes('R-2026-001'));
  assert.ok(!page.content.includes('〈待填'));
  assert.equal(parseFrontmatter(page.content).version, '1.2.3');
});

test('62. 契约 B：非 root / 保留区路径被守卫拒绝', async (t) => {
  const root = await tmpRoot(t);
  const skill = { id: 'SK005', name: '越界测试', keywords: [], fields: [], version: '1.0.0' };
  await hasErrorCode(
    () => archiveSkillPage({ root: '/System', skill, reason: 'x', nextVersionLink: 'y' }),
    'PATH_DENIED',
  );
  await hasErrorCode(
    () => archiveSkillPage({ root: path.join('relative', 'root'), skill, reason: 'x' }),
    'INVALID_ROOT',
  );
  await hasErrorCode(() => assertWritable(root, path.join(root, '..', 'evil.md')), 'PATH_ESCAPE');
  await hasErrorCode(() => assertWritableSync(root, path.join(root, '..', 'evil.md')), 'PATH_ESCAPE');
});

const ARCHIVE_NOTE_PREFIX = path.join('12_归档与历史', '03_归档笔记');

test('63. maintain M06：项目首页 status=done 且 31 天前 → 只读归档提议', async (t) => {
  const root = await tmpRoot(t);
  await writeNote(root, '09_项目与运营/项目A/首页.md',
    `---\nid: P001\ntitle: 项目A首页\nstatus: done\nupdated: ${agoDate(31)}\nconfidence: 高\n---\n\n项目已结束\n`);
  const r = await maintain({ root, rules: ['M06'], now: FIXED_NOW });
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.ruleId, 'M06');
  assert.equal(f.level, 'info');
  assert.equal(f.action, 'propose-archive');
  assert.equal(f.relPath, '09_项目与运营/项目A');
  assert.equal(f.proposedTarget, path.join(ARCHIVE_NOTE_PREFIX, '09_项目与运营', '项目A'));
  assert.ok(f.archiveReason.includes('归档'));
  assert.ok(f.basis.includes('status'));
  assert.ok(f.threshold.includes('30'));
  assert.equal(r.byRule.M06, 1);
});

test('64. maintain M06：status=done 但仅 3 天前 → 不提议', async (t) => {
  const root = await tmpRoot(t);
  await writeNote(root, '09_项目与运营/项目B/首页.md',
    `---\nid: P002\ntitle: 项目B首页\nstatus: done\nupdated: ${agoDate(3)}\nconfidence: 高\n---\n\n刚结束\n`);
  const r = await maintain({ root, rules: ['M06'], now: FIXED_NOW });
  assert.equal(r.findings.length, 0);
  assert.equal(r.byRule.M06, 0);
});

test('65. maintain M07：deprecated 31 天前 → 只读归档提议', async (t) => {
  const root = await tmpRoot(t);
  await writeNote(root, '06_知识与模型/old.md',
    `---\nid: K-2026-001\ntitle: 已废弃知识\nstatus: deprecated\nupdated: ${agoDate(31)}\nconfidence: 高\n---\n\n旧结论\n`);
  const r = await maintain({ root, rules: ['M07'], now: FIXED_NOW });
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.ruleId, 'M07');
  assert.equal(f.level, 'info');
  assert.equal(f.action, 'propose-archive');
  assert.equal(f.proposedTarget, path.join(ARCHIVE_NOTE_PREFIX, '06_知识与模型', 'old.md'));
  assert.ok(f.archiveReason.includes('废弃'));
  assert.equal(r.byRule.M07, 1);
});

test('66. maintain M07：deprecated 但仅 3 天前 → 不提议', async (t) => {
  const root = await tmpRoot(t);
  await writeNote(root, '06_知识与模型/recent.md',
    `---\nid: K-2026-002\ntitle: 刚废弃\nstatus: deprecated\nupdated: ${agoDate(3)}\nconfidence: 高\n---\n\n刚废弃\n`);
  const r = await maintain({ root, rules: ['M07'], now: FIXED_NOW });
  assert.equal(r.findings.length, 0);
});

test('67. M06/M07 的 proposedTarget 形态：前缀 + 原相对路径', async (t) => {
  const root = await tmpRoot(t);
  await writeNote(root, '09_项目与运营/项目C/首页.md',
    `---\ntitle: 项目C首页\nstatus: ended\nupdated: ${agoDate(40)}\nconfidence: 高\n---\n\n结束\n`);
  await writeNote(root, '06_知识与模型/legacy.md',
    `---\ntitle: 遗留\nstatus: deprecated\nupdated: ${agoDate(40)}\nconfidence: 高\n---\n\n遗留\n`);
  const r = await maintain({ root, now: FIXED_NOW });
  const proposed = r.findings.filter((f) => f.action === 'propose-archive');
  assert.equal(proposed.length, 2);
  for (const f of proposed) {
    assert.ok(f.proposedTarget.startsWith(ARCHIVE_NOTE_PREFIX), f.proposedTarget);
    assert.equal(f.proposedTarget, path.join(ARCHIVE_NOTE_PREFIX, ...f.relPath.split('/')));
    assert.ok(f.archiveReason.length > 0);
  }
  assert.deepEqual(proposed.map((f) => f.ruleId).sort(), ['M06', 'M07']);
});

test('68. M06/M07 扫描前后文件数、mtime 与内容完全不变', async (t) => {
  const root = await tmpRoot(t);
  await writeNote(root, '09_项目与运营/项目D/首页.md',
    `---\ntitle: 项目D首页\nstatus: closed\nupdated: ${agoDate(50)}\nconfidence: 高\n---\n\n关闭\n`);
  await writeNote(root, '06_知识与模型/legacy2.md',
    `---\ntitle: 遗留2\nstatus: deprecated\nupdated: ${agoDate(50)}\nconfidence: 高\n---\n\n遗留\n`);

  const before = await snapshotTree(root);
  const r = await maintain({ root, now: FIXED_NOW });
  assert.ok(r.byRule.M06 >= 1 && r.byRule.M07 >= 1);
  const after = await snapshotTree(root);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [rel, snap] of before) assert.deepEqual(after.get(rel), snap, `${rel} 被改动`);
  // 不得凭空创建归档目录
  await assert.rejects(fs.access(path.join(root, ARCHIVE_NOTE_PREFIX)));
});

test('69. archiveItems 正常归档：目标存在、四要素齐、原件已删、frontmatter 追加四字段', async (t) => {
  const root = await tmpRoot(t);
  const rel = '06_知识与模型/a.md';
  const srcAbs = await writeNote(root, rel, '---\nid: K-2026-001\ntitle: 旧结论\nconfidence: 高\n---\n\n正文内容\n');

  const r = await archiveItems({
    root,
    items: [{ relPath: rel, reason: '升级后归档', successorLink: '[[06_知识与模型/a-v2]]' }],
    now: '2026-10-17T12:00:00',
  });
  assert.equal(r.ok, true);
  assert.equal(r.moved.length, 1);
  assert.deepEqual(r.failed, []);
  assert.equal(r.archiveDir, path.join(root, '12_归档与历史', '03_归档笔记'));

  const target = path.join(root, '12_归档与历史', '03_归档笔记', rel);
  assert.equal(r.moved[0].from, srcAbs);
  assert.equal(r.moved[0].to, target);
  await fs.access(target);
  await assert.rejects(fs.access(srcAbs), '原件应已删除');

  const text = await fs.readFile(target, 'utf8');
  assert.ok(text.includes(`> 原始位置：${rel}`));
  assert.match(text, /> 归档时间：\d{4}-\d{2}-\d{2}T/);
  assert.ok(text.includes('> 归档原因：升级后归档'));
  assert.ok(text.includes('> 继任版本链接：[[06_知识与模型/a-v2]]'));
  assert.ok(text.includes('正文内容'));

  const fm = parseFrontmatter(text);
  assert.equal(fm.archived_from, rel);
  assert.equal(fm.archived_reason, '升级后归档');
  assert.equal(fm.successor, '[[06_知识与模型/a-v2]]');
  assert.match(fm.archived_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(fm.title, '旧结论', '原 frontmatter 必须保留');
});

test('70. archiveItems：reason 缺失/过短 → REASON_REQUIRED 且原件保留', async (t) => {
  const root = await tmpRoot(t);
  const rel = '06_知识与模型/b.md';
  const srcAbs = await writeNote(root, rel, '---\ntitle: b\n---\n\n正文\n');

  for (const reason of ['', '短', undefined]) {
    const r = await archiveItems({ root, items: [{ relPath: rel, reason }], now: '2026-10-17T12:00:00' });
    assert.equal(r.moved.length, 0);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].code, 'REASON_REQUIRED');
    await fs.access(srcAbs);
  }
  await assert.rejects(fs.access(path.join(root, '12_归档与历史', '03_归档笔记', rel)));
});

test('71. archiveItems：目标已存在 → TARGET_EXISTS，原件在、目标内容不变', async (t) => {
  const root = await tmpRoot(t);
  const rel = '06_知识与模型/c.md';
  const srcAbs = await writeNote(root, rel, '---\ntitle: c\n---\n\n新正文\n');
  const target = path.join(root, '12_归档与历史', '03_归档笔记', rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, 'OLD ARCHIVE\n', 'utf8');

  const r = await archiveItems({ root, items: [{ relPath: rel, reason: '归档一次' }], now: '2026-10-17T12:00:00' });
  assert.equal(r.moved.length, 0);
  assert.equal(r.failed[0].code, 'TARGET_EXISTS');
  await fs.access(srcAbs);
  assert.equal(await fs.readFile(target, 'utf8'), 'OLD ARCHIVE\n');
});

test('72. archiveItems：目录 relPath 现在按目录归档（moved.kind=dir）', async (t) => {
  const root = await tmpRoot(t);
  await writeNote(root, '06_知识与模型/一个目录/index.md', '# 目录首页\n');
  const r = await archiveItems({ root, items: [{ relPath: '06_知识与模型/一个目录', reason: '想归档目录' }] });
  assert.equal(r.moved.length, 1);
  assert.equal(r.moved[0].kind, 'dir');
  assert.deepEqual(r.failed, []);
  await assert.rejects(fs.access(path.join(root, '06_知识与模型', '一个目录')));
  await fs.access(path.join(root, '12_归档与历史', '03_归档笔记', '06_知识与模型', '一个目录', 'index.md'));
});

test('73. archiveItems：12_归档与历史 / .jkkb 下的路径被拒绝', async (t) => {
  const root = await tmpRoot(t);
  const inArchive = '12_归档与历史/03_归档笔记/already.md';
  await writeNote(root, inArchive, '---\ntitle: 已在归档\n---\n\n正文\n');
  await writeNote(root, '.jkkb/runs/r.jsonl', 'x\n');

  const r = await archiveItems({
    root,
    items: [
      { relPath: inArchive, reason: '再归档一次' },
      { relPath: '.jkkb/runs/r.jsonl', reason: '归档运行日志' },
    ],
  });
  assert.equal(r.moved.length, 0);
  assert.deepEqual(r.failed.map((f) => f.code), ['FORBIDDEN_PATH', 'FORBIDDEN_PATH']);
  await fs.access(path.join(root, inArchive));
  await fs.access(path.join(root, '.jkkb', 'runs', 'r.jsonl'));
});

test('74. archiveItems：relPath 含 .. → 不写出 root', async (t) => {
  const parent = await tmpRoot(t);
  const root = path.join(parent, 'vault');
  await fs.mkdir(root);
  const outside = path.join(parent, 'outside.md');
  await fs.writeFile(outside, 'OUTSIDE\n', 'utf8');

  const r = await archiveItems({ root, items: [{ relPath: '../outside.md', reason: '试图越界归档' }] });
  assert.equal(r.moved.length, 0);
  assert.equal(r.failed[0].code, 'PATH_ESCAPE');
  assert.equal(await fs.readFile(outside, 'utf8'), 'OUTSIDE\n');
  await assert.rejects(fs.access(path.join(parent, '12_归档与历史')));
});

test('75. archiveItems：onStep 序列正确，单项失败不影响其它项', async (t) => {
  const root = await tmpRoot(t);
  const rel = '06_知识与模型/ok.md';
  await writeNote(root, rel, '---\ntitle: ok\n---\n\n正文\n');
  const steps = [];
  const r = await archiveItems({
    root,
    items: [
      { relPath: rel, reason: '正常归档' },
      { relPath: '06_知识与模型/missing.md', reason: '不存在也照常继续' },
    ],
    now: '2026-10-17T12:00:00',
    onStep: (e) => steps.push(e),
  });

  const keys = [...new Set(steps.filter((e) => e.key).map((e) => e.key))];
  assert.deepEqual(keys, ['validate', 'plan', 'write', 'unlink', 'report']);
  assert.equal(r.moved.length, 1);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].code, 'NOT_FOUND');
  await assert.rejects(fs.access(path.join(root, rel)));
  await fs.access(path.join(root, '12_归档与历史', '03_归档笔记', rel));
});

test('76. .jkkb/store/experts 已放行（与其它命名空间同一白名单）', async (t) => {
  const root = await tmpRoot(t);
  const target = path.join(root, '.jkkb', 'store', 'experts', 'EXP-001.json');
  assert.doesNotThrow(() => assertWritableSync(root, target));
  await assertWritable(root, target);
  assert.equal(await writeAtomic(target, '{"id":"EXP-001"}\n', { root }), 'created');
  assert.equal(await fs.readFile(target, 'utf8'), '{"id":"EXP-001"}\n');
  // 其余命名空间不受本次改动影响
  assert.doesNotThrow(() => assertWritableSync(root, path.join(root, '.jkkb', 'store', 'skills', 'SK001.json')));
});

test('77. .jkkb/store/expertsx 等近似名仍 PATH_DENIED', async (t) => {
  const root = await tmpRoot(t);
  for (const bad of ['expertsx', 'expert', 'experts_old']) {
    const target = path.join(root, '.jkkb', 'store', bad, 'EXP-001.json');
    await hasErrorCode(() => assertWritable(root, target), 'PATH_DENIED');
    await hasErrorCode(() => assertWritableSync(root, target), 'PATH_DENIED');
  }
  await assert.rejects(fs.access(path.join(root, '.jkkb', 'store', 'expertsx')));
});

async function setMtime(file, ms) {
  const d = new Date(ms);
  await fs.utimes(file, d, d);
}

test('78. 目录归档：源目录消失、目标存在且文件数一致、首页有四要素', async (t) => {
  const root = await tmpRoot(t);
  const rel = '06_知识与模型/项目X';
  await writeNote(root, `${rel}/00_项目首页.md`, '---\ntitle: 项目X\nstatus: done\n---\n\n项目首页正文\n');
  await writeNote(root, `${rel}/笔记.md`, '# 笔记\n');
  await writeNote(root, `${rel}/sub/inner.md`, '# 内部\n');

  const r = await archiveItems({ root, items: [{ relPath: rel, reason: '项目结束归档', successorLink: '[[06_知识与模型/项目X-v2]]' }], now: '2026-10-17T12:00:00' });
  assert.equal(r.moved.length, 1);
  assert.equal(r.moved[0].kind, 'dir');
  assert.deepEqual(r.failed, []);
  await assert.rejects(fs.access(path.join(root, rel)), '源目录应已消失');

  const target = path.join(root, '12_归档与历史', '03_归档笔记', rel);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const countTree = async (dir) => {
    let n = 0;
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) n += await countTree(path.join(dir, e.name));
      else if (e.isFile()) n += 1;
    }
    return n;
  };
  assert.equal(await countTree(target), 3);
  assert.ok(entries.some((e) => e.name === '00_项目首页.md'));

  const home = await fs.readFile(path.join(target, '00_项目首页.md'), 'utf8');
  for (const key of ['> 原始位置：', '> 归档时间：', '> 归档原因：', '> 继任版本链接：']) {
    assert.ok(home.includes(key), `首页缺 ${key}`);
  }
  assert.ok(home.includes(`> 原始位置：${rel}`));
  const fm = parseFrontmatter(home);
  assert.equal(fm.archived_from, rel);
  assert.equal(fm.archived_reason, '项目结束归档');
});

test('79. 目录归档：目标已存在 → TARGET_EXISTS 且源目录保留', async (t) => {
  const root = await tmpRoot(t);
  const rel = '06_知识与模型/项目Y';
  await writeNote(root, `${rel}/index.md`, '# Y\n');
  const target = path.join(root, '12_归档与历史', '03_归档笔记', rel);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'OLD.md'), 'OLD\n', 'utf8');

  const r = await archiveItems({ root, items: [{ relPath: rel, reason: '归档冲突测试' }] });
  assert.equal(r.moved.length, 0);
  assert.equal(r.failed[0].code, 'TARGET_EXISTS');
  await fs.access(path.join(root, rel, 'index.md'));
  assert.equal(await fs.readFile(path.join(target, 'OLD.md'), 'utf8'), 'OLD\n');
});

test('80. 目录归档：源在 12_归档与历史 下 → 拒绝', async (t) => {
  const root = await tmpRoot(t);
  const rel = '12_归档与历史/03_归档笔记/旧目录';
  await writeNote(root, `${rel}/a.md`, '# a\n');
  const r = await archiveItems({ root, items: [{ relPath: rel, reason: '重复归档' }] });
  assert.equal(r.failed[0].code, 'FORBIDDEN_PATH');
  await fs.access(path.join(root, rel, 'a.md'));
});

test('81. 目录归档：relPath 为 . 或 .. → 拒绝', async (t) => {
  const root = await tmpRoot(t);
  const r = await archiveItems({
    root,
    items: [
      { relPath: '.', reason: '归档根目录' },
      { relPath: '..', reason: '归档上级目录' },
    ],
  });
  assert.equal(r.moved.length, 0);
  assert.deepEqual(r.failed.map((f) => f.code), ['INVALID_PATH', 'PATH_ESCAPE']);
  await fs.access(root);
});

test('82. 目录归档：目录里没有 md → 生成 _归档说明.md 且四要素齐', async (t) => {
  const root = await tmpRoot(t);
  const rel = '07_素材与组件/无笔记素材';
  await fs.mkdir(path.join(root, rel), { recursive: true });
  await fs.writeFile(path.join(root, rel, 'data.txt'), 'x', 'utf8');

  const r = await archiveItems({ root, items: [{ relPath: rel, reason: '素材已用完归档' }], now: '2026-10-17T12:00:00' });
  assert.equal(r.moved.length, 1);
  const target = path.join(root, '12_归档与历史', '03_归档笔记', rel);
  const text = await fs.readFile(path.join(target, '_归档说明.md'), 'utf8');
  for (const key of ['> 原始位置：', '> 归档时间：', '> 归档原因：', '> 继任版本链接：']) {
    assert.ok(text.includes(key), `缺 ${key}`);
  }
  assert.ok(text.includes('# 归档说明'));
  await fs.access(path.join(target, 'data.txt'));
});

test('83. 目录归档：rename EXDEV → 复制+校验路径成功且源被删', async (t) => {
  const root = await tmpRoot(t);
  const rel = '09_项目与运营/跨盘项目';
  await writeNote(root, `${rel}/index.md`, '# 跨盘\n');
  await writeNote(root, `${rel}/deep/a.md`, '# a\n');

  const exdev = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
  const r = await archiveItems({
    root,
    items: [{ relPath: rel, reason: '跨盘归档测试' }],
    now: '2026-10-17T12:00:00',
    deps: { rename: async () => { throw exdev; } },
  });
  assert.equal(r.moved.length, 1);
  assert.equal(r.moved[0].kind, 'dir');
  assert.equal(r.moved[0].method, 'copy');
  await assert.rejects(fs.access(path.join(root, rel)));
  const target = path.join(root, '12_归档与历史', '03_归档笔记', rel);
  await fs.access(path.join(target, 'index.md'));
  await fs.access(path.join(target, 'deep', 'a.md'));
});

test('84. 目录归档：复制校验失败 → 目标被清理、源保留、COPY_VERIFY_FAILED', async (t) => {
  const root = await tmpRoot(t);
  const rel = '09_项目与运营/校验失败项目';
  await writeNote(root, `${rel}/index.md`, '# x\n');
  const exdev = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });

  const r = await archiveItems({
    root,
    items: [{ relPath: rel, reason: '复制校验失败测试' }],
    deps: {
      rename: async () => { throw exdev; },
      verify: () => false,
    },
  });
  assert.equal(r.moved.length, 0);
  assert.equal(r.failed[0].code, 'COPY_VERIFY_FAILED');
  await fs.access(path.join(root, rel, 'index.md'));
  await assert.rejects(fs.access(path.join(root, '12_归档与历史', '03_归档笔记', rel)));
});

test('85. 目录归档：rename 非 EXDEV 失败 → MOVE_FAILED 且源保留、目标不存在', async (t) => {
  const root = await tmpRoot(t);
  const rel = '09_项目与运营/移动失败项目';
  await writeNote(root, `${rel}/index.md`, '# y\n');
  const r = await archiveItems({
    root,
    items: [{ relPath: rel, reason: '移动失败测试' }],
    deps: { rename: async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); } },
  });
  assert.equal(r.moved.length, 0);
  assert.equal(r.failed[0].code, 'MOVE_FAILED');
  await fs.access(path.join(root, rel, 'index.md'));
  await assert.rejects(fs.access(path.join(root, '12_归档与历史', '03_归档笔记', rel)));
});

test('86. listRecentNotes：按 mtime 倒序、跳过 00_系统与 .jkkb、title 优先 frontmatter', async (t) => {
  const root = await tmpRoot(t);
  const nowMs = Date.parse('2026-10-17T12:00:00');
  const a = await writeNote(root, '03_研究与洞察/a.md', '---\ntitle: 甲研究\n---\n\n正文\n');
  const b = await writeNote(root, '06_知识与模型/b.md', '没有 frontmatter 的正文\n');
  const sys = await writeNote(root, '00_系统与索引/00_知识库首页.md', '---\ntitle: 系统首页\n---\n\n正文\n');
  await fs.mkdir(path.join(root, '.jkkb', 'runs'), { recursive: true });
  const hidden = path.join(root, '.jkkb', 'runs', 'x.md');
  await fs.writeFile(hidden, '---\ntitle: 隐藏\n---\n', 'utf8');

  await setMtime(a, nowMs - 3 * 3600 * 1000);
  await setMtime(b, nowMs - 1 * 3600 * 1000);
  await setMtime(sys, nowMs);
  await setMtime(hidden, nowMs + 1000);

  const list = await listRecentNotes({ root, limit: 10 });
  assert.deepEqual(list.map((x) => x.relPath), ['06_知识与模型/b.md', '03_研究与洞察/a.md']);
  assert.equal(list[0].title, 'b');
  assert.equal(list[1].title, '甲研究');
  for (const item of list) {
    assert.ok(Number.isFinite(item.size));
    assert.ok(!Number.isNaN(Date.parse(item.updatedAt)));
  }
  assert.ok(!list.some((x) => x.relPath.startsWith('00_系统与索引')));
  assert.ok(!list.some((x) => x.relPath.startsWith('.jkkb')));
});

test('87. listRecentNotes：limit 生效，只返回最新的 N 篇', async (t) => {
  const root = await tmpRoot(t);
  const base = Date.parse('2026-10-17T12:00:00');
  for (let i = 1; i <= 5; i += 1) {
    const file = await writeNote(root, `03_研究与洞察/n${i}.md`, `# ${i}\n`);
    await setMtime(file, base - i * 60000);
  }
  const list = await listRecentNotes({ root, limit: 2 });
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((x) => x.relPath), ['03_研究与洞察/n1.md', '03_研究与洞察/n2.md']);
});
