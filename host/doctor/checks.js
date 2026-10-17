/**
 * doctor 检查器（纯读）。
 *
 * 每个检查单独 try/catch；任何单个检查抛错都降级为 warn/CHECK_FAILED，不让整次诊断失败。
 * store / run / checkpoint 一律直接读原始文件，不依赖 store 是否已恢复。
 */
import path from 'node:path';
import { getMode } from '../engine/presets.js';
import { INDEX_MARKER_RE } from '../engine/render.js';
import { scanVault } from '../engine/scan.js';
import { HEARTBEAT_SILENCE_MS, archiveIndexPath, RUNS_REL_DIR, LOCK_REL_PATH } from '../trace.js';
import { settingsPath as defaultSettingsPath, readSettings } from '../config.js';
import { NAMESPACE_MAP, NUMBER_PREFIXES, NUMBER_REGISTRY_FILE } from '../store/index.js';
import { exists, isDir, readJsonRaw, readdirSafe, summarize, toDate } from './util.js';
import { listQuarantine, QUARANTINE_REL } from './quarantine.js';

export const STORE_NAMESPACES = Object.freeze(Object.values(NAMESPACE_MAP));
/** numbering 不是「记录仓储」（它只有 registry.json 计数器），索引一致性检查只看这些。 */
export const RECORD_NAMESPACES = Object.freeze(Object.values(NAMESPACE_MAP).filter((ns) => ns !== 'numbering'));
export const REGISTRY_NAMESPACES = Object.freeze([
  { namespace: 'cards', checkId: 'REG-01', repairId: 'R-REG-01' },
  { namespace: 'skills', checkId: 'REG-02', repairId: 'R-REG-02' },
  { namespace: 'reports', checkId: 'REG-03', repairId: 'R-REG-03' },
  { namespace: 'experts', checkId: 'REG-04', repairId: 'R-REG-04' },
]);

export function createContext({ root, store, now, deps = {} } = {}) {
  const nowDate = toDate(now);
  return {
    root: root ? path.resolve(String(root)) : null,
    store: store || null,
    now: nowDate,
    nowMs: nowDate.getTime(),
    deps,
    settingsFile: deps.settingsPath || defaultSettingsPath(deps.home),
    mode: 'asset',
    cfg: null,
    rootUsable: false,
    vault: null,
  };
}

function vaultPath(root) {
  return path.join(root, '.jkkb', 'vault.json');
}

function storeDir(root) {
  return path.join(root, '.jkkb', 'store');
}

export function namespaceDir(ctx, ns) {
  return path.join(storeDir(ctx.root), ns);
}

export function indexFileFor(ctx, ns) {
  return path.join(namespaceDir(ctx, ns), 'index.json');
}

export async function listNamespacesOnDisk(ctx) {
  const out = [];
  for (const ns of STORE_NAMESPACES) {
    if (await isDir(namespaceDir(ctx, ns))) out.push(ns);
  }
  return out;
}

async function prepareMode(ctx) {
  const vault = await readJsonRaw(vaultPath(ctx.root));
  ctx.vault = vault.ok ? vault.value : null;
  const mode = ctx.vault && ctx.vault.mode === 'topic' ? 'topic' : 'asset';
  ctx.mode = mode;
  ctx.cfg = await getMode(mode);
}

function entry(id, level, title, detail, extra = {}) {
  return { id, level, title, detail, ...extra };
}

// ───────────────────────────── root / config ─────────────────────────────

export async function checkConfig(ctx) {
  const raw = await exists(ctx.settingsFile) ? readJsonRaw(ctx.settingsFile) : { ok: true, value: null, error: null };
  const configured = raw.ok && raw.value && typeof raw.value.root === 'string' && raw.value.root.trim() ? raw.value.root.trim() : null;
  if (!ctx.root && configured) ctx.root = path.resolve(configured);
  if (!raw.ok) {
    return {
      cfg02: entry('CFG-02', 'error', '配置档案可解析', `settings.json 无法解析：${raw.error && raw.error.message}`, { repairId: 'R-CFG-01', repairable: true }),
      configured,
      rawOk: false,
    };
  }
  const settings = readSettings(ctx.settingsFile);
  if (!ctx.root && !settings.root) {
    return { cfg02: entry('CFG-02', 'ok', '配置档案可解析', 'settings.json 不存在或未配置根目录'), configured: null, rawOk: true };
  }
  return { cfg02: entry('CFG-02', 'ok', '配置档案可解析', 'settings.json 可解析'), configured, rawOk: true, settings };
}

export async function checkRoot(ctx) {
  if (!ctx.root) {
    return {
      cfg01: entry('CFG-01', 'blocked', '根目录已配置', '未配置知识库根目录（settings.json.root 为空）'),
      root01: entry('ROOT-01', 'blocked', '根目录可用', '未配置根目录，无法诊断'),
      root02: entry('ROOT-02', 'blocked', '根目录可写', '未配置根目录'),
      root03: entry('ROOT-03', 'blocked', '路径守卫可用', '未配置根目录'),
      usable: false,
    };
  }
  const dir = await isDir(ctx.root);
  if (!dir) {
    return {
      cfg01: entry('CFG-01', 'ok', '根目录已配置', ctx.root),
      root01: entry('ROOT-01', 'blocked', '根目录可用', `根目录不存在或不是目录：${ctx.root}`),
      root02: entry('ROOT-02', 'blocked', '根目录可写', '根目录不可用'),
      root03: entry('ROOT-03', 'blocked', '路径守卫可用', '根目录不可用'),
      usable: false,
    };
  }
  // 可写性用 access(W_OK) 判定，不写探针文件——diagnose 必须零写入。
  let writable = true;
  let writeErr = '';
  try {
    const fsp = await import('node:fs/promises');
    await fsp.access(ctx.root, (await import('node:fs')).constants.W_OK);
  } catch (err) {
    writable = false;
    writeErr = `${err && err.code ? err.code + ': ' : ''}${err && err.message ? err.message : err}`;
  }
  let guardOk = true;
  let guardErr = '';
  try {
    const { authorizeRoot, assertWritableSync } = await import('../engine/guard.js');
    await authorizeRoot(ctx.root);
    assertWritableSync(ctx.root, path.join(ctx.root, '.jkkb', 'runs'));
  } catch (err) {
    guardOk = false;
    guardErr = `${err && err.code ? err.code + ': ' : ''}${err && err.message ? err.message : err}`;
  }
  ctx.rootUsable = writable && guardOk;
  return {
    cfg01: entry('CFG-01', 'ok', '根目录已配置', ctx.root),
    root01: entry('ROOT-01', 'ok', '根目录可用', ctx.root),
    root02: writable
      ? entry('ROOT-02', 'ok', '根目录可写', 'access(W_OK) 通过（不写探针文件）')
      : entry('ROOT-02', 'blocked', '根目录不可写', `写探针失败：${writeErr}`),
    root03: guardOk
      ? entry('ROOT-03', 'ok', '路径守卫可用', 'authorizeRoot + assertWritableSync 通过')
      : entry('ROOT-03', 'blocked', '路径守卫不可用', guardErr),
    usable: ctx.rootUsable,
  };
}

// ───────────────────────────── dirs / system / index ─────────────────────────────

export async function detectDirs(ctx) {
  const core = ctx.cfg.core.map((d) => d.path);
  const missing = [];
  for (const name of core) {
    if (!(await isDir(path.join(ctx.root, name)))) missing.push(name);
  }
  return { core, missing };
}

export async function checkDirs(ctx) {
  const { core, missing } = await detectDirs(ctx);
  if (!missing.length) return entry('DIR-01', 'ok', '顶层目录完整', `${core.length} 个顶层目录齐全`);
  return entry('DIR-01', 'error', '顶层目录完整', `缺 ${missing.length} 个目录：${missing.join('、')}`, {
    repairId: 'R-DIR-01',
    repairable: true,
  });
}

export function systemFileList(ctx) {
  const list = [{ rel: ctx.cfg.moc, kind: 'moc' }];
  for (const item of ctx.cfg.extraIndex) list.push({ rel: path.join(ctx.cfg.indexDir, item.as), kind: 'index' });
  return list.map((x) => ({ ...x, abs: path.join(ctx.root, x.rel) }));
}

export async function detectSystemFiles(ctx) {
  const out = [];
  for (const f of systemFileList(ctx)) {
    let empty = true;
    try {
      const fs = await import('node:fs/promises');
      const text = await fs.readFile(f.abs, 'utf8');
      empty = !text.trim();
    } catch {
      empty = true;
    }
    if (empty) out.push(f);
  }
  return out;
}

export async function checkSystem(ctx) {
  const bad = await detectSystemFiles(ctx);
  if (!bad.length) return entry('SYS-01', 'ok', '系统文件完整', '首页与索引页均存在且有内容');
  return entry('SYS-01', 'error', '系统文件完整', `缺失或为空：${bad.map((b) => b.rel).join('、')}`, {
    repairId: 'R-SYS-01',
    repairable: true,
  });
}

export async function detectIndexMismatch(ctx) {
  const notesIndex = path.join(ctx.root, ctx.cfg.indexInto, '笔记索引.md');
  let text = null;
  try {
    const fs = await import('node:fs/promises');
    text = await fs.readFile(notesIndex, 'utf8');
  } catch {
    text = null;
  }
  const scan = await scanVault(ctx.root, { skipPrefixes: [ctx.cfg.indexInto] });
  const m = text ? text.match(INDEX_MARKER_RE) : null;
  const stat = {};
  if (m) {
    for (const kv of m[1].split(/\s+/)) {
      const i = kv.indexOf('=');
      if (i > 0) stat[kv.slice(0, i)] = kv.slice(i + 1);
    }
  }
  const stale = !m || Number(stat.files) !== scan.files.length || Number(stat.notes) !== scan.notes.length;
  return { notesIndex, exists: text !== null, stale, actual: { files: scan.files.length, notes: scan.notes.length }, marked: stat };
}

export async function checkIndex(ctx) {
  const info = await detectIndexMismatch(ctx);
  if (!info.stale) return entry('IDX-01', 'ok', '索引与文件一致', `files=${info.actual.files} notes=${info.actual.notes}`);
  return entry(
    'IDX-01',
    'error',
    '索引与文件一致',
    info.exists
      ? `索引与文件数不符（索引 files=${info.marked.files || '?'} notes=${info.marked.notes || '?'}，实际 files=${info.actual.files} notes=${info.actual.notes}）`
      : '索引页缺失',
    { repairId: 'R-IDX-01', repairable: true },
  );
}

// ───────────────────────────── store ─────────────────────────────

export async function detectBrokenStoreFiles(ctx) {
  const broken = [];
  for (const ns of STORE_NAMESPACES) {
    for (const ent of await readdirSafe(namespaceDir(ctx, ns))) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      const abs = path.join(namespaceDir(ctx, ns), ent.name);
      const r = readJsonRaw(abs);
      if (!r.ok) broken.push({ namespace: ns, abs, error: r.error && r.error.message });
    }
  }
  return broken;
}

export async function checkStoreFiles(ctx) {
  const broken = await detectBrokenStoreFiles(ctx);
  if (!broken.length) return entry('STORE-01', 'ok', 'store 文件可解析', '所有 store JSON 均可解析');
  return entry('STORE-01', 'error', 'store 文件可解析', `${broken.length} 个文件无法解析：${broken.map((b) => path.basename(b.abs)).join('、')}`, {
    repairId: 'R-STORE-01',
    repairable: true,
  });
}

export async function detectRegistryMismatch(ctx, ns) {
  const dir = namespaceDir(ctx, ns);
  if (!(await isDir(dir)) && !(await exists(indexFileFor(ctx, ns)))) {
    return { ns, dir, absent: true, diskIds: [], indexIds: [], indexOk: true, idxMissing: [], orphans: [], archivedMissing: [], indexAbs: indexFileFor(ctx, ns) };
  }
  const diskIds = [];
  for (const ent of await readdirSafe(dir)) {
    if (!ent.isFile() || !ent.name.endsWith('.json') || ent.name === 'index.json') continue;
    diskIds.push(ent.name.slice(0, -5));
  }
  const idxRaw = readJsonRaw(indexFileFor(ctx, ns));
  const indexIds = idxRaw.ok && Array.isArray(idxRaw.value.ids) ? idxRaw.value.ids.slice() : [];
  const archivedMissing = idxRaw.ok && Array.isArray(idxRaw.value.missing) ? idxRaw.value.missing.slice() : [];
  const idxMissing = diskIds.filter((id) => !indexIds.includes(id));
  const orphans = indexIds.filter((id) => !diskIds.includes(id) && !archivedMissing.includes(id));
  return { ns, dir, diskIds, indexIds, indexOk: idxRaw.ok, idxMissing, orphans, archivedMissing, indexAbs: indexFileFor(ctx, ns) };
}

export async function detectAllRegistryMismatch(ctx) {
  const out = [];
  for (const ns of RECORD_NAMESPACES) {
    const m = await detectRegistryMismatch(ctx, ns);
    if (!m.indexOk || m.idxMissing.length || m.orphans.length) out.push(m);
  }
  return out;
}

export async function checkStoreIndex(ctx) {
  const bad = await detectAllRegistryMismatch(ctx);
  if (!bad.length) return entry('STORE-02', 'ok', 'store 索引一致', '所有命名空间索引与实体一致');
  const detail = bad
    .map((b) => `${b.ns}: 缺登记 ${b.idxMissing.length} / 孤儿 ${b.orphans.length}${b.indexOk ? '' : '（index 损坏）'}`)
    .join('；');
  return entry('STORE-02', 'error', 'store 索引一致', detail, { repairId: 'R-STORE-02', repairable: true });
}

export function parseIdNum(id) {
  const m = /^(RT|R|S|H|E|D|K|P|DOC|SK|EXP)-?(?:\d{4}-)?(\d{3})$/.exec(String(id || ''));
  if (!m) return null;
  return { prefix: m[1], num: Number(m[2]) };
}

export async function detectCounterMismatch(ctx) {
  const registryFile = path.join(namespaceDir(ctx, 'numbering'), NUMBER_REGISTRY_FILE);
  const raw = readJsonRaw(registryFile);
  const counters = raw.ok && raw.value && raw.value.counters ? raw.value.counters : {};
  const maxByPrefix = {};
  for (const ns of STORE_NAMESPACES) {
    for (const ent of await readdirSafe(namespaceDir(ctx, ns))) {
      if (!ent.isFile() || !ent.name.endsWith('.json') || ent.name === 'index.json') continue;
      const keys = [ent.name.slice(0, -5)];
      const rec = readJsonRaw(path.join(namespaceDir(ctx, ns), ent.name));
      if (rec.ok && rec.value && typeof rec.value.id === 'string') keys.push(rec.value.id);
      for (const key of keys) {
        const parsed = parseIdNum(key);
        if (parsed) maxByPrefix[parsed.prefix] = Math.max(maxByPrefix[parsed.prefix] || 0, parsed.num);
      }
    }
  }
  const regressed = [];
  for (const prefix of NUMBER_PREFIXES) {
    const current = Number.isFinite(counters[prefix]) ? counters[prefix] : 0;
    const actual = maxByPrefix[prefix] || 0;
    if (actual > current) regressed.push({ prefix, current, actual });
  }
  return { registryFile, registryOk: raw.ok, counters, maxByPrefix, regressed };
}

export async function checkCounters(ctx) {
  const info = await detectCounterMismatch(ctx);
  if (!info.regressed.length) return entry('STORE-03', 'ok', '编号计数器一致', '计数器不低于实际最大编号');
  return entry(
    'STORE-03',
    'error',
    '编号计数器一致',
    `计数器回退：${info.regressed.map((r) => `${r.prefix} ${r.current}<${r.actual}`).join('、')}`,
    { repairId: 'R-STORE-03', repairable: true },
  );
}

// ───────────────────────────── runs ─────────────────────────────

export async function listRunIds(ctx) {
  const base = path.join(ctx.root, RUNS_REL_DIR);
  const out = [];
  for (const ent of await readdirSafe(base)) {
    if (ent.isDirectory()) out.push(ent.name);
  }
  return out.sort();
}

export async function detectRuns(ctx) {
  const base = path.join(ctx.root, RUNS_REL_DIR);
  const runs = [];
  for (const ent of await readdirSafe(base)) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(base, ent.name);
    const runJson = path.join(dir, 'run.json');
    const checkpoint = path.join(dir, 'checkpoint.json');
    const record = { id: ent.name, dir, runJson, run: null, runBroken: false, checkpointBroken: false, staleRunning: false };
    if (await exists(runJson)) {
      const raw = readJsonRaw(runJson);
      if (!raw.ok) record.runBroken = true;
      else {
        record.run = raw.value;
        const status = record.run && record.run.status;
        if (status === 'running') {
          const hb = Date.parse(record.run.heartbeatAt || '');
          const by = record.run.heartbeatBy === 'agent' ? 'agent' : 'engine';
          const silence = HEARTBEAT_SILENCE_MS[by] || HEARTBEAT_SILENCE_MS.engine;
          const last = Number.isFinite(hb) ? hb : Date.parse(record.run.startedAt || '');
          if (!Number.isFinite(last) || ctx.nowMs - last > silence) record.staleRunning = true;
        }
      }
    }
    if (await exists(checkpoint)) {
      const cp = readJsonRaw(checkpoint);
      if (!cp.ok) record.checkpointBroken = true;
    }
    runs.push(record);
  }
  const archive = readJsonRaw(archiveIndexPath(ctx.root));
  return { base, runs, archive: { abs: archiveIndexPath(ctx.root), ok: archive.ok } };
}

export async function checkRunJson(ctx) {
  const { runs } = await detectRuns(ctx);
  const bad = runs.filter((r) => r.runBroken);
  if (!bad.length) return entry('RUN-01', 'ok', 'run.json 可解析', `${runs.length} 个 run 记录可读`);
  return entry('RUN-01', 'error', 'run.json 可解析', `损坏：${bad.map((r) => r.id).join('、')}`, { repairId: 'R-RUN-01', repairable: true });
}

export async function checkStaleRuns(ctx) {
  const { runs } = await detectRuns(ctx);
  const stale = runs.filter((r) => r.staleRunning);
  if (!stale.length) return entry('RUN-02', 'ok', '运行中心跳正常', '无心跳超期的 running run');
  return entry('RUN-02', 'error', '运行中心跳正常', `心跳超期：${stale.map((r) => r.id).join('、')}`, { repairId: 'R-RUN-02', repairable: true });
}

export async function detectLock(ctx) {
  const abs = path.join(ctx.root, LOCK_REL_PATH);
  if (!(await exists(abs))) return { abs, present: false, ok: true, lock: null };
  const raw = readJsonRaw(abs);
  return { abs, present: true, ok: raw.ok, lock: raw.ok ? raw.value : null };
}

export async function checkLock(ctx) {
  const info = await detectLock(ctx);
  if (!info.present) return entry('RUN-03', 'ok', '锁状态正常', '无残留锁');
  if (!info.ok) return entry('RUN-03', 'error', '锁状态正常', 'lock.json 无法解析（按残留锁处理）', { repairId: 'R-RUN-03', repairable: true });
  const { runs } = await detectRuns(ctx);
  const target = runs.find((r) => r.id === info.lock.runId);
  const active = target && target.run && target.run.status === 'running' && !target.staleRunning;
  if (active) return entry('RUN-03', 'ok', '锁状态正常', `锁由运行中的 run 持有：${info.lock.runId}`);
  return entry('RUN-03', 'error', '锁状态正常', `锁残留：runId=${info.lock.runId || '?'} 无对应活跃 run`, { repairId: 'R-RUN-03', repairable: true });
}

export async function checkCheckpoints(ctx) {
  const { runs } = await detectRuns(ctx);
  const bad = runs.filter((r) => r.checkpointBroken);
  if (!bad.length) return entry('RUN-04', 'ok', 'checkpoint 可解析', '无损坏 checkpoint');
  return entry('RUN-04', 'error', 'checkpoint 可解析', `损坏：${bad.map((r) => r.id).join('、')}`, { repairId: 'R-RUN-04', repairable: true });
}

export async function checkArchiveIndex(ctx) {
  const { archive } = await detectRuns(ctx);
  if (!(await exists(archive.abs))) return entry('RUN-05', 'ok', '滚动归档索引', 'archive/index.json 未生成（无需处理）');
  if (!archive.ok) return entry('RUN-05', 'error', '滚动归档索引', 'runs/archive/index.json 无法解析', { repairId: 'R-RUN-05', repairable: true });
  return entry('RUN-05', 'ok', '滚动归档索引', 'archive/index.json 可解析');
}

// ───────────────────────────── registries / dup / quarantine ─────────────────────────────

export async function checkRegistry(ctx, def) {
  const m = await detectRegistryMismatch(ctx, def.namespace);
  if (m.indexOk && !m.idxMissing.length && !m.orphans.length) {
    return entry(def.checkId, 'ok', `${def.namespace} 注册表一致`, `${m.diskIds.length} 条记录`);
  }
  return entry(
    def.checkId,
    'error',
    `${def.namespace} 注册表一致`,
    `缺登记 ${m.idxMissing.length} 条、孤儿记录 ${m.orphans.length} 条${m.indexOk ? '' : '（index 损坏）'}`,
    { repairId: def.repairId, repairable: true },
  );
}

export async function detectDuplicateIds(ctx) {
  const map = new Map();
  for (const ns of RECORD_NAMESPACES) {
    for (const ent of await readdirSafe(namespaceDir(ctx, ns))) {
      if (!ent.isFile() || !ent.name.endsWith('.json') || ent.name === 'index.json') continue;
      const rec = readJsonRaw(path.join(namespaceDir(ctx, ns), ent.name));
      const id = rec.ok && rec.value && typeof rec.value.id === 'string' ? rec.value.id : ent.name.slice(0, -5);
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(`${ns}/${ent.name}`);
    }
  }
  return [...map.entries()].filter(([, files]) => files.length > 1).map(([id, files]) => ({ id, files }));
}

export async function checkDuplicates(ctx) {
  const dups = await detectDuplicateIds(ctx);
  if (!dups.length) return entry('DUP-01', 'ok', '编号唯一', 'store 内无重复编号');
  return entry('DUP-01', 'warn', '编号唯一', `重复编号：${dups.map((d) => d.id).join('、')}（仅报告，不自动修改）`);
}

export async function checkQuarantine(ctx) {
  const items = await listQuarantine(ctx.root);
  if (!items.length) return entry('QUAR-01', 'ok', '隔离区', `无未处理项（${QUARANTINE_REL}）`);
  return entry('QUAR-01', 'warn', '隔离区', `${items.length} 个未处理项，最近：${items.slice(0, 5).map((x) => x.rel).join('、')}`);
}

// ───────────────────────────── diagnose ─────────────────────────────

const CHECK_TITLES = {
  'CFG-01': '根目录已配置',
  'CFG-02': '配置档案可解析',
  'ROOT-01': '根目录可用',
  'ROOT-02': '根目录可写',
  'ROOT-03': '路径守卫可用',
  'DIR-01': '顶层目录完整',
  'SYS-01': '系统文件完整',
  'IDX-01': '索引与文件一致',
  'STORE-01': 'store 文件可解析',
  'STORE-02': 'store 索引一致',
  'STORE-03': '编号计数器一致',
  'RUN-01': 'run.json 可解析',
  'RUN-02': '运行中心跳正常',
  'RUN-03': '锁状态正常',
  'RUN-04': 'checkpoint 可解析',
  'RUN-05': '滚动归档索引',
  'REG-01': 'cards 注册表一致',
  'REG-02': 'skills 注册表一致',
  'REG-03': 'reports 注册表一致',
  'REG-04': 'experts 注册表一致',
  'DUP-01': '编号唯一',
  'QUAR-01': '隔离区',
};

function blockedEntry(id, detail) {
  return entry(id, 'blocked', CHECK_TITLES[id] || id, detail);
}

export async function runChecks(ctx) {
  const cfg = await checkConfig(ctx);
  const rootInfo = await checkRoot(ctx);
  ctx.rootUsable = rootInfo.usable;

  const checks = [cfg.cfg02, rootInfo.cfg01, rootInfo.root01, rootInfo.root02, rootInfo.root03];
  const rest = [
    ['DIR-01', async () => checkDirs(ctx)],
    ['SYS-01', async () => checkSystem(ctx)],
    ['IDX-01', async () => checkIndex(ctx)],
    ['STORE-01', async () => checkStoreFiles(ctx)],
    ['STORE-02', async () => checkStoreIndex(ctx)],
    ['STORE-03', async () => checkCounters(ctx)],
    ['RUN-01', async () => checkRunJson(ctx)],
    ['RUN-02', async () => checkStaleRuns(ctx)],
    ['RUN-03', async () => checkLock(ctx)],
    ['RUN-04', async () => checkCheckpoints(ctx)],
    ['RUN-05', async () => checkArchiveIndex(ctx)],
    ['REG-01', async () => checkRegistry(ctx, REGISTRY_NAMESPACES[0])],
    ['REG-02', async () => checkRegistry(ctx, REGISTRY_NAMESPACES[1])],
    ['REG-03', async () => checkRegistry(ctx, REGISTRY_NAMESPACES[2])],
    ['REG-04', async () => checkRegistry(ctx, REGISTRY_NAMESPACES[3])],
    ['DUP-01', async () => checkDuplicates(ctx)],
    ['QUAR-01', async () => checkQuarantine(ctx)],
  ];

  if (ctx.rootUsable) {
    await prepareMode(ctx);
  }

  for (const [id, fn] of rest) {
    if (!ctx.rootUsable) {
      checks.push(blockedEntry(id, '根目录不可用或不可写，跳过该检查'));
      continue;
    }
    try {
      if (ctx.deps && ctx.deps.failCheckId === id) throw new Error('注入的检查失败（测试用）');
      checks.push(await fn());
    } catch (err) {
      checks.push(
        entry(id, 'warn', CHECK_TITLES[id] || id, `检查失败（已降级）：${err && err.message ? err.message : err}`, { code: 'CHECK_FAILED' }),
      );
    }
  }

  // 依赖顺序：DIR-01 失败时，把依赖目录的检查降级说明（仍保留各自结果）
  return checks;
}

export { entry, summarize };
