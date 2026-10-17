/**
 * 归档执行（破坏性操作，逐项闸门 + 先写后删）。
 *
 * 支持文件与目录：
 * - 文件：写归档页 → 回读确认 → 才 unlink 原件；
 * - 目录：fs.rename 原子移动；跨盘 EXDEV → 复制整棵树 → 校验（文件数+总字节）→ 才删源；
 *   移动完成后在归档目录里补四要素（找首页，找不到就新建 _归档说明.md），补写失败只记 warning。
 *
 * 逐项闸门（任一不过只跳过该项，不整体失败）：
 * - relPath 归一后必须在 root 内、不在 .jkkb、不在 12_归档与历史；
 * - relPath 不能为空 / '.' / '..'；源必须存在且是文件或目录；
 * - reason 必填且 ≥4 字符；目标已存在不覆盖（TARGET_EXISTS）。
 *
 * onStep key 序列：validate → plan → write → unlink → report。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EngineError } from './errors.js';
import { assertWritable } from './guard.js';
import { assertPathLength, ensureDir, isRelPathInside, nowIso, safeJoin, writeAtomic } from './paths.js';
import { parseFrontmatter, scanVault, stripBom } from './scan.js';

export const ARCHIVE_VERSION = 1;
export const ARCHIVE_ROOT = path.join('12_归档与历史', '03_归档笔记');
const SKIP_RECENT_DIRS = ['00_系统与索引'];

const CODES = Object.freeze({
  REASON_REQUIRED: 'REASON_REQUIRED',
  INVALID_PATH: 'INVALID_PATH',
  TARGET_EXISTS: 'TARGET_EXISTS',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN_PATH: 'FORBIDDEN_PATH',
  PATH_ESCAPE: 'PATH_ESCAPE',
  WRITE_FAILED: 'WRITE_FAILED',
  MOVE_FAILED: 'MOVE_FAILED',
  COPY_VERIFY_FAILED: 'COPY_VERIFY_FAILED',
  UNLINK_FAILED: 'UNLINK_FAILED',
});

function yamlString(value) {
  return `"${String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}

function asNow(input) {
  if (input instanceof Date && !Number.isNaN(input.getTime())) return input;
  if (typeof input === 'string' && input.trim()) {
    const d = new Date(input);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** 拆出 frontmatter 文本与正文（容忍 BOM / CRLF）。 */
function splitDocument(text) {
  const src = stripBom(String(text == null ? '' : text));
  if (!src.startsWith('---')) return { fmText: null, body: src };
  const end = src.indexOf('\n---', 3);
  if (end < 0) return { fmText: null, body: src };
  const fmText = src.slice(3, end).replace(/^\r?\n/, '').replace(/\s+$/, '');
  const body = src.slice(end + 4).replace(/^(\r?\n)+/, '');
  return { fmText, body };
}

function buildArchivedContent({ originalText, relPath, reason, successorLink, iso, basename }) {
  const { fmText, body } = splitDocument(originalText);
  const successor = successorLink && String(successorLink).trim() ? String(successorLink).trim() : '无';
  const appended = [
    `archived_from: ${yamlString(relPath)}`,
    `archived_at: ${yamlString(iso)}`,
    `archived_reason: ${yamlString(reason)}`,
    `successor: ${yamlString(successor)}`,
  ];
  const fmLines = fmText === null
    ? ['---', `title: ${yamlString(path.basename(basename, path.extname(basename)))}`, ...appended, '---']
    : ['---', fmText, ...appended, '---'];
  const quote = [
    `> 原始位置：${relPath}`,
    `> 归档时间：${iso}`,
    `> 归档原因：${reason}`,
    `> 继任版本链接：${successor}`,
  ];
  return `${fmLines.join('\n')}\n\n${quote.join('\n')}\n\n${body.replace(/\s+$/, '')}\n`;
}

async function pathExists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function copyTree(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  for (const ent of await fs.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    if (ent.isDirectory()) await copyTree(from, to);
    else if (ent.isFile()) await fs.copyFile(from, to);
  }
}

async function treeStats(dir) {
  let files = 0;
  let bytes = 0;
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = await treeStats(abs);
      files += sub.files;
      bytes += sub.bytes;
    } else if (ent.isFile()) {
      const st = await fs.stat(abs);
      files += 1;
      bytes += st.size;
    }
  }
  return { files, bytes };
}

/** 归档目录里的首页：优先 00_*首页*.md / index.md / README.md / _说明.md，否则顶层第一个 .md。 */
async function findHomePage(dirAbs) {
  let entries;
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name).sort();
  const preferred = [
    files.find((n) => /^00_.*首页.*\.md$/.test(n)),
    files.find((n) => n === 'index.md'),
    files.find((n) => n === 'README.md'),
    files.find((n) => n === '_说明.md'),
  ].find(Boolean);
  const pick = preferred || files[0];
  return pick ? path.join(dirAbs, pick) : null;
}

async function injectDirMeta({ rootAbs, targetAbs, relPath, reason, successorLink, iso }) {
  const home = await findHomePage(targetAbs);
  const homeAbs = home || path.join(targetAbs, '_归档说明.md');
  const originalText = home ? await fs.readFile(homeAbs, 'utf8') : '# 归档说明\n';
  const content = buildArchivedContent({
    originalText,
    relPath,
    reason,
    successorLink,
    iso,
    basename: path.basename(homeAbs),
  });
  const rel = path.relative(rootAbs, homeAbs);
  assertPathLength(rootAbs, rel);
  await assertWritable(rootAbs, homeAbs);
  await writeAtomic(homeAbs, content, { force: true, root: rootAbs });
}

/**
 * @param {{root:string, items:Array<{relPath:string, reason:string, successorLink?:string}>,
 *          now?:Date|string, onStep?:Function, deps?:{rename?:Function, verify?:Function}}} args
 */
export async function archiveItems({ root, items = [], now, onStep = null, deps = {} } = {}) {
  const emit = (key, status, detail) => {
    if (typeof onStep !== 'function') return;
    try {
      onStep({ key, step: key, status, detail });
    } catch {
      /* 上层回调异常不影响归档 */
    }
  };
  const T = CODES;
  const archivedAt = nowIso(asNow(now));
  const renameImpl = typeof deps.rename === 'function' ? deps.rename : fs.rename;
  const verifyImpl = typeof deps.verify === 'function' ? deps.verify : null;
  const failed = [];
  const moved = [];
  const warnings = [];
  const fail = (relPath, code, message) => failed.push({ relPath, code, message });

  emit('validate', 'start', '校验归档参数');
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new EngineError('INVALID_ROOT', 'root 必须是已存在的绝对路径');
  }
  if (!Array.isArray(items)) throw new EngineError('INVALID_ITEMS', 'items 必须是数组');
  const rootAbs = path.resolve(root);
  emit('validate', 'ok', `${items.length} 项`);

  emit('plan', 'start', '规划归档目标');
  const plans = [];
  for (const item of items) {
    const relPath = item && typeof item.relPath === 'string' ? item.relPath.trim() : '';
    const reason = item && typeof item.reason === 'string' ? item.reason.trim() : '';
    if (!relPath || relPath === '.' || relPath === './') {
      fail(relPath, T.INVALID_PATH, 'relPath 不能为空或 "."');
      continue;
    }
    let srcAbs;
    let relFromRoot;
    try {
      srcAbs = safeJoin(rootAbs, relPath);
      relFromRoot = path.relative(rootAbs, srcAbs);
    } catch (err) {
      fail(relPath, err && err.code === 'PATH_ESCAPE' ? T.PATH_ESCAPE : T.NOT_FOUND, err && err.message ? err.message : '非法路径');
      continue;
    }
    if (!relFromRoot || isRelPathInside(relFromRoot, '.jkkb') || isRelPathInside(relFromRoot, '12_归档与历史')) {
      fail(relPath, T.FORBIDDEN_PATH, '不允许归档 root 自身、.jkkb 或 12_归档与历史 下的路径');
      continue;
    }
    if (reason.length < 4) {
      fail(relPath, T.REASON_REQUIRED, 'reason 必填且至少 4 个字符');
      continue;
    }
    let st;
    try {
      st = await fs.stat(srcAbs);
    } catch {
      fail(relPath, T.NOT_FOUND, `原路径不存在：${relPath}`);
      continue;
    }
    const kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
    if (!kind) {
      fail(relPath, T.NOT_FOUND, `既不是文件也不是目录：${relPath}`);
      continue;
    }
    const archiveRel = path.join(ARCHIVE_ROOT, relFromRoot);
    let targetAbs;
    try {
      targetAbs = safeJoin(rootAbs, archiveRel);
    } catch (err) {
      fail(relPath, T.PATH_ESCAPE, err && err.message ? err.message : '归档目标逃逸出 root');
      continue;
    }
    if (await pathExists(targetAbs)) {
      fail(relPath, T.TARGET_EXISTS, `归档目标已存在，不覆盖：${path.relative(rootAbs, targetAbs)}`);
      continue;
    }
    plans.push({ kind, relPath: relFromRoot, srcAbs, targetAbs, archiveRel, reason, successorLink: item.successorLink });
  }
  emit('plan', 'ok', `可归档 ${plans.length} 项，跳过 ${failed.length} 项`);

  emit(
    'write',
    'start',
    `归档 ${plans.length} 项（文件 ${plans.filter((p) => p.kind === 'file').length} / 目录 ${plans.filter((p) => p.kind === 'dir').length}）`,
  );
  const written = [];
  for (const p of plans) {
    if (p.kind === 'file') {
      try {
        const originalText = await fs.readFile(p.srcAbs, 'utf8');
        const content = buildArchivedContent({
          originalText,
          relPath: p.relPath,
          reason: p.reason,
          successorLink: p.successorLink,
          iso: archivedAt,
          basename: path.basename(p.srcAbs),
        });
        assertPathLength(rootAbs, p.archiveRel);
        await ensureDir(rootAbs, path.dirname(p.targetAbs));
        await assertWritable(rootAbs, p.targetAbs);
        const outcome = await writeAtomic(p.targetAbs, content, { force: false, root: rootAbs });
        if (outcome === 'skipped') {
          fail(p.relPath, T.TARGET_EXISTS, '归档目标在写入时已存在，不覆盖');
          continue;
        }
        const st = await fs.stat(p.targetAbs);
        if (!st.isFile() || st.size === 0) throw new Error('归档目标写入后校验失败');
        written.push(p);
      } catch (err) {
        if (err instanceof EngineError) fail(p.relPath, err.code === 'PATH_ESCAPE' ? T.PATH_ESCAPE : T.WRITE_FAILED, err.message);
        else fail(p.relPath, T.WRITE_FAILED, err && err.message ? err.message : String(err));
      }
      continue;
    }

    // 目录：rename →（EXDEV）复制+校验+删源 → 补四要素（best effort）
    try {
      assertPathLength(rootAbs, p.archiveRel);
      await ensureDir(rootAbs, path.dirname(p.targetAbs));
      await assertWritable(rootAbs, p.targetAbs);
      let method = 'rename';
      try {
        await renameImpl(p.srcAbs, p.targetAbs);
      } catch (err) {
        if (!err || err.code !== 'EXDEV') throw err;
        method = 'copy';
        await copyTree(p.srcAbs, p.targetAbs);
        const srcStats = await treeStats(p.srcAbs);
        const dstStats = await treeStats(p.targetAbs);
        const injectedOk = verifyImpl ? verifyImpl({ src: srcStats, target: dstStats }) !== false : true;
        if (!injectedOk || srcStats.files !== dstStats.files || srcStats.bytes !== dstStats.bytes) {
          await fs.rm(p.targetAbs, { recursive: true, force: true }).catch(() => {});
          fail(
            p.relPath,
            T.COPY_VERIFY_FAILED,
            `复制校验失败（源 ${srcStats.files} 文件/${srcStats.bytes} 字节，目标 ${dstStats.files} 文件/${dstStats.bytes} 字节）`,
          );
          continue;
        }
        try {
          await fs.rm(p.srcAbs, { recursive: true, force: true });
        } catch (delErr) {
          await fs.rm(p.targetAbs, { recursive: true, force: true }).catch(() => {});
          fail(p.relPath, T.UNLINK_FAILED, `复制完成但源目录删除失败：${delErr && delErr.message ? delErr.message : delErr}`);
          continue;
        }
      }
      try {
        await injectDirMeta({
          rootAbs,
          targetAbs: p.targetAbs,
          relPath: p.relPath,
          reason: p.reason,
          successorLink: p.successorLink,
          iso: archivedAt,
        });
      } catch (metaErr) {
        warnings.push(`归档目录已移动，但四要素写入失败：${p.relPath}（${metaErr && metaErr.message ? metaErr.message : metaErr}）`);
      }
      moved.push({ from: p.srcAbs, to: p.targetAbs, relPath: p.relPath, kind: 'dir', method });
    } catch (err) {
      // 原子性兜底：源仍在而目标存在 → 清掉目标，保证不会半途
      try {
        if ((await pathExists(p.targetAbs)) && (await pathExists(p.srcAbs))) {
          await fs.rm(p.targetAbs, { recursive: true, force: true });
        }
      } catch {
        /* 清理尽力而为 */
      }
      const code = err instanceof EngineError && err.code === 'PATH_ESCAPE' ? T.PATH_ESCAPE : T.MOVE_FAILED;
      fail(p.relPath, code, err && err.message ? err.message : String(err));
    }
  }
  emit('write', 'ok', `${written.length} 个归档页已写入 / ${moved.filter((m) => m.kind === 'dir').length} 个目录已移动`);

  emit('unlink', 'start', '删除原件');
  for (const p of written) {
    try {
      await fs.unlink(p.srcAbs);
      moved.push({ from: p.srcAbs, to: p.targetAbs, relPath: p.relPath, kind: 'file' });
    } catch (err) {
      // 先写后删：删不掉就标 failed，原件保留（两边都在但绝不报成功）
      fail(p.relPath, T.UNLINK_FAILED, `归档已写出但原件删除失败：${err && err.message ? err.message : err}`);
    }
  }
  emit('unlink', 'ok', `${moved.filter((m) => m.kind === 'file').length} 个原件已删除`);

  emit('report', 'start', '汇总');
  emit('report', 'ok', `moved=${moved.length} failed=${failed.length} warnings=${warnings.length}`);

  return {
    ok: true,
    archivedAt,
    moved,
    failed,
    warnings,
    archiveDir: safeJoin(rootAbs, ARCHIVE_ROOT),
  };
}

/**
 * 仪表盘用：最近修改的笔记（只读）。
 * 跳过 .jkkb/.obsidian/隐藏目录/node_modules 与 00_系统与索引；title 优先 frontmatter。
 * @returns {Promise<Array<{relPath:string, title:string, updatedAt:string, size:number}>>}
 */
export async function listRecentNotes({ root, limit = 10, now } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new EngineError('INVALID_ROOT', 'root 必须是已存在的绝对路径');
  }
  void now; // 排序按真实 mtime；now 只保留给上层统一时间口径
  const rootAbs = path.resolve(root);
  const scan = await scanVault(rootAbs, {});
  const pool = scan.notes
    .filter((f) => !SKIP_RECENT_DIRS.some((dir) => isRelPathInside(f.rel, dir)))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
  const picked = pool.slice(0, max);
  const out = [];
  for (const f of picked) {
    let title = path.basename(f.rel, path.extname(f.rel));
    try {
      const text = stripBom(await fs.readFile(f.abs, 'utf8')).slice(0, 4000);
      const fm = parseFrontmatter(text);
      if (fm.title && fm.title.trim()) title = fm.title.trim();
    } catch {
      /* 读不了就退回文件名 */
    }
    out.push({
      relPath: f.rel,
      title,
      updatedAt: new Date(f.mtimeMs).toISOString(),
      size: f.size,
    });
  }
  return out;
}
