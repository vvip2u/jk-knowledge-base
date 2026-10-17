/**
 * 运行记录（trace）—— 单一真源：<根目录>/.jkkb/runs/。
 *
 *   index.json             { version:1, runs:[{ id,title,kind,status,startedAt,endedAt,stepCount,currentStep,degraded }] }
 *   <runId>/run.json        { id,kind,title,status,degraded,startedAt,endedAt,summary,root,
 *                             heartbeatAt,heartbeatBy,deadlineAt,cancelRequestedAt,acceptanceFailed,engineVersion }
 *   <runId>/steps.jsonl     每行一个 step
 *   <root>/.jkkb/lock.json  { runId,pid,bootId,createdAt,heartbeatAt,host }（同一根目录只允许一个 run）
 *
 * 约束：
 * - 不缓存：`GET /runs` 直接读 index.json，避免出现第二个真源。
 * - index.json / run.json 走 tmp→rename 原子写；steps 只追加，按 run 串行化（进程内队列）。
 * - 任何读失败 / 坏 JSON 都回落成"空记录"，绝不把坏数据抛给调用方。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import * as pathGuard from './engine/guard.js';

export const INDEX_VERSION = 1;
// running 以外的全部都是终态（含超时 / 卡死 / 遗弃）。
export const RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled', 'timed_out', 'stalled', 'abandoned'];
export const TERMINAL_RUN_STATUSES = RUN_STATUSES.filter((status) => status !== 'running');
export const STEP_STATUSES = ['start', 'ok', 'skip', 'error'];
export const MAX_RUNS_LISTED = 50;
// index.json 滚动上限：只保留最近 200 条，更早的进 archive/index.json（run 目录一个都不删）。
export const MAX_INDEX_ENTRIES = 200;
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;
export const MAX_STEPS_READ = 5000;
export const RUNS_REL_DIR = path.join('.jkkb', 'runs');
export const LOCK_REL_PATH = path.join('.jkkb', 'lock.json');

// 预算（毫秒）：bootstrap 20min / reindex 10min / verify 5min。
export const RUN_BUDGET_MS = {
  bootstrap: 20 * 60 * 1000,
  reindex: 10 * 60 * 1000,
  verify: 5 * 60 * 1000,
};
export const DEFAULT_RUN_BUDGET_MS = 20 * 60 * 1000;

// 静默阈值（毫秒）：agent 120s、engine 300s。
export const HEARTBEAT_SILENCE_MS = { agent: 120 * 1000, engine: 300 * 1000 };
export const DEFAULT_HEARTBEAT_BY = 'engine';
// 锁心跳过期阈值：120s，过期可抢占。
export const LOCK_STALE_MS = 120 * 1000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function isSafeRunId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function runsDir(root) {
  return path.join(root, RUNS_REL_DIR);
}
export function indexFile(root) {
  return path.join(runsDir(root), 'index.json');
}
export function archiveIndexPath(root) {
  return path.join(runsDir(root), 'archive', 'index.json');
}
export function runDir(root, id) {
  return path.join(runsDir(root), sanitizeSegment(id));
}
export function runFile(root, id) {
  return path.join(runDir(root, id), 'run.json');
}
export function stepsFile(root, id) {
  return path.join(runDir(root, id), 'steps.jsonl');
}

export function runIdFor(kind, now) {
  const at = now instanceof Date ? now : new Date();
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', 'T');
  return String(kind) + '-' + stamp + '-' + crypto.randomBytes(3).toString('hex');
}

function isoOrNull(value) {
  if (typeof value !== 'string' || !value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (err) {
    return fallback;
  }
}

/**
 * 每次写盘前的路径守卫：单一真源是 host/engine/guard.js 的 assertWritableSync。
 * 守卫抛错不吞——直接透传它的 code（PATH_ESCAPE / PATH_DENIED），由上层把 run 落 failed。
 */
/** 路径包含判定：禁止字符串前缀比较；win32/darwin 比较前统一小写。 */
function stripWin32LongPrefix(value) {
  return process.platform === 'win32' ? String(value).replace(/^\\\\\?\\/, '') : String(value);
}

export function normalizePathForCompare(value) {
  const abs = path.resolve(stripWin32LongPrefix(value));
  return process.platform === 'linux' ? abs : abs.toLowerCase();
}

export function isInsidePath(root, target) {
  const rel = path.relative(normalizePathForCompare(root), normalizePathForCompare(target));
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const SEGMENT_MAX = 200;

function clampSegment(name) {
  let out = String(name);
  const tooLong = (v) => Buffer.byteLength(v, 'utf8') > SEGMENT_MAX || v.length > SEGMENT_MAX;
  while (out.length > 0 && tooLong(out)) out = out.slice(0, -1);
  return out.length > 0 ? out : '_';
}

/** 目录 / 文件名消毒：非法字符、结尾空格与点、Windows 保留名、双长度上限。 */
export function sanitizeSegment(raw) {
  let name = String(raw === null || raw === undefined ? '' : raw);
  name = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_');
  name = name.replace(/[. ]+$/, '');
  if (name === '' || name === '.' || name === '..') name = '_';
  if (WINDOWS_RESERVED.test(name)) name = name + '_';
  return clampSegment(name);
}

/** win32 路径总长预判：root + 相对路径 > 240 直接拒绝，避免运行到一半 ENAMETOOLONG。 */
export function assertPathLength(root, target, platform) {
  const osName = platform || process.platform;
  if (osName !== 'win32') return;
  const rel = path.relative(path.resolve(String(root)), path.resolve(String(target)));
  const total = String(root).length + (rel ? rel.length + 1 : 0);
  if (total > 240) {
    const err = new Error('路径总长超过 240（' + total + '）：' + target);
    err.code = 'PATH_TOO_LONG';
    throw err;
  }
}

function sleepSync(ms) {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (err) { /* 没有 SharedArrayBuffer 就不退避 */ }
}

/**
 * 原子替换：POSIX 直接 rename；win32 覆盖已存在文件会 EEXIST/EPERM，
 * 先 unlink(dest) 再 rename，并做 3 次指数退避重试。
 */
export function replaceFile(tmp, dest) {
  const backoff = [0, 10, 40];
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    sleepSync(backoff[attempt]);
    try {
      fs.renameSync(tmp, dest);
      return { ok: true };
    } catch (err) {
      last = err;
      const code = err && err.code;
      const windowsOverwrite = process.platform === 'win32' && (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES');
      if (windowsOverwrite) {
        try { fs.unlinkSync(dest); } catch (unlinkErr) { if (unlinkErr && unlinkErr.code !== 'ENOENT') { last = unlinkErr; continue; } }
        try {
          fs.renameSync(tmp, dest);
          return { ok: true };
        } catch (retryErr) {
          last = retryErr;
          continue;
        }
      }
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EEXIST' || code === 'EACCES') continue;
      break;
    }
  }
  return {
    ok: false,
    code: (last && last.code) || 'replace-failed',
    message: String(last && last.message ? last.message : last || 'replace failed'),
  };
}

/** 删除文件（Windows 可能 EBUSY）：3 次退避重试，失败返回明确错误码，绝不抛。 */
export function removeFileWithRetry(file) {
  const backoff = [0, 10, 40];
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    sleepSync(backoff[attempt]);
    try {
      fs.unlinkSync(file);
      return { ok: true, removed: true };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: true, removed: false };
      last = err;
    }
  }
  return {
    ok: false,
    code: 'lock-busy',
    message: String(last && last.message ? last.message : last || 'unlink failed'),
  };
}

function isGuardError(err) {
  const code = err && err.code;
  return code === 'PATH_ESCAPE' || code === 'PATH_DENIED' || code === 'PATH_GUARD_UNAVAILABLE';
}

function guardWrite(root, target) {
  const sync = pathGuard && typeof pathGuard.assertWritableSync === 'function' ? pathGuard.assertWritableSync : null;
  if (typeof sync !== 'function') {
    const err = new Error('路径守卫不可用：host/engine/guard.js 缺少 assertWritableSync');
    err.code = 'PATH_GUARD_UNAVAILABLE';
    throw err;
  }
  assertPathLength(root, target);
  sync(root, target);
}

export function writeJsonAtomic(file, value, root) {
  if (typeof root !== 'string' || root === '') {
    const err = new Error('writeJsonAtomic 需要 root 才能过路径守卫：' + file);
    err.code = 'PATH_DENIED';
    throw err;
  }
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp');
  // 校验最终目标即可：tmp 与目标同目录、同一次 mkdir，目标被拒时目录根本不会被创建。
  // （守卫的 .jkkb 白名单只认固定文件名，随机 tmp 名会被误判，故不单独校验 tmp。）
  guardWrite(root, file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    const replaced = replaceFile(tmp, file);
    if (!replaced.ok) {
      try { fs.unlinkSync(tmp); } catch (cleanupErr) { /* tmp 可能已被移走 */ }
      return false;
    }
    return true;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (cleanupErr) { /* tmp 可能没建出来 */ }
    return false;
  }
}

function normalizeRunEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isSafeRunId(raw.id)) return null;
  const status = RUN_STATUSES.indexOf(raw.status) >= 0 ? raw.status : 'running';
  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : '',
    kind: typeof raw.kind === 'string' ? raw.kind : 'bootstrap',
    mode: raw.mode === 'topic' ? 'topic' : 'asset',
    status: status,
    startedAt: isoOrNull(raw.startedAt) || '',
    endedAt: isoOrNull(raw.endedAt),
    stepCount: typeof raw.stepCount === 'number' && raw.stepCount >= 0 ? Math.floor(raw.stepCount) : 0,
    currentStep: typeof raw.currentStep === 'string' ? raw.currentStep : '',
    degraded: typeof raw.degraded === 'string' ? raw.degraded : null,
    acceptanceFailed: raw.acceptanceFailed === true,
    usageSource: normalizeUsageSource(raw.usageSource),
    inputTokens: Number.isFinite(raw.inputTokens) ? raw.inputTokens : null,
    outputTokens: Number.isFinite(raw.outputTokens) ? raw.outputTokens : null,
  };
}

export function readIndex(root) {
  const raw = readJson(indexFile(root), null);
  if (!raw || raw.version !== INDEX_VERSION || !Array.isArray(raw.runs)) return { version: INDEX_VERSION, runs: [] };
  return { version: INDEX_VERSION, runs: raw.runs.map(normalizeRunEntry).filter((entry) => entry !== null) };
}

function writeIndexRaw(root, runs) {
  return writeJsonAtomic(indexFile(root), { version: INDEX_VERSION, runs: runs }, root);
}

export function readArchiveIndex(root) {
  const raw = readJson(archiveIndexPath(root), null);
  if (!raw || raw.version !== INDEX_VERSION || !Array.isArray(raw.runs)) return { version: INDEX_VERSION, runs: [] };
  return { version: INDEX_VERSION, runs: raw.runs.map(normalizeRunEntry).filter((entry) => entry !== null) };
}

/** 把溢出的条目合并进 archive/index.json（按 id 去重，已有条目保持原顺序）。 */
export function archiveRuns(root, overflow) {
  if (!Array.isArray(overflow) || overflow.length === 0) return readArchiveIndex(root);
  const current = readArchiveIndex(root);
  const seen = new Set(current.runs.map((entry) => entry.id));
  const merged = current.runs.slice();
  overflow.forEach((entry) => {
    if (!entry || seen.has(entry.id)) return;
    seen.add(entry.id);
    merged.push(entry);
  });
  writeJsonAtomic(archiveIndexPath(root), { version: INDEX_VERSION, runs: merged }, root);
  return { version: INDEX_VERSION, runs: merged };
}

export function writeIndex(root, index) {
  const runs = Array.isArray(index && index.runs) ? index.runs : [];
  if (runs.length <= MAX_INDEX_ENTRIES) return writeIndexRaw(root, runs);
  const kept = runs.slice(0, MAX_INDEX_ENTRIES);
  const overflow = runs.slice(MAX_INDEX_ENTRIES);
  archiveRuns(root, overflow);
  return writeIndexRaw(root, kept);
}

/** 按 startedAt 倒序；同 startedAt 时按 id 倒序，保证分页稳定（不漏不重）。 */
function sortedRuns(root) {
  return readIndex(root).runs.slice().sort((a, b) => {
    const byTime = String(b.startedAt).localeCompare(String(a.startedAt));
    return byTime !== 0 ? byTime : String(b.id).localeCompare(String(a.id));
  });
}

/** 按 startedAt 倒序，最多 50 条。 */
export function listRuns(root) {
  return sortedRuns(root).slice(0, MAX_RUNS_LISTED);
}

export function parsePageLimit(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_PAGE_LIMIT;
  return Math.min(MAX_PAGE_LIMIT, Math.floor(value));
}

/**
 * 分页：before 可以是 runId（优先）或 ISO 时间戳；二者都按「严格更早」取。
 * 同 startedAt 并列时用 (startedAt, id) 倒序做稳定排序，游标用 runId 定位，因此不会漏也不会重。
 */
export function readRunsPage(root, options) {
  const opts = options || {};
  const limit = parsePageLimit(opts.limit === undefined ? DEFAULT_PAGE_LIMIT : opts.limit);
  const all = sortedRuns(root);
  let startIndex = 0;
  const before = typeof opts.before === 'string' ? opts.before.trim() : '';
  if (before) {
    const byId = all.findIndex((entry) => entry.id === before);
    if (byId >= 0) {
      startIndex = byId + 1;
    } else {
      const ts = Date.parse(before);
      if (Number.isFinite(ts)) {
        const found = all.findIndex((entry) => Date.parse(entry.startedAt || '') < ts);
        startIndex = found >= 0 ? found : all.length;
      } else {
        startIndex = all.length; // 无法识别的游标 → 视作到底
      }
    }
  }
  const slice = all.slice(startIndex, startIndex + limit);
  const nextBefore = (startIndex + limit < all.length && slice.length > 0) ? slice[slice.length - 1].id : null;
  return { runs: slice, nextBefore: nextBefore, total: all.length };
}

export function findRunning(root) {
  return readIndex(root).runs.filter((entry) => entry.status === 'running')[0] || null;
}

export function budgetFor(kind) {
  return RUN_BUDGET_MS[kind] || DEFAULT_RUN_BUDGET_MS;
}

// ───────────────────────────── 锁（<root>/.jkkb/lock.json） ─────────────────────────────
export function lockPath(root) {
  return path.join(root, LOCK_REL_PATH);
}

export function readLock(root) {
  const raw = readJson(lockPath(root), null);
  if (!raw || typeof raw !== 'object' || !isSafeRunId(raw.runId)) return null;
  if (!isoOrNull(raw.heartbeatAt)) return null;
  return {
    runId: raw.runId,
    pid: typeof raw.pid === 'number' ? raw.pid : null,
    bootId: typeof raw.bootId === 'string' ? raw.bootId : null,
    createdAt: isoOrNull(raw.createdAt),
    heartbeatAt: isoOrNull(raw.heartbeatAt),
    host: typeof raw.host === 'string' ? raw.host : null,
  };
}

function createLockExclusive(file, lock, root) {
  guardWrite(root, file);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(lock, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
}

function secondsOf(ms) {
  return Math.round((Number.isFinite(ms) ? ms : 0) / 1000);
}

/**
 * 双条件判定：锁心跳与 run 心跳**同时**过期才允许抢占。
 * 只满足一个 → 保持 lock-held，并说明是哪一侧还新鲜。
 */
function lockFacts(root, existing, nowMs) {
  const lockAge = Math.max(0, nowMs - Date.parse(existing.heartbeatAt));
  const lockFresh = lockAge <= LOCK_STALE_MS;
  const run = readJson(runFile(root, existing.runId), null);
  const runExists = !!(run && run.id === existing.runId);
  const runRunning = runExists && run.status === 'running';
  let runAge = null;
  if (runExists) {
    const hb = Date.parse(run.heartbeatAt || run.startedAt || '');
    if (Number.isFinite(hb)) runAge = Math.max(0, nowMs - hb);
  }
  const runFresh = runRunning && runAge !== null && runAge <= LOCK_STALE_MS;
  const takeover = !lockFresh && !runFresh;
  let reason = null;
  let message = '';
  if (!takeover) {
    if (lockFresh) {
      reason = 'lock-fresh';
      message = '锁心跳 ' + secondsOf(lockAge) + 's 前（新鲜），拒绝抢占';
    } else {
      reason = 'run-fresh';
      message = '锁已过期，但 run 心跳 ' + secondsOf(runAge) + 's 前（新鲜），拒绝抢占';
    }
  }
  return {
    lockAge: lockAge,
    runAge: runAge,
    runExists: runExists,
    runRunning: runRunning,
    lockFresh: lockFresh,
    runFresh: runFresh,
    takeover: takeover,
    reason: reason,
    message: message,
  };
}

/**
 * 抢占式取锁：
 * - 没有锁 → 直接拿到；
 * - 锁属于自己 → 刷新心跳后拿到；
 * - 别人的锁且心跳 < LOCK_STALE_MS → { ok:false, code:'lock-held', lock, ageMs }；
 * - 别人的锁且心跳过期 → 抢占，返回 previous（调用方据此把旧 run 标 stalled）。
 */
export function acquireLock(args) {
  const a = args || {};
  const root = a.root;
  const runId = a.runId;
  if (!root || !isSafeRunId(runId)) return { ok: false, code: 'lock-invalid', message: 'root 或 runId 非法' };
  const nowMs = typeof a.now === 'number' ? a.now : Date.now();
  const at = new Date(nowMs).toISOString();
  const file = lockPath(root);
  const lock = {
    runId: runId,
    pid: typeof a.pid === 'number' ? a.pid : process.pid,
    bootId: typeof a.bootId === 'string' ? a.bootId : null,
    createdAt: at,
    heartbeatAt: at,
    host: typeof a.host === 'string' ? a.host : os.hostname(),
  };

  try {
    if (createLockExclusive(file, lock, root)) return { ok: true, lock: lock, previous: null, ageMs: 0 };
  } catch (err) {
    if (isGuardError(err)) throw err; // 守卫拒绝不吞：透传 PATH_ESCAPE / PATH_DENIED
    return { ok: false, code: 'lock-write-failed', message: String(err && err.message ? err.message : err) };
  }

  const existing = readLock(root);
  if (!existing) {
    // 坏锁 / 空文件：删掉重试一次（Windows 上可能 EBUSY）。
    const removedBad = removeFileWithRetry(file);
    if (!removedBad.ok && !removedBad.removed) {
      return { ok: false, code: 'lock-busy', lock: null, message: removedBad.message };
    }
    try {
      if (createLockExclusive(file, lock, root)) return { ok: true, lock: lock, previous: null, ageMs: 0 };
    } catch (err) {
      if (isGuardError(err)) throw err;
    }
    return { ok: false, code: 'lock-held', lock: readLock(root), ageMs: 0 };
  }

  if (existing.runId === runId) {
    writeJsonAtomic(file, Object.assign({}, existing, { heartbeatAt: at }), root);
    return { ok: true, lock: Object.assign({}, existing, { heartbeatAt: at }), previous: null, ageMs: 0 };
  }

  const facts = lockFacts(root, existing, nowMs);
  if (!facts.takeover) {
    return {
      ok: false,
      code: 'lock-held',
      lock: existing,
      ageMs: facts.lockAge,
      reason: facts.reason,
      message: facts.message,
    };
  }

  // 双过期（或 run 已终态 / 不存在）：抢占。
  const removed = removeFileWithRetry(file);
  if (!removed.ok) {
    return { ok: false, code: 'lock-busy', lock: existing, ageMs: facts.lockAge, message: removed.message };
  }
  try {
    if (createLockExclusive(file, lock, root)) return { ok: true, lock: lock, previous: existing, ageMs: facts.lockAge };
  } catch (err) {
    if (isGuardError(err)) throw err;
  }
  return { ok: false, code: 'lock-held', lock: readLock(root), ageMs: facts.lockAge };
}

export function releaseLock(args) {
  const a = args || {};
  const root = a.root;
  if (!root) return { ok: false, code: 'lock-invalid', message: 'root 非法' };
  const existing = readLock(root);
  if (!existing) return { ok: true, released: false };
  if (typeof a.runId === 'string' && a.runId && existing.runId !== a.runId) {
    return { ok: false, code: 'lock-owner-mismatch', lock: existing };
  }
  const removed = removeFileWithRetry(lockPath(root));
  if (!removed.ok) return { ok: false, code: 'lock-busy', message: removed.message };
  return { ok: true, released: removed.removed === true };
}

// ───────────────────────────── 心跳与收割 ─────────────────────────────
/** 更新 heartbeatAt + heartbeatBy；run 不存在或已终态则跳过（返回 null，不报错）。 */
export function touchRun(root, runId, by, nowMs) {
  if (!root || !isSafeRunId(runId)) return null;
  const run = readJson(runFile(root, runId), null);
  if (!run || run.id !== runId) return null;
  if (run.status !== 'running') return null;
  const at = new Date(typeof nowMs === 'number' ? nowMs : Date.now()).toISOString();
  const heartbeatBy = by === 'agent' ? 'agent' : 'engine';
  const next = Object.assign({}, run, { heartbeatAt: at, heartbeatBy: heartbeatBy });
  writeJsonAtomic(runFile(root, runId), next, root);

  // 锁与 run 同源：持有该 run 的锁时用同一个 now 刷新 lock.json。
  // 锁刷新失败不影响心跳本身（只记 warning）。
  let lockRefreshed = false;
  let warning = null;
  try {
    const lock = readLock(root);
    if (lock && lock.runId === runId) {
      const ok = writeJsonAtomic(lockPath(root), Object.assign({}, lock, { heartbeatAt: at }), root);
      lockRefreshed = ok === true;
      if (!ok) warning = 'lock-heartbeat-write-failed';
    }
  } catch (err) {
    warning = (err && err.code ? err.code + ': ' : '') + (err && err.message ? err.message : String(err));
  }
  return { runId: runId, heartbeatAt: at, heartbeatBy: heartbeatBy, lockRefreshed: lockRefreshed, warning: warning };
}

/**
 * 收割 running：deadline 超 → timed_out；静默超阈值（agent 120s / engine 300s）→ stalled；
 * run.json 丢失 → abandoned。被收敛的 run 若持有锁则释放，返回被收敛的列表。
 */
export function reap(root, options) {
  const opts = options || {};
  if (!root) return [];
  const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();
  const silence = Object.assign({}, HEARTBEAT_SILENCE_MS, opts.silenceMs || {});
  const index = readIndex(root);
  const changed = [];
  const at = new Date(nowMs).toISOString();

  index.runs.forEach((entry) => {
    if (entry.status !== 'running') return;
    const run = readJson(runFile(root, entry.id), null);
    if (!run || run.id !== entry.id) {
      entry.status = 'abandoned';
      entry.endedAt = at;
      changed.push({ id: entry.id, status: 'abandoned' });
      return;
    }
    const deadlineMs = Date.parse(run.deadlineAt || '');
    const heartbeatMs = Date.parse(run.heartbeatAt || run.startedAt || '');
    const by = run.heartbeatBy === 'agent' ? 'agent' : 'engine';

    let status = null;
    const patch = { endedAt: at };
    if (Number.isFinite(deadlineMs) && nowMs > deadlineMs) {
      status = 'timed_out';
      patch.timedOutAt = at;
      patch.summary = '超过运行预算（deadline=' + run.deadlineAt + '）';
    } else if (Number.isFinite(heartbeatMs) && nowMs - heartbeatMs > (silence[by] || silence.engine)) {
      status = 'stalled';
      patch.stalledAt = at;
      patch.summary = '心跳静默超阈值（' + by + '）';
    }
    if (!status) return;

    writeJsonAtomic(runFile(root, entry.id), Object.assign({}, run, patch, { status: status }), root);
    entry.status = status;
    entry.endedAt = at;
    changed.push({ id: entry.id, status: status, heartbeatBy: by });

    const lock = readLock(root);
    if (lock && lock.runId === entry.id) {
      removeFileWithRetry(lockPath(root)); // 失败也继续收割（EBUSY 不抛）
    }
  });

  if (changed.length > 0) writeIndex(root, index);
  return changed;
}

export function readRun(root, id) {
  if (!isSafeRunId(id)) return null;
  const run = readJson(runFile(root, id), null);
  if (!run || run.id !== id) return null;
  const steps = readSteps(root, id);
  return {
    run: {
      id: run.id,
      kind: typeof run.kind === 'string' ? run.kind : 'bootstrap',
      mode: run.mode === 'topic' ? 'topic' : 'asset',
      title: typeof run.title === 'string' ? run.title : '',
      status: RUN_STATUSES.indexOf(run.status) >= 0 ? run.status : 'running',
      degraded: typeof run.degraded === 'string' ? run.degraded : null,
      startedAt: isoOrNull(run.startedAt) || '',
      endedAt: isoOrNull(run.endedAt),
      summary: typeof run.summary === 'string' ? run.summary : '',
      root: typeof run.root === 'string' ? run.root : '',
      warnings: Array.isArray(run.warnings) ? run.warnings.map(String) : [],
      // S1 监督字段
      heartbeatAt: isoOrNull(run.heartbeatAt) || isoOrNull(run.startedAt),
      heartbeatBy: run.heartbeatBy === 'agent' || run.heartbeatBy === 'engine' ? run.heartbeatBy : null,
      deadlineAt: isoOrNull(run.deadlineAt),
      cancelRequestedAt: isoOrNull(run.cancelRequestedAt),
      engineVersion: typeof run.engineVersion === 'string' ? run.engineVersion : null,
      schemaVersion: Number.isFinite(run.schemaVersion) ? run.schemaVersion : 1,
      resumedFrom: typeof run.resumedFrom === 'string' ? run.resumedFrom : null,
      stalledAt: isoOrNull(run.stalledAt),
      timedOutAt: isoOrNull(run.timedOutAt),
      acceptance: normalizeAcceptance(run.acceptance),
      acceptanceFailed: run.acceptanceFailed === true,
      usage: normalizeUsage(run.usage),
      usageSource: normalizeUsageSource(run.usageSource),
    },
    steps: steps,
  };
}

export function readSteps(root, id) {
  try {
    const text = fs.readFileSync(stepsFile(root, id), 'utf8');
    const out = [];
    text.split('\n').forEach((rawLine) => {
      // 统一容忍 \r\n（Windows 上搬运 / 手改过的 steps.jsonl）。
      const line = rawLine.replace(/\r$/, '');
      if (!line.trim() || out.length >= MAX_STEPS_READ) return;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') out.push(parsed);
      } catch (err) { /* 坏行跳过，不影响其余步骤 */ }
    });
    return out;
  } catch (err) {
    return [];
  }
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pick = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const usage = {
    inputTokens: pick(raw.inputTokens),
    outputTokens: pick(raw.outputTokens),
    cacheReadTokens: pick(raw.cacheReadTokens),
    cacheWriteTokens: pick(raw.cacheWriteTokens),
  };
  const hasValue = Object.keys(usage).some((key) => usage[key] !== null);
  return hasValue ? usage : null;
}

function normalizeUsageSource(raw) {
  return raw === 'agent' || raw === 'degraded' ? raw : 'unavailable';
}

function normalizeAcceptance(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.ok !== 'boolean') return null;
  const errors = Array.isArray(raw.errors)
    ? raw.errors.filter((item) => item && typeof item === 'object').map((item) => ({
      id: typeof item.id === 'string' ? item.id : 'acceptance',
      level: typeof item.level === 'string' ? item.level : 'error',
      message: typeof item.message === 'string' ? item.message : '',
      ...(typeof item.fix === 'string' ? { fix: item.fix } : {}),
    }))
    : [];
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((item) => item && typeof item === 'object').map((item) => ({
      id: typeof item.id === 'string' ? item.id : 'acceptance',
      level: typeof item.level === 'string' ? item.level : 'warn',
      message: typeof item.message === 'string' ? item.message : '',
      ...(typeof item.fix === 'string' ? { fix: item.fix } : {}),
    }))
    : [];
  return {
    ok: raw.ok,
    checkedAt: isoOrNull(raw.checkedAt) || '',
    errors: errors,
    warnings: warnings,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
  };
}

export function normalizeStep(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const now = new Date().toISOString();
  return {
    id: typeof s.id === 'string' && s.id ? s.id : 'step-' + crypto.randomBytes(6).toString('hex'),
    parentId: typeof s.parentId === 'string' && s.parentId ? s.parentId : null,
    role: typeof s.role === 'string' && s.role ? s.role : 'PLUGIN',
    title: typeof s.title === 'string' ? s.title : '',
    status: STEP_STATUSES.indexOf(s.status) >= 0 ? s.status : 'ok',
    startedAt: isoOrNull(s.startedAt) || now,
    endedAt: isoOrNull(s.endedAt) || now,
    inputSummary: typeof s.inputSummary === 'string' ? s.inputSummary : '',
    outputSummary: typeof s.outputSummary === 'string' ? s.outputSummary : '',
    artifacts: Array.isArray(s.artifacts) ? s.artifacts.map(String) : [],
    error: s.error === null || s.error === undefined ? null : String(s.error),
  };
}

// 同一 run 的 steps 追加串行化：进程内队列，避免并发写交错。
const stepQueues = new Map();

export function appendStep(args) {
  const a = args || {};
  const key = String(a.root) + '\u0000' + String(a.runId);
  const previous = stepQueues.get(key) || Promise.resolve();
  // 队列本身用吞掉错误的副本占位；返回给调用方的 promise 保留拒绝（守卫错误要能被上层看到）。
  const next = previous.catch(() => {}).then(() => doAppendStep(a));
  const queued = next.catch(() => null);
  stepQueues.set(key, queued);
  const cleanup = () => { if (stepQueues.get(key) === queued) stepQueues.delete(key); };
  next.then(cleanup, cleanup);
  return next;
}

function doAppendStep(args) {
  const root = args.root;
  const runId = args.runId;
  if (!root || !isSafeRunId(runId)) return null;
  const step = normalizeStep(args.step);
  // 守卫在 try 之外：PATH_ESCAPE / PATH_DENIED 必须冒出去，不能被当成"写失败"吞掉。
  guardWrite(root, stepsFile(root, runId));
  try {
    fs.mkdirSync(runDir(root, runId), { recursive: true });
    fs.appendFileSync(stepsFile(root, runId), JSON.stringify(step) + '\n', 'utf8');
  } catch (err) {
    return null;
  }
  const index = readIndex(root);
  const entry = index.runs.filter((item) => item.id === runId)[0];
  if (entry) {
    entry.stepCount += 1;
    entry.currentStep = step.title;
    writeIndex(root, index);
  }
  return step;
}

export function updateRun(root, id, patch) {
  if (!isSafeRunId(id)) return null;
  const current = readJson(runFile(root, id), null);
  if (!current || current.id !== id) return null;
  const next = Object.assign({}, current, patch || {});
  if (!writeJsonAtomic(runFile(root, id), next, root)) return null;
  const index = readIndex(root);
  const entry = index.runs.filter((item) => item.id === id)[0];
  if (entry) {
    if (RUN_STATUSES.indexOf(next.status) >= 0) entry.status = next.status;
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'endedAt')) entry.endedAt = isoOrNull(next.endedAt);
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'degraded')) entry.degraded = typeof next.degraded === 'string' ? next.degraded : null;
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'acceptanceFailed')) entry.acceptanceFailed = next.acceptanceFailed === true;
    writeIndex(root, index);
  }
  return next;
}

export function createRun(args) {
  const a = args || {};
  const root = a.root;
  const kind = typeof a.kind === 'string' ? a.kind : 'bootstrap';
  const now = new Date();
  const id = isSafeRunId(a.id) ? a.id : runIdFor(kind, now);
  const run = {
    id: id,
    kind: kind,
    title: typeof a.title === 'string' && a.title ? a.title : kind,
    status: 'running',
    degraded: null,
    // 持久化建库模式：recover 必须沿用原模式（topic 库不能按 asset 恢复）。
    mode: a.mode === 'topic' ? 'topic' : 'asset',
    startedAt: now.toISOString(),
    endedAt: null,
    summary: '',
    root: root,
    // 工具注册失败等"运行环境告警"：编排官没工具可用时，靠这里查原因。
    warnings: Array.isArray(a.warnings) ? a.warnings.map(String) : [],
    // S1 监督字段
    heartbeatAt: isoOrNull(a.heartbeatAt) || now.toISOString(),
    heartbeatBy: a.heartbeatBy === 'agent' || a.heartbeatBy === 'engine' ? a.heartbeatBy : null,
    deadlineAt: isoOrNull(a.deadlineAt) || new Date(now.getTime() + (RUN_BUDGET_MS[kind] || DEFAULT_RUN_BUDGET_MS)).toISOString(),
    cancelRequestedAt: isoOrNull(a.cancelRequestedAt),
    acceptance: normalizeAcceptance(a.acceptance),
    acceptanceFailed: a.acceptanceFailed === true,
    usage: normalizeUsage(a.usage),
    usageSource: normalizeUsageSource(a.usageSource),
    engineVersion: typeof a.engineVersion === 'string' ? a.engineVersion : null,
    schemaVersion: Number.isFinite(a.schemaVersion) ? a.schemaVersion : 1,
    resumedFrom: typeof a.resumedFrom === 'string' && a.resumedFrom ? a.resumedFrom : null,
  };
  // 先过守卫再建目录：<root>/.jkkb 若是指向库外的软链，必须在这里就拒绝。
  guardWrite(root, runFile(root, id));
  guardWrite(root, stepsFile(root, id));
  fs.mkdirSync(runDir(root, id), { recursive: true });
  fs.writeFileSync(stepsFile(root, id), '', 'utf8');
  writeJsonAtomic(runFile(root, id), run, root);
  const index = readIndex(root);
  index.runs.unshift({
    id: id,
    title: run.title,
    kind: run.kind,
    status: 'running',
    mode: run.mode,
    startedAt: run.startedAt,
    endedAt: null,
    stepCount: 0,
    currentStep: '',
    degraded: null,
    acceptanceFailed: run.acceptanceFailed === true,
    usageSource: run.usageSource,
    inputTokens: run.usage ? run.usage.inputTokens : null,
    outputTokens: run.usage ? run.usage.outputTokens : null,
  });
  writeIndex(root, index);
  return run;
}

export function finishRun(args) {
  const a = args || {};
  const run = readJson(runFile(a.root, a.runId), null);
  if (!run || run.id !== a.runId) return null;
  const status = TERMINAL_RUN_STATUSES.indexOf(a.status) >= 0 ? a.status : 'failed';
  const next = Object.assign({}, run, {
    status: status,
    endedAt: new Date().toISOString(),
    summary: typeof a.summary === 'string' ? a.summary : (typeof run.summary === 'string' ? run.summary : ''),
    degraded: typeof a.degraded === 'string' ? a.degraded : (typeof run.degraded === 'string' ? run.degraded : null),
    ...(a.acceptance === undefined ? {} : { acceptance: normalizeAcceptance(a.acceptance) }),
    ...(a.acceptanceFailed === undefined ? {} : { acceptanceFailed: a.acceptanceFailed === true }),
    ...(a.usage === undefined ? {} : { usage: normalizeUsage(a.usage) }),
    ...(a.usageSource === undefined ? {} : { usageSource: normalizeUsageSource(a.usageSource) }),
  });
  writeJsonAtomic(runFile(a.root, a.runId), next, a.root);
  const index = readIndex(a.root);
  const entry = index.runs.filter((item) => item.id === a.runId)[0];
  if (entry) {
    entry.status = next.status;
    entry.endedAt = next.endedAt;
    entry.degraded = next.degraded;
    entry.acceptanceFailed = next.acceptanceFailed === true;
    entry.usageSource = normalizeUsageSource(next.usageSource);
    entry.inputTokens = next.usage ? next.usage.inputTokens : null;
    entry.outputTokens = next.usage ? next.usage.outputTokens : null;
    writeIndex(a.root, index);
  }
  return next;
}

/**
 * 把引擎的 start/ok/skip/error 成对事件折成"一行一个 step"：
 * start 只在内存里开一条，终结状态才写一行（含开始与结束时间）。
 */
export function createStepCollector(args) {
  const a = args || {};
  const root = a.root;
  const runId = a.runId;
  const role = typeof a.role === 'string' && a.role ? a.role : 'PLUGIN';
  const open = new Map();
  const pending = [];

  function openStep(name, detail) {
    const key = String(name);
    open.set(key, {
      id: 'step-' + crypto.randomBytes(6).toString('hex'),
      title: key,
      startedAt: new Date().toISOString(),
      inputSummary: typeof detail === 'string' ? detail : '',
    });
  }

  function settle(name, status, detail) {
    const key = String(name);
    const entry = open.get(key) || {
      id: 'step-' + crypto.randomBytes(6).toString('hex'),
      title: key,
      startedAt: new Date().toISOString(),
      inputSummary: '',
    };
    open.delete(key);
    const step = {
      id: entry.id,
      role: role,
      title: entry.title,
      status: STEP_STATUSES.indexOf(status) >= 0 ? status : 'ok',
      startedAt: entry.startedAt,
      endedAt: new Date().toISOString(),
      inputSummary: entry.inputSummary,
      outputSummary: typeof detail === 'string' ? detail : '',
      artifacts: [],
      error: status === 'error' ? (typeof detail === 'string' ? detail : 'error') : null,
    };
    pending.push(appendStep({ root: root, runId: runId, step: step }));
    return step;
  }

  // 直接吃引擎的 onStep 回调。
  function onEngineStep(event) {
    const e = event && typeof event === 'object' ? event : {};
    const name = typeof e.step === 'string' ? e.step : 'step';
    const detail = typeof e.detail === 'string' ? e.detail : '';
    if (e.status === 'start') {
      openStep(name, detail);
      return;
    }
    settle(name, e.status === 'skip' ? 'skip' : (e.status === 'error' ? 'error' : 'ok'), detail);
  }

  function record(step) {
    pending.push(appendStep({ root: root, runId: runId, step: Object.assign({ role: role }, step || {}) }));
  }

  async function flush() {
    // 没有收到终结事件的步骤按 error 收尾，避免"永远 running 的步骤"。
    Array.from(open.keys()).forEach((name) => settle(name, 'error', '步骤未收到结束事件'));
    await Promise.all(pending);
    pending.length = 0;
  }

  return { onEngineStep: onEngineStep, record: record, flush: flush };
}
