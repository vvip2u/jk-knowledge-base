/**
 * verify：交付前体检。只读，不改库（不替用户修 status，也不写 vault）。
 * 每条结果为 { id, level: 'error'|'warn'|'info', message, fix? }。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EngineError, CODES, throwIfAborted } from './errors.js';
import { exists, isRelPathInside, readTextOrNull, resolveRoot, safeJoin } from './paths.js';
import { MODES, TEMPLATE_FILES, getMode } from './presets.js';
import { INDEX_MARKER_RE } from './render.js';
import { scanVault } from './scan.js';

const DIR_NAME_RE = /^(?:\d{2}[_-][^\s/\\:*?"<>|]+|_[^\s/\\:*?"<>|]+)$/u;

function validDateLike(val) {
  if (typeof val !== 'string' || !val.trim()) return false;
  return !Number.isNaN(Date.parse(val.replace(' ', 'T')));
}

/** 校验 .jkkb/vault.json 的最小 schema。 */
export function validateVault(v) {
  const issues = [];
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return ['不是 JSON 对象'];
  }
  if (typeof v.version !== 'string' || !v.version) issues.push('version 缺失或非字符串');
  if (!MODES.includes(v.mode)) issues.push(`mode 非法：${JSON.stringify(v.mode)}`);
  const createdAt = v.createdAt || v.created_at;
  if (!validDateLike(createdAt)) issues.push('createdAt 缺失或不是时间');
  const updatedAt = v.updatedAt || v.updated_at;
  if (!validDateLike(updatedAt)) issues.push('updatedAt 缺失或不是时间');
  if (typeof v.root !== 'string' || !path.isAbsolute(v.root)) issues.push('root 不是绝对路径');
  const dirs = Array.isArray(v.dirs) ? v.dirs : Array.isArray(v.directories) ? v.directories : null;
  if (!dirs) issues.push('dirs[] 缺失');
  else if (!dirs.length) issues.push('dirs[] 为空');
  else {
    const bad = dirs.filter((d) => !d || typeof d.name !== 'string' || !d.name).length;
    if (bad) issues.push(`dirs[] 有 ${bad} 条缺 name`);
  }
  if (!v.seq || typeof v.seq !== 'object' || Array.isArray(v.seq)) issues.push('seq{} 缺失');
  else if (Object.values(v.seq).some((n) => typeof n !== 'number' || Number.isNaN(n))) issues.push('seq 计数不是数字');
  return issues;
}

function vaultDirs(v) {
  if (!v) return [];
  if (Array.isArray(v.dirs)) return v.dirs.map((d) => d && d.name).filter((n) => typeof n === 'string' && n);
  if (Array.isArray(v.directories)) return v.directories.map((d) => d && d.name).filter((n) => typeof n === 'string' && n);
  return [];
}

export async function verify({ root, shouldAbort = null } = {}) {
  if (shouldAbort !== null && typeof shouldAbort !== 'function') {
    throw new EngineError(CODES.INVALID_ROOT, 'shouldAbort 必须是函数或 null');
  }
  const gate = () => throwIfAborted(shouldAbort);
  gate();
  const abs = await resolveRoot(root);
  const items = [];
  let checked = 0;
  const add = (level, id, message, fix) => {
    checked += 1;
    const it = { id, level, message };
    if (fix) it.fix = fix;
    items.push(it);
  };

  add('info', 'root', `根目录存在：${abs}`);

  // 1) 契约文件
  gate();
  const vaultAbs = safeJoin(abs, '.jkkb/vault.json');
  const raw = await readTextOrNull(vaultAbs);
  let vault = null;
  if (raw === null) {
    add('error', 'vault_missing', '缺少契约文件 .jkkb/vault.json', '运行 bootstrap 补建契约');
  } else {
    try {
      vault = JSON.parse(raw);
    } catch (err) {
      add('error', 'vault_invalid', `vault.json 不是合法 JSON：${err && err.message}`, '修复 JSON 或删除后重新 bootstrap');
    }
    if (vault) {
      const issues = validateVault(vault);
      if (issues.length) {
        add('error', 'vault_schema', `vault.json 字段不合契约：${issues.join('；')}`, '按 references/09-data-contract.md 修复字段');
      } else {
        add('info', 'vault_schema', 'vault.json 字段合法');
      }
      if (vault.root && vault.root !== abs) {
        add('warn', 'vault_root', `vault.json 记录的根目录与当前不一致：${vault.root}`, '库被移动过，可重新 bootstrap --force 刷新契约');
      }
    }
  }

  const mode = vault && MODES.includes(vault.mode) ? vault.mode : 'asset';
  const cfg = await getMode(mode);

  gate();
  // 2) 顶层目录
  let topEntries = [];
  try {
    topEntries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    topEntries = [];
  }
  const visible = topEntries.filter((e) => !e.name.startsWith('.'));
  const diskDirs = visible.filter((e) => e.isDirectory()).map((e) => e.name);
  const diskFiles = visible.filter((e) => !e.isDirectory()).map((e) => e.name);

  const expected = Array.from(new Set([...cfg.core.map((d) => d.path), ...vaultDirs(vault)]));
  const missingDirs = expected.filter((name) => !diskDirs.includes(name));
  if (missingDirs.length) {
    add('error', 'top_dirs_missing', `缺顶层目录：${missingDirs.join('、')}`, 'bootstrap 会补齐缺失目录与 _说明.md');
  } else {
    add('info', 'top_dirs', `${expected.length} 个顶层目录齐全`);
  }

  // 3) 目录命名
  const badNames = diskDirs.filter((name) => !DIR_NAME_RE.test(name));
  if (badNames.length) {
    add('warn', 'dir_naming', `目录命名不合规范（应为 NN_名称 或 _名称）：${badNames.join('、')}`, '改名后运行 reindex 刷新索引');
  } else {
    add('info', 'dir_naming', '目录命名符合规范');
  }

  // 4) 每个顶层目录的 _说明.md
  const noReadme = [];
  for (const name of expected) {
    if (!diskDirs.includes(name)) continue;
    if (!(await exists(safeJoin(abs, path.join(name, '_说明.md'))))) noReadme.push(name);
  }
  if (noReadme.length) {
    add('error', 'readme_missing', `缺 _说明.md：${noReadme.join('、')}`, 'bootstrap 会补齐（不覆盖已有文件）');
  } else {
    add('info', 'readme_ok', '每个顶层目录都有 _说明.md');
  }

  gate();
  // 5) 五份规范
  const missingSpecs = [];
  for (const name of cfg.specNames) {
    if (!(await exists(safeJoin(abs, path.join(cfg.specsDir, name))))) missingSpecs.push(name);
  }
  if (missingSpecs.length) {
    add('error', 'spec_missing', `缺规范文件：${missingSpecs.join('、')}`, `路径：${cfg.specsDir}/`);
  } else {
    add('info', 'spec_ok', `${cfg.specNames.length} 份规范齐全`);
  }

  gate();
  // 6) 模板
  const tplDirAbs = cfg.templatesDir ? safeJoin(abs, cfg.templatesDir) : '';
  const missingTpl = [];
  if (tplDirAbs) {
    for (const item of TEMPLATE_FILES) {
      if (!(await exists(path.join(tplDirAbs, item.as)))) missingTpl.push(item.as);
    }
  } else {
    missingTpl.push('（系统层未配置模板目录）');
  }
  if (missingTpl.length) {
    add('error', 'templates_missing', `缺模板：${missingTpl.join('、')}`, 'bootstrap 会补齐');
  } else {
    add('info', 'templates_ok', `${TEMPLATE_FILES.length} 个模板齐全`);
  }

  // 7) 首页
  if (!(await exists(safeJoin(abs, cfg.moc)))) {
    add('error', 'moc_missing', `缺首页 MOC：${cfg.moc}`, 'bootstrap 会补齐');
  } else {
    add('info', 'moc_ok', `首页存在：${cfg.moc}`);
  }

  gate();
  // 8) 孤儿：未登记的顶层目录 / 顶层散落文件
  const registered = new Set(expected);
  const orphans = diskDirs.filter((name) => !registered.has(name));
  if (orphans.length) {
    add('warn', 'orphan_dirs', `顶层有未登记目录：${orphans.join('、')}`, '移到合适目录，或在 vault.json 的 dirs[] 里登记');
  }
  // topic 模式的首页就落在根目录，不算散落文件
  const mocBase = cfg.moc.includes('/') ? '' : cfg.moc;
  const looseFiles = diskFiles.filter((name) => !name.startsWith('.') && name !== mocBase);
  if (looseFiles.length) {
    add('warn', 'orphan_files', `顶层有散落文件：${looseFiles.slice(0, 5).join('、')}${looseFiles.length > 5 ? ' 等' : ''}`, '文件应放进对应目录，顶层只留目录');
  }
  if (!orphans.length && !looseFiles.length) add('info', 'no_orphans', '顶层无孤儿目录或散落文件');

  gate();
  // 9) 空目录 + 索引一致性（一次扫描）
  const scan = await scanVault(abs, { skipPrefixes: [cfg.indexInto] });
  const dirSet = new Set(scan.dirs.map((d) => d.rel));
  const emptyDirs = scan.dirs
    .filter((d) => d.rel && d.fileCount === 0)
    .filter((d) => !Array.from(dirSet).some((rel) => rel !== d.rel && isRelPathInside(rel, d.rel)))
    .map((d) => d.rel);
  if (emptyDirs.length) {
    add('warn', 'dir_empty', `空目录（Obsidian 里几乎等于不存在）：${emptyDirs.slice(0, 5).join('、')}${emptyDirs.length > 5 ? ' 等' : ''}`, '放一个 _说明.md 或首个文件');
  } else {
    add('info', 'dir_empty', '没有空目录');
  }
  add('info', 'counts', `文件 ${scan.files.length} 个，笔记 ${scan.notes.length} 篇`);

  const notesIndex = safeJoin(abs, path.join(cfg.indexInto, '笔记索引.md'));
  const idxText = await readTextOrNull(notesIndex);
  if (idxText === null) {
    add('warn', 'index_missing', `缺索引：${cfg.indexInto}/笔记索引.md`, '运行 reindex 生成');
  } else {
    const m = idxText.match(INDEX_MARKER_RE);
    if (!m) {
      add('warn', 'index_marker', '索引页缺少统计标记，无法判断是否过期', '运行 reindex 重新生成');
    } else {
      const stat = {};
      for (const kv of m[1].split(/\s+/)) {
        const i = kv.indexOf('=');
        if (i > 0) stat[kv.slice(0, i)] = kv.slice(i + 1);
      }
      if (Number(stat.files) !== scan.files.length || Number(stat.notes) !== scan.notes.length) {
        add('warn', 'index_stale', `索引与文件数不一致：索引 files=${stat.files}/notes=${stat.notes}，实际 files=${scan.files.length}/notes=${scan.notes.length}`, '运行 reindex 刷新');
      } else {
        add('info', 'index_ok', `索引与文件数一致（files=${stat.files} notes=${stat.notes}）`);
      }
    }
  }

  const errors = items.filter((i) => i.level === 'error');
  const warnings = items.filter((i) => i.level === 'warn');
  const infos = items.filter((i) => i.level === 'info');
  const ok = errors.length === 0;
  return {
    root: abs,
    mode,
    ok,
    checked,
    errors,
    warnings,
    infos,
    counts: { error: errors.length, warn: warnings.length, info: infos.length, files: scan.files.length, notes: scan.notes.length },
    summary: ok
      ? `体检通过：${checked} 项检查，0 error，${warnings.length} warn`
      : `体检未通过：${checked} 项检查，${errors.length} error，${warnings.length} warn`,
  };
}
