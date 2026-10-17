/**
 * doctor 修复器（有副作用，只补缺/隔离，不删除用户内容）。
 *
 * 每个 repair 自己重新检测目标（幂等）：没有需要修的就返回 skipped。
 * 一切写入走路径守卫；损坏/过期产物一律隔离到 .jkkb/quarantine/<ts>/。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { hashAckText, RISK_ACK_TEXT, RISK_ACK_VERSION } from '../config.js';
import { writeAtomic } from '../engine/paths.js';
import { ensureDir, assertPathLength } from '../engine/paths.js';
import { renderExtraIndex, renderMoc } from '../engine/render.js';
import { loadPresets, getMode } from '../engine/presets.js';
import { reindex } from '../engine/indexer.js';
import { archiveIndexPath, indexFile as runsIndexFile, readIndex, runFile, writeIndex, writeJsonAtomic } from '../trace.js';
import { NUMBER_PREFIXES, NUMBER_REGISTRY_FILE } from '../store/index.js';
import {
  detectBrokenStoreFiles,
  detectCounterMismatch,
  detectDirs,
  detectLock,
  detectRegistryMismatch,
  detectRuns,
  detectSystemFiles,
  namespaceDir,
  parseIdNum,
} from './checks.js';
import { quarantineFile } from './quarantine.js';
import { exists, pad, readJsonRaw, readdirSafe, toDate } from './util.js';

export const REPAIRS = Object.freeze([
  { repairId: 'R-CFG-01', checkId: 'CFG-02', action: '隔离损坏配置并用可读字段 + 默认值重建', risk: 'medium' },
  { repairId: 'R-DIR-01', checkId: 'DIR-01', action: '只创建缺失的顶层目录', risk: 'low' },
  { repairId: 'R-SYS-01', checkId: 'SYS-01', action: '重建缺失/为空的系统文件（不覆盖有内容文件）', risk: 'low' },
  { repairId: 'R-IDX-01', checkId: 'IDX-01', action: '重建索引页与首页目录地图', risk: 'low' },
  { repairId: 'R-STORE-01', checkId: 'STORE-01', action: '隔离损坏 store 文件并从 .bak 恢复或重建空结构', risk: 'medium' },
  { repairId: 'R-STORE-02', checkId: 'STORE-02', action: '按磁盘文件重建 store 索引（补登记 + 标 missing）', risk: 'medium' },
  { repairId: 'R-STORE-03', checkId: 'STORE-03', action: '按实际最大编号校准计数器（只升不降）', risk: 'medium' },
  { repairId: 'R-RUN-01', checkId: 'RUN-01', action: '隔离损坏 run.json 并重建最小 run（abandoned）', risk: 'medium' },
  { repairId: 'R-RUN-02', checkId: 'RUN-02', action: '把心跳超期的 running run 收尾为 abandoned（endReason=doctor）', risk: 'medium' },
  { repairId: 'R-RUN-03', checkId: 'RUN-03', action: '释放残留锁（隔离 lock.json）', risk: 'low' },
  { repairId: 'R-RUN-04', checkId: 'RUN-04', action: '隔离损坏的 checkpoint.json', risk: 'medium' },
  { repairId: 'R-RUN-05', checkId: 'RUN-05', action: '重建 runs/archive/index.json', risk: 'low' },
  { repairId: 'R-REG-01', checkId: 'REG-01', action: '按磁盘文件重建 cards 注册表索引', risk: 'medium' },
  { repairId: 'R-REG-02', checkId: 'REG-02', action: '按磁盘文件重建 skills 注册表索引', risk: 'medium' },
  { repairId: 'R-REG-03', checkId: 'REG-03', action: '按磁盘文件重建 reports 注册表索引', risk: 'medium' },
  { repairId: 'R-REG-04', checkId: 'REG-04', action: '按磁盘文件重建 experts 注册表索引', risk: 'medium' },
]);

const META = new Map(REPAIRS.map((r) => [r.repairId, r]));

export function repairMeta(repairId) {
  return META.get(repairId) || null;
}

function iso(date) {
  return date.toISOString();
}

function nowIsoLocal(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

async function writeJsonGuarded(ctx, abs, value, force = true) {
  assertPathLength(ctx.root, path.relative(ctx.root, abs));
  await ensureDir(ctx.root, path.dirname(abs));
  await writeAtomic(abs, `${JSON.stringify(value, null, 2)}\n`, { force, root: ctx.root });
}

async function readText(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

// ───────────────────────────── 各 repair 的目标检测（幂等） ─────────────────────────────

async function planCfg(ctx) {
  if (!(await exists(ctx.settingsFile))) return null;
  const raw = readJsonRaw(ctx.settingsFile);
  if (raw.ok) return null;
  return { targets: [ctx.settingsFile], broken: true, text: await readText(ctx.settingsFile) };
}

async function planDirs(ctx) {
  const { missing } = await detectDirs(ctx);
  if (!missing.length) return null;
  return { targets: missing.map((name) => path.join(ctx.root, name)) };
}

async function planSys(ctx) {
  const bad = await detectSystemFiles(ctx);
  if (!bad.length) return null;
  return { targets: bad.map((b) => b.abs), files: bad };
}

async function planIndex(ctx) {
  const { detectIndexMismatch } = await import('./checks.js');
  const info = await detectIndexMismatch(ctx);
  if (!info.stale) return null;
  return { targets: [info.notesIndex] };
}

async function planStoreFiles(ctx) {
  const broken = await detectBrokenStoreFiles(ctx);
  if (!broken.length) return null;
  return { targets: broken.map((b) => b.abs), broken };
}

async function planStoreIndex(ctx, ns = null) {
  const namespaces = ns ? [ns] : (await import('./checks.js')).RECORD_NAMESPACES;
  const bad = [];
  for (const name of namespaces) {
    const m = await detectRegistryMismatch(ctx, name);
    if (!m.indexOk || m.idxMissing.length || m.orphans.length) bad.push(m);
  }
  if (!bad.length) return null;
  return { targets: bad.map((b) => b.indexAbs), mismatches: bad };
}

async function planCounters(ctx) {
  const info = await detectCounterMismatch(ctx);
  if (!info.regressed.length) return null;
  return { targets: [info.registryFile], info };
}

async function planRunJson(ctx) {
  const { runs } = await detectRuns(ctx);
  const bad = runs.filter((r) => r.runBroken);
  if (!bad.length) return null;
  return { targets: bad.map((r) => r.runJson), runs: bad };
}

async function planStaleRuns(ctx) {
  const { runs } = await detectRuns(ctx);
  const bad = runs.filter((r) => r.staleRunning);
  if (!bad.length) return null;
  return { targets: bad.map((r) => r.runJson), runs: bad };
}

async function planLock(ctx) {
  const info = await detectLock(ctx);
  if (!info.present) return null;
  if (info.ok) {
    const { runs } = await detectRuns(ctx);
    const target = runs.find((r) => r.id === info.lock.runId);
    const active = target && target.run && target.run.status === 'running' && !target.staleRunning;
    if (active) return null;
  }
  return { targets: [info.abs] };
}

async function planCheckpoints(ctx) {
  const { runs } = await detectRuns(ctx);
  const bad = runs.filter((r) => r.checkpointBroken);
  if (!bad.length) return null;
  return { targets: bad.map((r) => path.join(r.dir, 'checkpoint.json')), runs: bad };
}

async function planArchiveIndex(ctx) {
  const { archive } = await detectRuns(ctx);
  if (!(await exists(archive.abs))) return null;
  if (archive.ok) return null;
  return { targets: [archive.abs] };
}

async function planRegistry(ctx, ns) {
  const m = await detectRegistryMismatch(ctx, ns);
  if (m.indexOk && !m.idxMissing.length && !m.orphans.length) return null;
  return { targets: [m.indexAbs], mismatches: [m] };
}

export async function buildPlan(ctx, repairId) {
  const meta = repairMeta(repairId);
  if (!meta) return null;
  const detectors = {
    'R-CFG-01': planCfg,
    'R-DIR-01': planDirs,
    'R-SYS-01': planSys,
    'R-IDX-01': planIndex,
    'R-STORE-01': planStoreFiles,
    'R-STORE-02': () => planStoreIndex(ctx),
    'R-STORE-03': planCounters,
    'R-RUN-01': planRunJson,
    'R-RUN-02': planStaleRuns,
    'R-RUN-03': planLock,
    'R-RUN-04': planCheckpoints,
    'R-RUN-05': planArchiveIndex,
    'R-REG-01': () => planRegistry(ctx, 'cards'),
    'R-REG-02': () => planRegistry(ctx, 'skills'),
    'R-REG-03': () => planRegistry(ctx, 'reports'),
    'R-REG-04': () => planRegistry(ctx, 'experts'),
  };
  const found = await detectors[repairId](ctx);
  if (!found) return null;
  return {
    repairId,
    checkId: meta.checkId,
    action: meta.action,
    targets: found.targets.map((t) => String(t)),
    risk: meta.risk,
    found,
  };
}

// ───────────────────────────── 实际执行 ─────────────────────────────

async function rebuildStoreIndex(ctx, ns) {
  const m = await detectRegistryMismatch(ctx, ns);
  const ids = Array.from(new Set([...m.diskIds, ...m.indexIds])).sort();
  const missing = m.indexIds.filter((id) => !m.diskIds.includes(id));
  await writeJsonGuarded(ctx, m.indexAbs, { version: 1, ids, missing, updatedAt: iso(ctx.now) }, true);
  return { ids: ids.length, missing: missing.length };
}

const APPLY = {
  async 'R-CFG-01'(ctx, plan) {
    const target = plan.found.targets[0];
    // settings.json 位于 ~/.dsh/plugin-data（root 之外），不能进 root 隔离区：
    // 同目录改名保留为 .broken-<stamp>，绝不删除。
    const brokenPath = `${target}.broken-${nowIsoLocal(ctx.now).replace(/[^0-9]/g, '')}`;
    await fsp.rename(target, brokenPath);
    const movedTo = [brokenPath];
    const rootMatch = /"root"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(plan.found.text || '');
    let root = rootMatch ? rootMatch[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"') : null;
    if (root && !path.isAbsolute(root)) root = null;
    const rebuilt = {
      root,
      rootConfirmedAt: root ? iso(ctx.now) : null,
      rootRiskAck: root ? { at: iso(ctx.now), version: RISK_ACK_VERSION, textHash: hashAckText(RISK_ACK_TEXT) } : null,
      updatedAt: iso(ctx.now),
    };
    // 配置在 ~/.dsh/plugin-data（root 之外），不经 root 守卫；直接原子写回同目录。
    await fsp.writeFile(target, `${JSON.stringify(rebuilt, null, 2)}\n`, 'utf8');
    return { status: 'applied', detail: `已隔离损坏配置并重建${root ? `（保留 root=${root}）` : '（无可用 root）'}`, movedTo };
  },

  async 'R-DIR-01'(ctx, plan) {
    for (const dir of plan.found.targets) await ensureDir(ctx.root, dir);
    return { status: 'applied', detail: `创建 ${plan.found.targets.length} 个缺失目录` };
  },

  async 'R-SYS-01'(ctx, plan) {
    const cfg = ctx.cfg || (await getMode(ctx.mode));
    const presets = await loadPresets();
    const date = nowIsoLocal(ctx.now).slice(0, 10);
    const status = (ctx.vault && ctx.vault.status) || 'scaffolded';
    const counts = {};
    for (const item of plan.found.files) {
      if (item.kind === 'moc') {
        const content = renderMoc({ mode: ctx.mode, cfg, core: cfg.core, root: ctx.root, date, status, counts });
        await writeJsonGuardedText(ctx, item.abs, content);
      } else {
        const page = cfg.extraIndex.find((x) => path.join(cfg.indexDir, x.as) === item.rel);
        const kind = page ? page.kind : 'map';
        const content = renderExtraIndex(kind, { cfg, core: cfg.core, presets, date });
        await writeJsonGuardedText(ctx, item.abs, content);
      }
    }
    return { status: 'applied', detail: `重建 ${plan.found.files.length} 个系统文件` };
  },

  async 'R-IDX-01'(ctx) {
    await reindex({ root: ctx.root });
    return { status: 'applied', detail: '已重建索引页与首页目录地图' };
  },

  async 'R-STORE-01'(ctx, plan) {
    const movedTo = [];
    for (const item of plan.found.broken) {
      movedTo.push(await quarantineFile({ root: ctx.root, absPath: item.abs, now: ctx.now }));
      const bak = `${item.abs}.bak`;
      if (await exists(bak)) {
        await fsp.copyFile(bak, item.abs);
        continue;
      }
      const base = path.basename(item.abs);
      if (base === 'index.json') await writeJsonGuarded(ctx, item.abs, { version: 1, ids: [], updatedAt: iso(ctx.now) }, true);
      else if (base === NUMBER_REGISTRY_FILE) {
        const counters = {};
        NUMBER_PREFIXES.forEach((p) => { counters[p] = 0; });
        await writeJsonGuarded(ctx, item.abs, { schemaVersion: 1, counters, updatedAt: iso(ctx.now) }, true);
      } else await writeJsonGuarded(ctx, item.abs, { schemaVersion: 1 }, true);
    }
    return { status: 'applied', detail: `隔离并重建 ${plan.found.broken.length} 个 store 文件`, movedTo };
  },

  async 'R-STORE-02'(ctx, plan) {
    let ids = 0;
    let missing = 0;
    for (const m of plan.found.mismatches) {
      const r = await rebuildStoreIndex(ctx, m.ns);
      ids += r.ids;
      missing += r.missing;
    }
    return { status: 'applied', detail: `重建 ${plan.found.mismatches.length} 个命名空间索引（${ids} 条，missing ${missing}）` };
  },

  async 'R-STORE-03'(ctx, plan) {
    const info = plan.found.info;
    const raw = readJsonRaw(info.registryFile);
    const base = raw.ok && raw.value && typeof raw.value === 'object' ? raw.value : { schemaVersion: 1 };
    const counters = { ...(base.counters || {}) };
    NUMBER_PREFIXES.forEach((p) => { counters[p] = Number.isFinite(counters[p]) ? counters[p] : 0; });
    for (const r of info.regressed) counters[r.prefix] = Math.max(counters[r.prefix], r.actual);
    await writeJsonGuarded(ctx, info.registryFile, { ...base, schemaVersion: 1, counters, updatedAt: iso(ctx.now) }, true);
    return { status: 'applied', detail: `校准 ${info.regressed.map((r) => r.prefix).join('、')} 计数器` };
  },

  async 'R-RUN-01'(ctx, plan) {
    const movedTo = [];
    for (const r of plan.found.runs) {
      const text = await readText(r.runJson);
      const titleMatch = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
      movedTo.push(await quarantineFile({ root: ctx.root, absPath: r.runJson, now: ctx.now }));
      const minimal = {
        id: r.id,
        kind: 'unknown',
        title: titleMatch ? titleMatch[1] : r.id,
        status: 'abandoned',
        degraded: true,
        startedAt: iso(ctx.now),
        endedAt: iso(ctx.now),
        summary: 'doctor 重建（原 run.json 损坏）',
        root: ctx.root,
        endReason: 'doctor',
      };
      await writeJsonGuarded(ctx, r.runJson, minimal, true);
    }
    return { status: 'applied', detail: `隔离并重建 ${plan.found.runs.length} 个 run.json`, movedTo };
  },

  async 'R-RUN-02'(ctx, plan) {
    for (const r of plan.found.runs) {
      const raw = readJsonRaw(r.runJson);
      const run = raw.ok && raw.value && typeof raw.value === 'object' ? raw.value : { id: r.id };
      run.status = 'abandoned';
      run.previousStatus = 'stalled';
      run.endReason = 'doctor';
      run.endedAt = iso(ctx.now);
      await writeJsonGuarded(ctx, r.runJson, run, true);
      try {
        const index = readIndex(ctx.root);
        const entry = index.runs.find((x) => x.id === r.id);
        if (entry) {
          entry.status = 'abandoned';
          entry.endedAt = iso(ctx.now);
          writeIndex(ctx.root, index);
        }
      } catch {
        /* 索引更新失败不影响 run 收尾 */
      }
    }
    return { status: 'applied', detail: `收尾 ${plan.found.runs.length} 个心跳超期的 run（stalled→abandoned）` };
  },

  async 'R-RUN-03'(ctx, plan) {
    const movedTo = [await quarantineFile({ root: ctx.root, absPath: plan.found.targets[0], now: ctx.now })];
    return { status: 'applied', detail: '已释放残留锁（隔离 lock.json）', movedTo };
  },

  async 'R-RUN-04'(ctx, plan) {
    const movedTo = [];
    for (const targets of plan.found.targets) movedTo.push(await quarantineFile({ root: ctx.root, absPath: targets, now: ctx.now }));
    return { status: 'applied', detail: `隔离 ${movedTo.length} 个损坏 checkpoint`, movedTo };
  },

  async 'R-RUN-05'(ctx, plan) {
    const main = readIndex(ctx.root);
    const mainIds = new Set(main.runs.map((x) => x.id));
    const archived = [];
    for (const ent of await readdirSafe(path.join(ctx.root, '.jkkb', 'runs'))) {
      if (!ent.isDirectory() || ent.name === 'archive') continue;
      if (mainIds.has(ent.name)) continue;
      const raw = readJsonRaw(runFile(ctx.root, ent.name));
      if (!raw.ok) continue;
      archived.push({
        id: ent.name,
        title: raw.value.title || ent.name,
        kind: raw.value.kind || 'unknown',
        status: raw.value.status || 'abandoned',
        startedAt: raw.value.startedAt || null,
        endedAt: raw.value.endedAt || null,
      });
    }
    await writeJsonAtomic(archiveIndexPath(ctx.root), { version: 1, runs: archived }, ctx.root);
    return { status: 'applied', detail: `重建滚动归档索引（${archived.length} 条）` };
  },

  async 'R-REG-01'(ctx) { return rebuildOneRegistry(ctx, 'cards'); },
  async 'R-REG-02'(ctx) { return rebuildOneRegistry(ctx, 'skills'); },
  async 'R-REG-03'(ctx) { return rebuildOneRegistry(ctx, 'reports'); },
  async 'R-REG-04'(ctx) { return rebuildOneRegistry(ctx, 'experts'); },
};

async function rebuildOneRegistry(ctx, ns) {
  const r = await rebuildStoreIndex(ctx, ns);
  return { status: 'applied', detail: `重建 ${ns} 索引（${r.ids} 条，missing ${r.missing}）` };
}

async function writeJsonGuardedText(ctx, abs, text) {
  assertPathLength(ctx.root, path.relative(ctx.root, abs));
  await ensureDir(ctx.root, path.dirname(abs));
  await writeAtomic(abs, String(text), { force: true, root: ctx.root });
}

export async function applyRepair(ctx, repairId, plan) {
  const fn = APPLY[repairId];
  if (!fn) return { repairId, status: 'failed', detail: `未知修复项：${repairId}` };
  try {
    const result = await fn(ctx, plan);
    return { repairId, ...result };
  } catch (err) {
    return { repairId, status: 'failed', detail: `${err && err.code ? err.code + ': ' : ''}${err && err.message ? err.message : err}` };
  }
}
