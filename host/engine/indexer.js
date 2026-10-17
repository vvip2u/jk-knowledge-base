/**
 * reindex / inspect。
 * reindex：只读扫描全库，重写 05_索引 下的笔记索引与目录索引，并刷新首页目录地图。
 *          不改用户笔记内容（只读 .md 取 frontmatter 标签）。
 * inspect：给仪表盘的轻量概览，限制扫描深度与文件数，只读不写。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EngineError, CODES, throwIfAborted } from './errors.js';
import { assertPathLength, nowIso, readTextOrNull, resolveRoot, safeJoin, sanitizeRelPath, sanitizeSegment, writeAtomic } from './paths.js';
import { assertWritable } from './guard.js';
import { MODES, getMode } from './presets.js';
import { mapTable, renderMoc, replaceMapSection } from './render.js';
import { fmtTime, humanSize, readTags, scanVault } from './scan.js';

/** 相对路径包含判定：path.relative 语义，禁止字符串前缀比较。 */
function isRelUnder(rel, base) {
  const norm = (v) => String(v).replace(/[\\/]+/g, path.sep);
  const r = path.relative(norm(base), norm(rel));
  return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
}

/** 备份文件名时间戳：YYYYMMDD-HHmmss（Windows 文件名不能含冒号）。 */
function backupStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

async function loadVaultFor(abs) {
  const raw = await readTextOrNull(safeJoin(abs, '.jkkb/vault.json'));
  if (raw === null) {
    throw new EngineError(CODES.VAULT_INVALID, '这不是知识库根目录：缺 .jkkb/vault.json，先运行 bootstrap');
  }
  let v;
  try {
    v = JSON.parse(raw);
  } catch (err) {
    throw new EngineError(CODES.VAULT_INVALID, 'vault.json 不是合法 JSON，无法索引', String(err && err.message));
  }
  if (!v || typeof v !== 'object') {
    throw new EngineError(CODES.VAULT_INVALID, 'vault.json 结构不对，无法索引');
  }
  return v;
}

function marker(stat) {
  return `<!-- jkkb:index files=${stat.files} notes=${stat.notes} dirs=${stat.dirs} generated=${stat.generatedAt} -->`;
}

function notesIndexPage(scan, stat) {
  const rows = [
    '| 文件名 | 路径 | 大小 | 修改时间 | 标签 |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const f of scan.notes) {
    const tags = f.size <= 200 * 1024 ? f.tags || '' : '';
    rows.push(`| ${f.name.replace(/\|/g, '\\|')} | \`${f.rel}\` | ${humanSize(f.size)} | ${fmtTime(f.mtimeMs)} | ${tags || '—'} |`);
  }
  return `# 笔记索引

> 只读扫描生成，请勿手改。收录全库 \`.md\` 文件（含 \`_说明.md\`），
> 已跳过 \`.jkkb\` / \`.obsidian\` / 隐藏目录 / \`node_modules\` / \`assets/engine\` / 索引目录自身。

${marker(stat)}

共 ${scan.notes.length} 篇。

${rows.join('\n')}
`;
}

function dirIndexPage(scan, stat) {
  const rows = ['| 目录 | 文件数 | 总大小 | 最后修改 |', '| --- | --- | --- | --- |'];
  for (const d of scan.dirs) {
    if (!d.rel) continue;
    rows.push(`| \`${d.rel}/\` | ${d.fileCount} | ${humanSize(d.size)} | ${fmtTime(d.mtimeMs)} |`);
  }
  return `# 目录索引

> 只读扫描生成，请勿手改。目录按路径排序，文件数只统计直属文件。

${marker(stat)}

共 ${scan.dirs.filter((d) => d.rel).length} 个目录。

${rows.join('\n')}
`;
}

export async function reindex({ root, onStep = null, shouldAbort = null } = {}) {
  if (shouldAbort !== null && typeof shouldAbort !== 'function') {
    throw new EngineError(CODES.INVALID_ROOT, 'shouldAbort 必须是函数或 null');
  }
  const emit = (step, status, detail, extra = null) => {
    if (typeof onStep !== 'function') return;
    try {
      onStep(extra ? { ...extra, step, status, detail } : { step, status, detail });
    } catch {
      /* 上层回调异常不影响索引 */
    }
  };
  const gate = (step) => {
    try {
      throwIfAborted(shouldAbort);
    } catch (err) {
      emit(step, 'error', err && err.message ? err.message : String(err));
      throw err;
    }
  };
  gate('validate');
  emit('validate', 'start', '校验根目录');
  const abs = await resolveRoot(root);
  const vault = await loadVaultFor(abs);
  const mode = MODES.includes(vault.mode) ? vault.mode : 'asset';
  const cfg = await getMode(mode);
  emit('validate', 'ok', abs, { key: 'validate' });

  gate('scan');
  emit('scan', 'start', '只读扫描');
  const scan = await scanVault(abs, { skipPrefixes: [cfg.indexInto] });
  const warnings = [];
  let seen = 0;
  for (const f of scan.notes) {
    if (seen % 200 === 0) gate('scan');
    seen += 1;
    f.tags = await readTags(f.abs);
  }
  const dirCount = scan.dirs.filter((d) => d.rel).length;
  const generatedAt = nowIso();
  const stat = { files: scan.files.length, notes: scan.notes.length, dirs: dirCount, generatedAt };
  emit('scan', 'ok', `文件 ${stat.files} 个，笔记 ${stat.notes} 篇，目录 ${stat.dirs} 个`, { key: 'scan' });

  const indexDir = cfg.indexInto;
  const notesRel = sanitizeRelPath(path.join(indexDir, '笔记索引.md'));
  const dirRel = sanitizeRelPath(path.join(indexDir, '目录索引.md'));
  const writeFile = async (rel, content) => {
    const safeRel = sanitizeRelPath(rel);
    assertPathLength(abs, safeRel);
    const target = safeJoin(abs, safeRel);
    await writeAtomic(target, content, { force: true, root: abs });
    return target;
  };
  gate('index');
  emit('index', 'start', indexDir);
  const stamp = backupStamp();
  const pruneBackups = async (dir, base, keep) => {
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === keep || !name.endsWith(`-${base}.prev.md`)) continue;
      const old = path.join(dir, name);
      try {
        await assertWritable(abs, old);
        await fs.unlink(old);
      } catch {
        /* 旧备份删不掉不阻断索引 */
      }
    }
  };
  const indexArtifacts = [];
  const backupIndex = async (rel) => {
    const old = await readTextOrNull(safeJoin(abs, rel));
    if (old === null) return;
    const base = sanitizeSegment(path.basename(rel));
    const backupRel = sanitizeRelPath(path.join('.jkkb', 'backup', `${stamp}-${base}.prev.md`));
    try {
      const backupAbs = await writeFile(backupRel, old);
      await pruneBackups(path.dirname(backupAbs), base, path.basename(backupAbs));
      indexArtifacts.push(backupAbs);
    } catch (err) {
      warnings.push(`索引备份失败：${err && err.message ? err.message : err}`);
    }
  };
  await backupIndex(notesRel);
  await backupIndex(dirRel);
  indexArtifacts.push(await writeFile(notesRel, notesIndexPage(scan, stat)));
  indexArtifacts.push(await writeFile(dirRel, dirIndexPage(scan, stat)));
  emit('index', 'ok', `${notesRel} / ${dirRel}`, { key: 'index', artifacts: indexArtifacts });

  // 刷新首页目录地图段：只改标记之间的表格，其它内容不动
  gate('moc');
  const mocRel = sanitizeRelPath(cfg.moc);
  const mocAbs = safeJoin(abs, mocRel);
  const mocText = await readTextOrNull(mocAbs);
  if (mocText === null) {
    warnings.push(`首页缺失，已重新生成：${mocRel}`);
    const counts = Object.fromEntries(cfg.core.map((d) => [d.path, scan.files.filter((f) => isRelUnder(f.rel, d.path)).length]));
    await writeFile(mocRel, renderMoc({ mode, cfg, core: cfg.core, root: abs, date: generatedAt.slice(0, 10), status: vault.status || 'scaffolded', counts }));
  } else {
    const counts = Object.fromEntries(cfg.core.map((d) => [d.path, scan.files.filter((f) => isRelUnder(f.rel, d.path)).length]));
    const next = replaceMapSection(mocText, mapTable(cfg.core, counts));
    if (next !== mocText) await writeFile(mocRel, next);
  }
  emit('moc', 'ok', mocRel, { key: 'moc', artifacts: [mocAbs] });

  // 契约里记下最近一次索引统计
  gate('vault');
  const stampIso = nowIso();
  const nextVault = {
    ...vault,
    updatedAt: stampIso,
    updated_at: stampIso,
    index: { files: stat.files, notes: stat.notes, dirs: stat.dirs, generatedAt, dir: indexDir },
  };
  const vaultRel = sanitizeRelPath('.jkkb/vault.json');
  assertPathLength(abs, vaultRel);
  const vaultAbs = safeJoin(abs, vaultRel);
  await writeAtomic(vaultAbs, `${JSON.stringify(nextVault, null, 2)}\n`, { force: true, root: abs });
  emit('vault', 'ok', 'vault.json 已刷新索引统计', { key: 'vault', artifacts: [vaultAbs] });
  emit('done', 'ok', `${notesRel} 共 ${stat.notes} 条`);

  return {
    root: abs,
    mode,
    indexDir,
    notesIndex: notesRel,
    dirIndex: dirRel,
    moc: mocRel,
    files: stat.files,
    notes: stat.notes,
    dirs: stat.dirs,
    generatedAt,
    truncated: scan.truncated,
    warnings,
  };
}

const EMPTY_INSPECT = {
  exists: false,
  hasVault: false,
  mode: null,
  topDirs: 0,
  fileCount: 0,
  noteCount: 0,
  lastModified: null,
  vaultUpdatedAt: null,
  truncated: false,
};

export async function inspect({ root } = {}) {
  let abs;
  try {
    abs = await resolveRoot(root);
  } catch (err) {
    if (err instanceof EngineError && err.code === CODES.ROOT_NOT_FOUND) {
      return { root: path.resolve(String(root)), ...EMPTY_INSPECT };
    }
    throw err;
  }

  let vault = null;
  const vaultRaw = await readTextOrNull(safeJoin(abs, '.jkkb/vault.json'));
  if (vaultRaw !== null) {
    try {
      vault = JSON.parse(vaultRaw);
    } catch {
      vault = null;
    }
  }

  let topDirs = 0;
  try {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    topDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).length;
  } catch {
    topDirs = 0;
  }

  const scan = await scanVault(abs, { maxFiles: 5000, maxDepth: 6 });
  let lastModified = null;
  let latest = 0;
  for (const f of scan.files) if (f.mtimeMs > latest) latest = f.mtimeMs;
  for (const d of scan.dirs) if (d.mtimeMs > latest) latest = d.mtimeMs;
  if (latest) lastModified = new Date(latest).toISOString();

  return {
    root: abs,
    exists: true,
    hasVault: vault !== null,
    mode: vault && MODES.includes(vault.mode) ? vault.mode : null,
    topDirs,
    fileCount: scan.files.length,
    noteCount: scan.notes.length,
    lastModified,
    vaultUpdatedAt: vault ? vault.updatedAt || vault.updated_at || null : null,
    truncated: scan.truncated,
  };
}
