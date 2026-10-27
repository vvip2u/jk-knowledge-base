/**
 * host 半的四条 HTTP 路由（全部 exact，前缀 /plugins/jk-knowledge-base/）。
 *
 *   1. GET  /plugins/jk-knowledge-base/health          → 探活
 *   2. GET  /plugins/jk-knowledge-base/config          → 读设置 + vault 发现
 *   3. POST /plugins/jk-knowledge-base/config/validate → 根目录校验（策略 + 可写性实测 + 概要）
 *   4. POST /plugins/jk-knowledge-base/config          → 保存（必须 riskAck === true，否则 409）
 *
 * 约定：
 * - handler 第一件事是 connection.requestRejection(req)；返回值 !== undefined 就直接
 *   res.statusCode = 返回码 + end()，不再继续。
 * - 请求体只接受 application/json、上限 8KB；错误统一 { ok:false, error:{ code, message } }。
 * - 缺 webServer / connection 时不抛异常，只是注册不出路由 / 跳过鉴权（便于测试与降级）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';

import { describeErrno, hashAckText, PLUGIN_VERSION, RISK_ACK_TEXT, RISK_ACK_VERSION, createSettingsStore } from './config.js';
import { evaluateRoot, getTopLevelDirs, hasVault, VAULT_DIR_NAME } from './root-policy.js';
import { resolveRoute, runHostPreflight, serviceOf } from './orchestrator.js';
import * as checkpoint from './checkpoint.js';
import * as ledger from './ledger.js';
import * as engine from './engine/index.js';
import { createRepos as createStoreRepos, NAMESPACE_MAP as STORE_NAMESPACE_MAP, STORE_SCHEMA_VERSION } from './store/index.js';
import { SKILLS } from './skills/catalog.js';
import {
  archiveExpert,
  loadDoctorEngine,
  readDoctorLast,
  writeDoctorAudit,
  createExpert,
  expertView,
  recordSkillCall,
  REPORT_FINDINGS_HARD_LIMIT,
  REPORT_FINDINGS_LIMIT,
  expertStats,
  restoreExpert,
  updateExpert,
} from './tools.js';
import { isSafeRecordId } from './store/adapter-file.js';
import { ENGINE_VERSION } from './engine/index.js';
import * as trace from './trace.js';

export const ROUTE_PREFIX = '/plugins/jk-knowledge-base';
export const MAX_BODY_BYTES = 8 * 1024;
export const ROUTE_PATHS = {
  health: ROUTE_PREFIX + '/health',
  config: ROUTE_PREFIX + '/config',
  validate: ROUTE_PREFIX + '/config/validate',
  runs: ROUTE_PREFIX + '/runs',
  run: ROUTE_PREFIX + '/run',
  preflight: ROUTE_PREFIX + '/preflight',
  skills: ROUTE_PREFIX + '/skills',
  dashboard: ROUTE_PREFIX + '/dashboard',
  doctor: ROUTE_PREFIX + '/doctor',
  doctorRepair: ROUTE_PREFIX + '/doctor/repair',
  reports: ROUTE_PREFIX + '/reports',
  experts: ROUTE_PREFIX + '/experts',
  skillRegistry: ROUTE_PREFIX + '/skill-registry',
  skillCalls: ROUTE_PREFIX + '/skill-calls',
  ledgerCalendar: ROUTE_PREFIX + '/ledger/calendar',
  ledgerDay: ROUTE_PREFIX + '/ledger/day',
  files: ROUTE_PREFIX + '/files',
  file: ROUTE_PREFIX + '/file',
  fileSave: ROUTE_PREFIX + '/file/save',
  fileReveal: ROUTE_PREFIX + '/file/reveal',
};

function requestUrl(req) {
  try {
    return new URL(String((req && req.url) || ''), 'http://localhost');
  } catch (err) {
    return null;
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  try {
    if (typeof res.setHeader === 'function') res.setHeader('content-type', 'application/json; charset=utf-8');
  } catch (err) { /* 假 res（测试）可能没有 setHeader */ }
  res.end(JSON.stringify(payload));
}

function fail(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code: code, message: message } });
}

function rejectIfNeeded(req, res, connection) {
  let rejection;
  try {
    rejection = connection && typeof connection.requestRejection === 'function'
      ? connection.requestRejection(req)
      : undefined;
  } catch (err) {
    rejection = 500;
  }
  if (rejection !== undefined) {
    res.statusCode = rejection;
    res.end();
    return true;
  }
  return false;
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    if (typeof req.on !== 'function') {
      finish({ ok: true, text: '' });
      return;
    }

    req.on('data', (chunk) => {
      const size_ = chunk && typeof chunk.length === 'number' ? chunk.length : 0;
      size += size_;
      if (size > limit) {
        finish({ ok: false, status: 413, code: 'payload-too-large', message: '请求体超过 ' + limit + ' 字节上限' });
        try { if (typeof req.destroy === 'function') req.destroy(); } catch (err) { /* 忽略 */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false, status: 400, code: 'body-read-failed', message: '请求体读取失败' }));
  });
}

async function readJson(req, res) {
  const type = String((req.headers && req.headers['content-type']) || '').toLowerCase();
  if (type.indexOf('application/json') !== 0) {
    fail(res, 415, 'unsupported-media-type', '请求头 Content-Type 必须是 application/json');
    return null;
  }
  const raw = await readBody(req, MAX_BODY_BYTES);
  if (!raw.ok) {
    fail(res, raw.status, raw.code, raw.message);
    return null;
  }
  if (!raw.text.trim()) return {};
  try {
    const parsed = JSON.parse(raw.text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    fail(res, 400, 'invalid-json', '请求体不是合法 JSON');
    return null;
  }
}

/**
 * 打开文件所在目录并高亮该文件：按平台返回要执行的命令。
 * darwin → open -R（Finder 打开所在目录并选中文件）；win32 → explorer /select,（资源管理器选中）；
 * 其余平台退化 xdg-open 只开所在目录（Linux 各文件管理器选中语法不一，不保证高亮）。
 */
export function revealCommand(platform, absFile) {
  const file = String(absFile == null ? '' : absFile);
  if (platform === 'darwin') return { cmd: 'open', args: ['-R', file], highlighted: true };
  if (platform === 'win32') return { cmd: 'explorer', args: ['/select,' + file], highlighted: true };
  return { cmd: 'xdg-open', args: [path.dirname(file)], highlighted: false };
}

function probeWritable(root, io) {
  const fsi = io || fs;
  const file = path.join(root, '.jkkb-write-probe-' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + '.tmp');
  try {
    fsi.writeFileSync(file, 'ok', 'utf8');
    fsi.unlinkSync(file);
    return { ok: true, code: null, message: '' };
  } catch (err) {
    try { fsi.unlinkSync(file); } catch (cleanupErr) { /* 探测文件可能没建出来 */ }
    return { ok: false, code: (err && err.code) || 'write-failed', message: describeErrno(err) };
  }
}

function summarizeVault(root, topLevelDirs, io) {
  const fsi = io || fs;
  let entries = [];
  try { entries = fsi.readdirSync(root); } catch (err) { entries = []; }
  const existingDirs = topLevelDirs.filter((name) => {
    try { return fsi.existsSync(path.join(root, name)) === true; } catch (err) { return false; }
  });
  return {
    topLevelCount: Array.isArray(entries) ? entries.length : 0,
    expectedDirs: topLevelDirs.length,
    existingDirs: existingDirs,
    hasAllDirs: existingDirs.length === topLevelDirs.length,
    hasVault: hasVault(root, { existsSync: fsi.existsSync }),
  };
}

export function createHandlers(options) {
  const opts = options || {};
  const store = opts.store || createSettingsStore(opts);
  const connection = opts.connection;
  const io = opts.fs || fs;
  // 系统命令起进程器与平台：默认真实 spawn + 当前平台，测试注入假实现断言参数。
  const spawner = typeof opts.spawn === 'function' ? opts.spawn : nodeSpawn;
  const platform = typeof opts.platform === 'string' ? opts.platform : process.platform;
  // 顶层目录真源：显式注入优先，否则向引擎预设投影（不在本文件复制目录名）。
  const injectedDirs = Array.isArray(opts.topLevelDirs) ? opts.topLevelDirs : null;
  const policyOptions = opts.policyOptions || {};
  const version = typeof opts.version === 'string' ? opts.version : PLUGIN_VERSION;
  const runs = opts.runs || null;
  // 诊断用：ctx（看 subagents / route）与工具注册结果（成功名单 + 失败清单）。
  const ctx = opts.ctx || null;
  const toolState = typeof opts.toolState === 'function' ? opts.toolState : null;

  function currentRoot() {
    const settings = store.get();
    return settings && typeof settings.root === 'string' && settings.root ? settings.root : null;
  }

  async function topLevelDirsFor(mode) {
    if (injectedDirs) return injectedDirs;
    return getTopLevelDirs(mode === 'topic' ? 'topic' : 'asset');
  }

  function wrap(handler) {
    return async function wrapped(req, res) {
      if (rejectIfNeeded(req, res, connection)) return;
      try {
        await handler(req, res);
      } catch (err) {
        fail(res, 500, 'internal', '宿主内部错误：' + (err && err.message ? err.message : 'unknown'));
      }
    };
  }

  // 诊断信息：全部来源都做降级，任何一环取不到就是 null / 空数组，绝不让 /health 变慢或抛错。
  function buildHealth() {
    let tools = { registered: [], failed: [] };
    try {
      const state = toolState ? toolState() : null;
      if (state && typeof state === 'object') {
        tools = {
          registered: Array.isArray(state.registered) ? state.registered.map(String) : [],
          failed: Array.isArray(state.failed)
            ? state.failed.map((item) => ({
                name: String(item && item.name ? item.name : ''),
                error: String(item && item.error ? item.error : ''),
              }))
            : [],
        };
      }
    } catch (err) { /* 保持空 */ }

    let subagents = { available: false, providers: [] };
    try {
      const service = serviceOf(ctx, 'subagents');
      const providers = service && typeof service.list === 'function' ? service.list() : [];
      subagents = {
        available: !!(service && typeof service.start === 'function'),
        providers: Array.isArray(providers) ? providers.map(String) : [],
      };
    } catch (err) { /* 保持 false/[] */ }

    let agentRoute = { available: false, source: null };
    try {
      const resolved = resolveRoute(ctx);
      agentRoute = resolved
        ? { available: true, source: resolved.source === 'agent' ? 'agent' : 'default' }
        : { available: false, source: null };
    } catch (err) { /* 保持 false/null */ }

    let root = { configured: false };
    try {
      const settings = store.get();
      root = { configured: !!(settings && typeof settings.root === 'string' && settings.root) };
    } catch (err) { /* 保持 false */ }

    let doctorInfo = { lastRunAt: null, openIssues: { error: 0, warn: 0, blocked: 0 } };
    let storeInfo = { schemaVersion: STORE_SCHEMA_VERSION, namespaces: STORE_NAMESPACE_MAP, guardReady: null, guardCode: null };
    try {
      const settings = store.get();
      if (settings && typeof settings.root === 'string' && settings.root) {
        const probe = createStoreRepos({ root: settings.root }).adapter.guardProbe();
        storeInfo.guardReady = probe.ok === true;
        storeInfo.guardCode = probe.ok ? null : probe.code;
        const lastDoctor = readDoctorLast(settings.root);
        if (lastDoctor) {
          doctorInfo.lastRunAt = lastDoctor.at || null;
          doctorInfo.openIssues = lastDoctor.issues || doctorInfo.openIssues;
        }
      }
    } catch (err) { /* 诊断失败不影响探活 */ }

    return {
      ok: true,
      version: version,
      host: true,
      tools: tools,
      store: storeInfo,
      doctor: doctorInfo,
      subagents: subagents,
      agentRoute: agentRoute,
      root: root,
    };
  }

  async function health(req, res) {
    if (req.method !== 'GET') {
      fail(res, 405, 'method-not-allowed', '仅支持 GET');
      return;
    }
    let payload;
    try {
      payload = buildHealth();
    } catch (err) {
      // 兜底：诊断失败也不能让探活失败。
      payload = {
        ok: true,
        version: version,
        host: true,
        tools: { registered: [], failed: [] },
        subagents: { available: false, providers: [] },
        agentRoute: { available: false, source: null },
        root: { configured: false },
      };
    }
    sendJson(res, 200, payload);
  }

  async function readConfig(req, res) {
    const settings = store.get();
    sendJson(res, 200, {
      ok: true,
      settings: settings,
      discovery: {
        vault: hasVault(settings.root, { existsSync: io.existsSync }),
        vaultPath: settings.root ? path.join(settings.root, VAULT_DIR_NAME, 'vault.json') : null,
      },
    });
  }

  async function validate(req, res) {
    if (req.method !== 'POST') {
      fail(res, 405, 'method-not-allowed', '仅支持 POST');
      return;
    }
    const body = await readJson(req, res);
    if (!body) return;
    const root = typeof body.root === 'string' ? body.root : '';
    const policy = evaluateRoot(root, policyOptions);
    const writable = policy.level === 'reject'
      ? { ok: false, code: 'not-checked', message: '路径未通过校验，未做可写性探测' }
      : probeWritable(policy.normalized, io);
    let summary = null;
    if (policy.level !== 'reject') {
      const dirs = await topLevelDirsFor(body.mode);
      summary = summarizeVault(policy.normalized, dirs, io);
    }
    sendJson(res, 200, {
      ok: policy.ok && writable.ok,
      level: policy.level,
      reasons: policy.reasons,
      normalized: policy.normalized,
      writable: writable,
      summary: summary,
    });
  }

  async function save(req, res) {
    if (req.method !== 'POST') {
      fail(res, 405, 'method-not-allowed', '仅支持 POST');
      return;
    }
    const body = await readJson(req, res);
    if (!body) return;

    // 风险确认是硬门槛：缺它 / 非 true 一律 409，且必须在动磁盘之前。
    if (body.riskAck !== true) {
      fail(res, 409, 'risk-ack-required', '必须先勾选「' + RISK_ACK_TEXT + '」才能保存');
      return;
    }

    const root = typeof body.root === 'string' ? body.root.trim() : '';
    if (!root) {
      fail(res, 400, 'root-missing', '缺少 root');
      return;
    }

    const policy = evaluateRoot(root, policyOptions);
    if (policy.level === 'reject') {
      fail(res, 400, 'root-rejected', policy.reasons.map((item) => item.message).join('；'));
      return;
    }

    const writable = probeWritable(policy.normalized, io);
    if (!writable.ok) {
      fail(res, 400, 'root-not-writable', '目录不可写（' + writable.message + '）');
      return;
    }

    const now = new Date().toISOString();
    const saved = store.save({
      root: policy.normalized,
      rootConfirmedAt: now,
      rootRiskAck: { at: now, version: RISK_ACK_VERSION, textHash: hashAckText(RISK_ACK_TEXT) },
      updatedAt: now,
    });
    if (!saved.ok) {
      fail(res, 500, 'settings-write-failed', '设置写入失败（' + (saved.error && saved.error.message ? saved.error.message : 'unknown') + '）');
      return;
    }
    sendJson(res, 200, { ok: true, settings: saved.settings });
  }

  async function config(req, res) {
    if (req.method === 'GET') return readConfig(req, res);
    if (req.method === 'POST') return save(req, res);
    fail(res, 405, 'method-not-allowed', '仅支持 GET / POST');
  }

  async function preflight(req, res) {
    if (req.method !== 'GET') {
      fail(res, 405, 'method-not-allowed', '仅支持 GET');
      return;
    }
    const result = await runHostPreflight({ ctx: ctx, store: store, toolState: toolState }, { kind: 'bootstrap' });
    if (result.status === 409) {
      fail(res, 409, 'root-missing', result.error.message);
      return;
    }
    sendJson(res, 200, result.report);
  }

  function isValidDateKey(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const parts = String(value).split('-').map(Number);
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    return date.getFullYear() === parts[0] && date.getMonth() === parts[1] - 1 && date.getDate() === parts[2];
  }

  async function skillsList(req, res) {
    if (req.method !== 'GET') {
      fail(res, 405, 'method-not-allowed', '仅支持 GET');
      return;
    }
    sendJson(res, 200, {
      ok: true,
      skills: SKILLS.map((skill) => ({
        id: skill.id,
        name: skill.name,
        profession: skill.profession,
        stage: skill.stage,
        purpose: skill.purpose,
        outputDir: skill.outputDir,
        idPrefix: skill.idPrefix,
      })),
    });
  }

  function paginate(records, url, sortCompare) {
    const rawLimit = url ? url.searchParams.get('limit') : null;
    const parsed = Number(rawLimit);
    const limit = Number.isFinite(parsed) && parsed >= 1 ? Math.min(100, Math.floor(parsed)) : 20;
    const before = url ? url.searchParams.get('before') : null;
    const sorted = records.slice().sort(sortCompare);
    let startIndex = 0;
    if (before) {
      const at = sorted.findIndex((item) => item.id === before);
      startIndex = at >= 0 ? at + 1 : sorted.length;
    }
    const items = sorted.slice(startIndex, startIndex + limit);
    const nextBefore = (startIndex + limit < sorted.length && items.length > 0) ? items[items.length - 1].id : null;
    return { items: items, nextBefore: nextBefore };
  }

  /** 每个顶层目录的笔记数（有界扫描：5000 文件 / 500ms 预算）。 */
  function countNotesPerTopDir(root) {
    const deadline = Date.now() + 500;
    const topDirs = [];
    let truncated = false;
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (err) { return { topDirs: [], truncated: false }; }
    entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).forEach((entry) => {
      let notes = 0;
      const stack = [path.join(root, entry.name)];
      let stop = false;
      while (stack.length > 0 && !stop) {
        if (Date.now() > deadline) { truncated = true; stop = true; break; }
        const current = stack.pop();
        let children = [];
        try { children = fs.readdirSync(current, { withFileTypes: true }); } catch (err) { continue; }
        children.forEach((child) => {
          if (child.name.startsWith('.') || child.name === 'node_modules') return;
          const abs = path.join(current, child.name);
          if (child.isDirectory()) stack.push(abs);
          else if (child.name.endsWith('.md')) notes += 1;
        });
      }
      topDirs.push({ name: entry.name, notes: notes });
    });
    return { topDirs: topDirs, truncated: truncated };
  }

  async function doctorGet(req, res) {
    if (req.method !== 'GET') {
      fail(res, 405, 'method-not-allowed', '仅支持 GET');
      return;
    }
    const root = currentRoot();
    if (!root) {
      // 未配置根目录也给出诊断（CFG-01 blocked），而不是 409：doctor 要能解释自己为什么不能修。
      const api = await loadDoctorEngine();
      if (!api) {
        fail(res, 503, 'doctor-unavailable', 'doctor 引擎不可用');
        return;
      }
      // deps.settingsPath：诊断必须读 handler 持有的那份 settings（测试注入的 store 文件），
      // 否则 createContext 回落到真实 ~/.dsh 的设置，未配置根目录会被误判成已配置（CFG-01 ok）。
      const diagnosis = await api.diagnose({ root: null, deps: { settingsPath: store.file } });
      sendJson(res, 200, Object.assign({}, diagnosis, { lastRepair: null }));
      return;
    }
    const api = await loadDoctorEngine();
    if (!api) {
      fail(res, 503, 'doctor-unavailable', 'doctor 引擎不可用');
      return;
    }
    let diagnosis;
    try {
      diagnosis = await api.diagnose({ root: root, deps: { settingsPath: store.file } });
    } catch (err) {
      fail(res, 500, (err && err.code) || 'doctor-failed', String(err && err.message ? err.message : err));
      return;
    }
    sendJson(res, 200, Object.assign({}, diagnosis, { lastRepair: readDoctorLast(root) }));
  }

  async function doctorRepair(req, res) {
    if (req.method !== 'POST') {
      fail(res, 405, 'method-not-allowed', '仅支持 POST');
      return;
    }
    const root = currentRoot();
    if (!root) {
      fail(res, 409, 'root-missing', '尚未配置知识库根目录');
      return;
    }
    const body = await readJson(req, res);
    if (!body) return;
    const api = await loadDoctorEngine();
    if (!api) {
      fail(res, 503, 'doctor-unavailable', 'doctor 引擎不可用');
      return;
    }

    const repairIds = Array.isArray(body.repairIds)
      ? body.repairIds.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : [];
    if (repairIds.length === 0) {
      fail(res, 400, 'NO_TARGETS', 'repairIds 不能为空（必须显式选择要修的项，不支持“修全部”）');
      return;
    }

    const dryRun = body.dryRun === undefined ? true : body.dryRun !== false;
    if (!dryRun && body.confirm !== true) {
      let planned = [];
      try {
        const preview = await api.repair({ root: root, repairIds: repairIds, dryRun: true });
        planned = Array.isArray(preview && preview.planned) ? preview.planned : [];
      } catch (err) { planned = []; }
      sendJson(res, 400, {
        ok: false,
        error: { code: 'CONFIRM_REQUIRED', message: 'dryRun=false 时必须带 confirm:true' },
        planned: planned,
      });
      return;
    }

    const startedAt = Date.now();
    let diagnosis = null;
    try {
      diagnosis = await api.diagnose({ root: root, deps: { settingsPath: store.file } });
    } catch (err) { diagnosis = null; }

    let repair;
    try {
      repair = await api.repair({ root: root, repairIds: repairIds, dryRun: dryRun, deps: { settingsPath: store.file } });
    } catch (err) {
      if (err && err.code === 'RUN_IN_PROGRESS') {
        sendJson(res, 409, {
          ok: false,
          error: { code: 'run-in-progress', message: '有正在运行的 run（心跳新鲜），先等它结束再修' },
          runs: Array.isArray(err.runs) ? err.runs : [],
        });
        return;
      }
      fail(res, 500, (err && err.code) || 'repair-failed', String(err && err.message ? err.message : err));
      return;
    }

    const payload = Object.assign({ ok: true }, repair);
    if (dryRun !== true) {
      const audit = await writeDoctorAudit({
        root: root, diagnosis: diagnosis, repair: repair, repairIds: repairIds, elapsedMs: Date.now() - startedAt,
      });
      payload.audit = { runId: audit.runId, reportPath: audit.reportPath, lastPath: audit.lastPath };
      if (audit.error) payload.auditError = audit.error;
    }
    sendJson(res, 200, payload);
  }

  async function dashboard(req, res) {
    if (req.method !== 'GET') {
      fail(res, 405, 'method-not-allowed', '仅支持 GET');
      return;
    }
    const root = currentRoot();
    if (!root) {
      fail(res, 409, 'root-missing', '尚未配置知识库根目录');
      return;
    }

    let inspected;
    try {
      inspected = await engine.inspect({ root: root });
    } catch (err) {
      fail(res, 500, 'inspect-failed', '巡检失败：' + (err && err.message ? err.message : 'unknown'));
      return;
    }
    let recent = [];
    try {
      recent = await engine.listRecentNotes({ root: root, limit: 10 });
    } catch (err) {
      recent = [];
    }

    const dirs = countNotesPerTopDir(root);
    const runs = ledger.readAllRuns(root);

    // today：按本地时区归日；没有 usage 的 run 计入 runs 但不参与 token 求和。
    const todayKey = ledger.localDateKey(new Date());
    const todayRuns = runs.filter((run) => ledger.localDateKey(run.startedAt) === todayKey);
    const tokenSum = (key) => todayRuns.reduce((sum, run) => {
      const value = run.usage && run.usage[key];
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
    const hasUsage = (run) => !!run.usage && Number.isFinite(run.usage.inputTokens);

    const sortedByStart = runs.slice().sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    const last = sortedByStart[0] || null;

    const toolInfo = typeof toolState === 'function' ? (toolState() || {}) : {};
    let storeGuard = 'unknown';
    try {
      storeGuard = createStoreRepos({ root: root }).adapter.guardProbe().ok ? 'ready' : 'blocked';
    } catch (err) {
      storeGuard = 'blocked';
    }
    let subagentsInfo = { available: false, providers: [] };
    try {
      const subagents = serviceOf(ctx, 'subagents');
      const providers = subagents && typeof subagents.list === 'function' ? subagents.list() : null;
      subagentsInfo = {
        available: !!(subagents && (typeof subagents.start === 'function' || typeof subagents.startActivation === 'function')),
        providers: Array.isArray(providers) ? providers.map((item) => String(item && item.provider ? item.provider : item)) : [],
      };
    } catch (err) { /* 诊断失败不影响仪表盘 */ }

    let lastReport = null;
    try {
      const reports = createStoreRepos({ root: root }).reportsRepo.list()
        .filter((item) => item.kind === 'maintain')
        .sort((a, b) => {
          const byTime = String(b.createdAt).localeCompare(String(a.createdAt));
          if (byTime !== 0) return byTime;
          const byPeriod = String(b.period || '').localeCompare(String(a.period || ''));
          return byPeriod !== 0 ? byPeriod : String(b.id).localeCompare(String(a.id));
        });
      if (reports.length > 0) {
        lastReport = { period: reports[0].period, summary: reports[0].summary, byRule: reports[0].byRule || {} };
      }
    } catch (err) { lastReport = null; }

    // 经营看板（可选业务数据）：从 vault 的 .jk-kb/dashboard-biz.json 读取，
    // 战略布局 / 客资数据 / 订单数据 / 转化数据四个区块；缺文件或解析失败一律 null，
    // 前端按占位渲染（知识库引擎本身不产生这些业务数据，由用户在文件里维护）。
    // trend：客资粉丝趋势 / 订单金额趋势，[{label,value}] 序列，非法点过滤、最多 12 个。
    let biz = { strategy: null, audience: null, orders: null, conversion: null };
    try {
      const bizPath = path.join(root, '.jk-kb', 'dashboard-biz.json');
      if (io.existsSync(bizPath)) {
        const rawBiz = JSON.parse(io.readFileSync(bizPath, 'utf8'));
        const bizNum = (obj, key) => (obj && typeof obj === 'object' && Number.isFinite(obj[key]) ? obj[key] : null);
        const bizStr = (obj, key) => (obj && typeof obj === 'object' && typeof obj[key] === 'string' && obj[key] ? obj[key] : null);
        const bizTrend = (obj) => {
          if (!obj || typeof obj !== 'object' || !Array.isArray(obj.trend)) return null;
          return obj.trend
            .map((point) => (point && typeof point === 'object'
              ? {
                  label: typeof point.label === 'string' && point.label ? point.label : '',
                  value: Number.isFinite(point.value) ? point.value : null,
                }
              : null))
            .filter((point) => point && point.value !== null)
            .slice(0, 12);
        };
        biz = {
          strategy: rawBiz && typeof rawBiz.strategy === 'object'
            ? { milestone: bizStr(rawBiz.strategy, 'milestone'), progress: bizNum(rawBiz.strategy, 'progress') }
            : null,
          audience: rawBiz && typeof rawBiz.audience === 'object'
            ? {
                accounts: bizNum(rawBiz.audience, 'accounts'),
                followers: bizNum(rawBiz.audience, 'followers'),
                prospects: bizNum(rawBiz.audience, 'prospects'),
                trend: bizTrend(rawBiz.audience),
              }
            : null,
          orders: rawBiz && typeof rawBiz.orders === 'object'
            ? {
                deals: bizNum(rawBiz.orders, 'deals'),
                amount: bizNum(rawBiz.orders, 'amount'),
                trend: bizTrend(rawBiz.orders),
              }
            : null,
          conversion: rawBiz && typeof rawBiz.conversion === 'object'
            ? { wechatRate: bizNum(rawBiz.conversion, 'wechatRate'), dealRate: bizNum(rawBiz.conversion, 'dealRate') }
            : null,
        };
      }
    } catch (err) { /* 经营看板缺省回落 null */ }

    sendJson(res, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      counts: {
        notes: inspected.noteCount || 0,
        dirs: inspected.topDirs || 0,
        files: inspected.fileCount || 0,
        topDirs: dirs.topDirs,
        truncated: inspected.truncated === true || dirs.truncated === true,
      },
      recent: recent.map((item) => ({
        relPath: item.relPath, title: item.title, updatedAt: item.updatedAt, size: item.size,
      })),
      runtime: {
        root: root,
        hasVault: inspected.hasVault === true,
        mode: inspected.mode || null,
        vaultUpdatedAt: inspected.vaultUpdatedAt || null,
        lastRun: last ? {
          id: last.id,
          title: last.title || last.kind || '',
          status: last.status,
          startedAt: last.startedAt || null,
          endedAt: last.endedAt || null,
          elapsedMs: ledger.elapsedMs(last),
        } : null,
        running: runs.filter((run) => run.status === 'running').length,
      },
      today: {
        runs: todayRuns.length,
        completed: todayRuns.filter((run) => run.status === 'completed').length,
        failed: todayRuns.filter((run) => ['failed', 'timed_out', 'stalled'].indexOf(run.status) >= 0).length,
        totalMs: todayRuns.reduce((sum, run) => sum + ledger.elapsedMs(run), 0),
        inputTokens: tokenSum('inputTokens'),
        outputTokens: tokenSum('outputTokens'),
        usageRuns: todayRuns.filter(hasUsage).length,
      },
      health: {
        storeGuard: storeGuard,
        tools: {
          registered: Array.isArray(toolInfo.registered) ? toolInfo.registered.length : 0,
          failed: Array.isArray(toolInfo.failed) ? toolInfo.failed.length : 0,
        },
        subagents: subagentsInfo,
      },
      maintain: { lastReport: lastReport },
      biz: biz,
    });
  }

  async function expertsList(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      fail(res, 405, 'method-not-allowed', '仅支持 GET / POST');
      return;
    }
    const root = currentRoot();
    if (!root) {
      fail(res, 409, 'root-missing', '尚未配置知识库根目录');
      return;
    }

    // 写操作是配置 CRUD：不需要 runId、不加锁，但依旧走 store 的守卫 + 原子写。
    if (req.method === 'POST') {
      const body = await readJson(req, res);
      if (!body) return;
      const result = createExpert({
        root: root,
        name: body.name,
        domain: body.domain,
        responsibility: body.responsibility,
        skillIds: body.skillIds,
        promptFragment: body.promptFragment,
      });
      if (!result.ok) {
        fail(res, result.status || 400, result.code, result.message);
        return;
      }
      sendJson(res, 200, { ok: true, expert: result.expert });
      return;
    }
    const url = requestUrl(req);
    const rawStatus = url ? url.searchParams.get('status') : null;
    const status = rawStatus === null || rawStatus === '' ? 'active' : rawStatus;
    if (status !== 'active' && status !== 'archived') {
      fail(res, 400, 'invalid-status', 'status 只能是 active 或 archived（收到：' + rawStatus + '）');
      return;
    }
    const repos = createStoreRepos({ root: root });
    const experts = repos.expertsRepo.list()
      .filter((item) => String(item.status || 'active') === status)
      .map((item) => Object.assign(expertView(item), expertStats(root, item, repos)));
    sendJson(res, 200, { ok: true, experts: experts });
  }

  async function expertsScoped(req, res) {
    const root = currentRoot();
    if (!root) {
      fail(res, 409, 'root-missing', '尚未配置知识库根目录');
      return;
    }
    const pathname = String(req.url || '').split('?')[0];
    const base = ROUTE_PATHS.experts + '/';
    if (pathname.indexOf(base) !== 0) {
      fail(res, 404, 'expert-not-found', '未知的专家路径');
      return;
    }
    let rest = pathname.slice(base.length);
    const isArchive = /\/archive$/.test(rest);
    const isRestore = /\/restore$/.test(rest);
    if (isArchive) rest = rest.slice(0, -'/archive'.length);
    if (isRestore) rest = rest.slice(0, -'/restore'.length);
    const id = rest;
    if (!isSafeRecordId(id)) {
      fail(res, 400, 'invalid-id', '专家 id 非法：' + id);
      return;
    }

    if (isArchive) {
      if (req.method !== 'POST') {
        fail(res, 405, 'method-not-allowed', '仅支持 POST');
        return;
      }
      const result = archiveExpert({ root: root, id: id });
      if (!result.ok) {
        fail(res, result.status || 400, result.code, result.message);
        return;
      }
      sendJson(res, 200, { ok: true, expert: result.expert });
      return;
    }

    if (isRestore) {
      if (req.method !== 'POST') {
        fail(res, 405, 'method-not-allowed', '仅支持 POST');
        return;
      }
      const result = restoreExpert({ root: root, id: id });
      if (!result.ok) {
        fail(res, result.status || 400, result.code, result.message);
        return;
      }
      sendJson(res, 200, { ok: true, expert: result.expert, alreadyActive: result.alreadyActive === true });
      return;
    }

    if (req.method !== 'PATCH') {
      fail(res, 405, 'method-not-allowed', '仅支持 PATCH');
      return;
    }
    const body = await readJson(req, res);
    if (!body) return;
    const result = updateExpert({ root: root, id: id, patch: body });
    if (!result.ok) {
      fail(res, result.status || 400, result.code, result.message);
      return;
    }
    sendJson(res, 200, { ok: true, expert: result.expert });
  }

  async function skillRegistry(req, res) {
    if (req.method !== 'GET') {
      fail(res, 405, 'method-not-allowed', '仅支持 GET');
      return;
    }
    const root = currentRoot();
    if (!root) {
      fail(res, 409, 'root-missing', '尚未配置知识库根目录');
      return;
    }
    const page = paginate(
      createStoreRepos({ root: root }).skillsRepo.list(),
      requestUrl(req),
      (a, b) => {
        const byTime = String(b.createdAt).localeCompare(String(a.createdAt));
        return byTime !== 0 ? byTime : String(b.id).localeCompare(String(a.id));
      }
    );
    sendJson(res, 200, {
      ok: true,
      skills: page.items.map((item) => ({
        id: item.id,
        name: item.name,
        version: item.version,
        status: item.status,
        path: item.path,
        keywords: Array.isArray(item.keywords) ? item.keywords : [],
      })),
      nextBefore: page.nextBefore,
    });
  }

  async function skillCalls(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      fail(res, 405, 'method-not-allowed', '仅支持 GET / POST');
      return;
    }
    const root = currentRoot();
    if (!root) {
      fail(res, 409, 'root-missing', '尚未配置知识库根目录');
      return;
    }

    // 手动回执：与 jk_kb_skill_run 共用 recordSkillCall，不复制校验逻辑。
    if (req.method === 'POST') {
      const body = await readJson(req, res);
      if (!body || typeof body !== 'object') {
        fail(res, 400, 'invalid-body', '请求体必须是 JSON 对象');
        return;
      }
      const recorded = recordSkillCall({
        root: root,
        skillId: body.skillId,
        task: body.task,
        result: body.result,
        reason: body.reason,
        outputs: body.outputs,
        ts: body.ts,
        source: 'manual',
        runId: null,
      });
      if (!recorded.ok) {
        const status = recorded.code === 'skill-not-found' ? 404 : 400;
        const error = { code: recorded.code, message: recorded.message };
        if (recorded.outputs) error.outputs = recorded.outputs;
        sendJson(res, status, { ok: false, error: error });
        return;
      }
      sendJson(res, 200, { ok: true, id: recorded.id, call: recorded.call });
      return;
    }
    const page = paginate(
      createStoreRepos({ root: root }).skillCallsRepo.list(),
      requestUrl(req),
      (a, b) => {
        const byTs = String(b.ts).localeCompare(String(a.ts));
        return byTs !== 0 ? byTs : String(b.id).localeCompare(String(a.id));
      }
    );
    sendJson(res, 200, {
      ok: true,
      calls: page.items.map((item) => ({
        ts: item.ts,
        skill: item.skill,
        name: item.name,
        version: item.version,
        task: item.task,
        result: item.result,
        reason: item.reason,
        outputs: Array.isArray(item.outputs) ? item.outputs : [],
      })),
      nextBefore: page.nextBefore,
    });
  }

  async function reportsList(req, res) {
    if (req.method !== 'GET') {
      fail(res, 405, 'method-not-allowed', '仅支持 GET');
      return;
    }
    const root = currentRoot();
    if (!root) {
      fail(res, 409, 'root-missing', '尚未配置知识库根目录');
      return;
    }
    const url = requestUrl(req);
    const rawLimit = url ? url.searchParams.get('limit') : null;
    const parsed = Number(rawLimit);
    const limit = Number.isFinite(parsed) && parsed >= 1 ? Math.min(100, Math.floor(parsed)) : 20;
    const reports = createStoreRepos({ root: root }).reportsRepo.list()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit)
      .map((item) => {
        const all = Array.isArray(item.findings) ? item.findings : [];
        return {
          id: item.id,
          kind: item.kind,
          period: item.period,
          summary: item.summary,
          path: item.path,
          createdAt: item.createdAt,
          byRule: item.byRule && typeof item.byRule === 'object' ? item.byRule : {},
          findings: all.slice(0, REPORT_FINDINGS_LIMIT),
          findingsTotal: Number.isFinite(item.findingsTotal) ? item.findingsTotal : all.length,
          truncated: item.truncated === true || all.length > REPORT_FINDINGS_LIMIT,
        };
      });
    sendJson(res, 200, { ok: true, reports: reports });
  }

  // GET /reports/:id —— 完整明细（5000 条硬上限），prefix 路由。
  async function reportDetail(req, res) {
    if (req.method !== 'GET') {
      fail(res, 405, 'method-not-allowed', '仅支持 GET');
      return;
    }
    const pathname = String(req.url || '').split('?')[0];
    const base = ROUTE_PATHS.reports + '/';
    if (pathname.indexOf(base) !== 0) {
      fail(res, 404, 'report-not-found', '未知的报告路径');
      return;
    }
    const id = pathname.slice(base.length);
    if (!isSafeRecordId(id)) {
      fail(res, 400, 'invalid-id', '报告 id 非法：' + id);
      return;
    }
    const root = currentRoot();
    if (!root) {
      fail(res, 409, 'root-missing', '尚未配置知识库根目录');
      return;
    }
    const record = createStoreRepos({ root: root }).reportsRepo.get(id);
    if (!record) {
      fail(res, 404, 'report-not-found', '报告不存在：' + id);
      return;
    }
    const all = Array.isArray(record.findings) ? record.findings : [];
    sendJson(res, 200, {
      ok: true,
      report: Object.assign({}, record, {
        findings: all.slice(0, REPORT_FINDINGS_HARD_LIMIT),
        findingsTotal: Number.isFinite(record.findingsTotal) ? record.findingsTotal : all.length,
        truncated: record.truncated === true || all.length > REPORT_FINDINGS_HARD_LIMIT,
      }),
    });
  }

  async function ledgerCalendar(req, res) {
    if (req.method !== 'GET') {
      fail(res, 405, 'method-not-allowed', '仅支持 GET');
      return;
    }
    const root = currentRoot();
    if (!root) {
      fail(res, 409, 'root-missing', '尚未配置知识库根目录');
      return;
    }
    const url = requestUrl(req);
    const yearRaw = url ? url.searchParams.get('year') : null;
    const monthRaw = url ? url.searchParams.get('month') : null;
    if (!/^\d{4}$/.test(String(yearRaw || ''))) {
      fail(res, 400, 'year-invalid', 'year 必须是 4 位数字，例如 2026');
      return;
    }
    const year = Number(yearRaw);
    const runs = ledger.readAllRuns(root);
    if (monthRaw === null || monthRaw === '') {
      sendJson(res, 200, Object.assign({ ok: true }, ledger.aggregateYear(runs, year)));
      return;
    }
    if (!/^\d{1,2}$/.test(String(monthRaw))) {
      fail(res, 400, 'month-invalid', 'month 必须是 1-12 的数字');
      return;
    }
    const month = Number(monthRaw);
    if (!(month >= 1 && month <= 12)) {
      fail(res, 400, 'month-invalid', 'month 必须是 1-12 的数字');
      return;
    }
    sendJson(res, 200, Object.assign({ ok: true }, ledger.aggregate(runs, { year: year, month: month })));
  }

  async function ledgerDay(req, res) {
    if (req.method !== 'GET') {
      fail(res, 405, 'method-not-allowed', '仅支持 GET');
      return;
    }
    const root = currentRoot();
    if (!root) {
      fail(res, 409, 'root-missing', '尚未配置知识库根目录');
      return;
    }
    const url = requestUrl(req);
    const date = url ? url.searchParams.get('date') : null;
    if (!isValidDateKey(date)) {
      fail(res, 400, 'date-invalid', 'date 必须是 YYYY-MM-DD');
      return;
    }
    const runs = ledger.readAllRuns(root);
    sendJson(res, 200, Object.assign({ ok: true }, ledger.aggregateDay(runs, date)));
  }

  async function runsList(req, res) {
    if (req.method !== 'GET') {
      fail(res, 405, 'method-not-allowed', '仅支持 GET');
      return;
    }
    const root = currentRoot();
    if (!root) {
      sendJson(res, 200, { ok: true, runs: [] });
      return;
    }
    // 读之前先收割：超预算 / 心跳静默的 running 必须先落成终态，列表才可信。
    try { trace.reap(root); } catch (err) { /* 收割失败不影响读取 */ }
    const url = requestUrl(req);
    const rawLimit = url ? url.searchParams.get('limit') : null;
    const before = url ? url.searchParams.get('before') : null;
    const page = trace.readRunsPage(root, {
      limit: rawLimit === null ? undefined : rawLimit,
      before: before === null ? '' : before,
    });
    sendJson(res, 200, { ok: true, runs: page.runs, nextBefore: page.nextBefore });
  }

  // ── 文件管理（文件树 / 目录列表 / 文件预览）──
  // 把相对目录解析成 root 内的绝对路径；越界（..、绝对路径、软链出圈）一律 400。
  function resolveInsideRoot(root, rel) {
    const relPath = typeof rel === 'string' ? rel : '';
    const abs = path.resolve(root, '.' + path.sep + relPath);
    const normalizedRoot = path.resolve(root);
    if (abs !== normalizedRoot && abs.indexOf(normalizedRoot + path.sep) !== 0) {
      return null;
    }
    return abs;
  }

  // 反向规范化：绝对路径 → 相对 root 的 posix 风格相对路径（root 本身是 ''）。
  function relInsideRoot(root, abs) {
    const normalizedRoot = path.resolve(root);
    if (abs === normalizedRoot) return '';
    return path.relative(normalizedRoot, abs).split(path.sep).join('/');
  }

  const FILE_TEXT_EXTS = ['.md', '.markdown', '.txt', '.json', '.csv', '.log', '.yaml', '.yml', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.xml', '.ini', '.toml', '.env', '.sh', '.py'];
  // 保存请求体上限：JSON 转义会放大体积（控制字符 / 引号），放宽到 8MB 传输、再按 utf8 字节精确卡 2MB。
  const FILE_SAVE_MAX_BYTES = 8 * 1024 * 1024;
  const FILE_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];
  const FILE_TEXT_MAX_BYTES = 2 * 1024 * 1024;

  // GET /files?dir=<rel> —— 列目录：folders 在前、各自按名排序，files 带 ext/size/mtimeMs。
  async function filesList(req, res) {
    if (req.method !== 'GET') {
      fail(res, 405, 'method-not-allowed', '仅支持 GET');
      return;
    }
    const root = currentRoot();
    if (!root) {
      fail(res, 409, 'root-missing', '尚未配置知识库根目录');
      return;
    }
    const url = requestUrl(req);
    const relDir = url ? (url.searchParams.get('dir') || '') : '';
    const absDir = resolveInsideRoot(root, relDir);
    if (!absDir) {
      fail(res, 400, 'dir-out-of-root', '目录超出知识库根目录范围');
      return;
    }
    let stats;
    try {
      stats = io.statSync(absDir);
    } catch (err) {
      stats = null;
    }
    if (!stats || !stats.isDirectory()) {
      fail(res, 404, 'dir-not-found', '目录不存在：' + relDir);
      return;
    }
    let dirents;
    try {
      dirents = io.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      fail(res, 500, 'dir-read-failed', '目录读取失败：' + describeErrno(err));
      return;
    }
    // 隐藏文件（. 开头，含 .jkkb-* 探测文件）不进文件管理列表。
    const visible = dirents.filter((dirent) => typeof dirent.name === 'string' && dirent.name.charAt(0) !== '.');
    const folders = [];
    const files = [];
    visible.forEach(function (dirent) {
      let isDir;
      try { isDir = dirent.isDirectory(); } catch (err) { isDir = false; }
      let isFile;
      try { isFile = dirent.isFile(); } catch (err) { isFile = false; }
      if (isDir) {
        folders.push({ name: dirent.name });
        return;
      }
      if (!isFile) return;
      const absFile = path.join(absDir, dirent.name);
      let size = 0;
      let mtimeMs = null;
      try {
        const st = io.statSync(absFile);
        size = typeof st.size === 'number' ? st.size : 0;
        mtimeMs = typeof st.mtimeMs === 'number' ? st.mtimeMs : null;
      } catch (err) { /* 读不到就给默认值 */ }
      files.push({
        name: dirent.name,
        ext: path.extname(dirent.name).toLowerCase(),
        size: size,
        mtimeMs: mtimeMs,
      });
    });
    const byName = function (a, b) { return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'); };
    folders.sort(byName);
    files.sort(byName);
    sendJson(res, 200, { ok: true, dir: relInsideRoot(root, absDir), folders: folders, files: files });
  }

  // GET /file?path=<rel> —— 单文件预览：text → utf8 文本，image → dataUrl，其余 → binary 元信息。
  async function fileEntry(req, res) {
    if (req.method !== 'GET') {
      fail(res, 405, 'method-not-allowed', '仅支持 GET');
      return;
    }
    const root = currentRoot();
    if (!root) {
      fail(res, 409, 'root-missing', '尚未配置知识库根目录');
      return;
    }
    const url = requestUrl(req);
    const relPath = url ? (url.searchParams.get('path') || '') : '';
    if (!relPath) {
      fail(res, 400, 'path-required', '缺少 path 参数');
      return;
    }
    const absFile = resolveInsideRoot(root, relPath);
    if (!absFile) {
      fail(res, 400, 'path-out-of-root', '文件路径超出知识库根目录范围');
      return;
    }
    let stats;
    try {
      stats = io.statSync(absFile);
    } catch (err) {
      stats = null;
    }
    if (!stats || !stats.isFile()) {
      fail(res, 404, 'file-not-found', '文件不存在：' + relPath);
      return;
    }
    const ext = path.extname(absFile).toLowerCase();
    const base = {
      path: relInsideRoot(root, absFile),
      name: path.basename(absFile),
      ext: ext,
      size: typeof stats.size === 'number' ? stats.size : 0,
      mtimeMs: typeof stats.mtimeMs === 'number' ? stats.mtimeMs : null,
    };
    if (FILE_TEXT_EXTS.indexOf(ext) >= 0) {
      if (stats.size > FILE_TEXT_MAX_BYTES) {
        sendJson(res, 200, Object.assign({ ok: true, kind: 'too-large' }, base, { limitBytes: FILE_TEXT_MAX_BYTES }));
        return;
      }
      let text;
      try {
        text = io.readFileSync(absFile, 'utf8');
      } catch (err) {
        fail(res, 500, 'file-read-failed', '文件读取失败：' + describeErrno(err));
        return;
      }
      sendJson(res, 200, Object.assign({ ok: true, kind: 'text' }, base, { text: text }));
      return;
    }
    if (FILE_IMAGE_EXTS.indexOf(ext) >= 0) {
      let buf;
      try {
        buf = io.readFileSync(absFile);
      } catch (err) {
        fail(res, 500, 'file-read-failed', '文件读取失败：' + describeErrno(err));
        return;
      }
      const mime = ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : (ext === '.svg' ? 'image/svg+xml' : ('image/' + ext.slice(1)));
      sendJson(res, 200, Object.assign({ ok: true, kind: 'image' }, base, {
        dataUrl: 'data:' + mime + ';base64,' + Buffer.from(buf).toString('base64'),
      }));
      return;
    }
    sendJson(res, 200, Object.assign({ ok: true, kind: 'binary' }, base));
  }

  // POST /file/save —— 保存文本文件（编辑模式写回）。
  // 约束与预览一致：路径必须落在 root 内、仅白名单文本扩展、仅已存在文件（不新建）、内容 ≤ 2MB。
  async function fileSave(req, res) {
    if (req.method !== 'POST') {
      fail(res, 405, 'method-not-allowed', '仅支持 POST');
      return;
    }
    const root = currentRoot();
    if (!root) {
      fail(res, 409, 'root-missing', '尚未配置知识库根目录');
      return;
    }
    // JSON 包装有转义放大，先放宽传输上限，再用 utf8 字节数精确卡 2MB。
    const raw = await readBody(req, FILE_SAVE_MAX_BYTES);
    if (!raw.ok) {
      fail(res, raw.status, raw.code, raw.message);
      return;
    }
    let body = null;
    try {
      body = JSON.parse(raw.text);
    } catch (err) {
      body = null;
    }
    if (!body || typeof body !== 'object') {
      fail(res, 400, 'invalid-json', '请求体不是合法 JSON 对象');
      return;
    }
    const relPath = typeof body.path === 'string' ? body.path : '';
    if (typeof body.content !== 'string') {
      fail(res, 400, 'content-required', '缺少 content 字段');
      return;
    }
    if (!relPath) {
      fail(res, 400, 'path-required', '缺少 path 参数');
      return;
    }
    const absFile = resolveInsideRoot(root, relPath);
    if (!absFile) {
      fail(res, 400, 'path-out-of-root', '文件路径超出知识库根目录范围');
      return;
    }
    const ext = path.extname(absFile).toLowerCase();
    if (FILE_TEXT_EXTS.indexOf(ext) < 0) {
      fail(res, 415, 'ext-not-editable', '仅支持编辑文本类文件（.md / .txt 等）');
      return;
    }
    let stats;
    try { stats = io.statSync(absFile); } catch (err) { stats = null; }
    if (!stats || !stats.isFile()) {
      fail(res, 404, 'file-not-found', '文件不存在：' + relPath + '（暂不支持新建文件）');
      return;
    }
    if (Buffer.byteLength(body.content, 'utf8') > FILE_TEXT_MAX_BYTES) {
      fail(res, 413, 'content-too-large', '内容超过 2MB 保存上限');
      return;
    }
    try {
      io.writeFileSync(absFile, body.content, 'utf8');
    } catch (err) {
      fail(res, 500, 'file-write-failed', '文件写入失败：' + describeErrno(err));
      return;
    }
    let after = { size: 0, mtimeMs: null };
    try {
      const st = io.statSync(absFile);
      after = { size: typeof st.size === 'number' ? st.size : 0, mtimeMs: typeof st.mtimeMs === 'number' ? st.mtimeMs : null };
    } catch (err) { /* 刚写完读不到就给默认值 */ }
    sendJson(res, 200, {
      ok: true,
      saved: true,
      path: relInsideRoot(root, absFile),
      name: path.basename(absFile),
      ext: ext,
      size: after.size,
      mtimeMs: after.mtimeMs,
    });
  }

  // POST /file/reveal —— 在系统文件管理器中打开文件所在目录并高亮该文件。
  // 约束与预览一致：路径必须落在 root 内、文件必须存在；命令按平台选择（见 revealCommand）。
  async function fileReveal(req, res) {
    if (req.method !== 'POST') {
      fail(res, 405, 'method-not-allowed', '仅支持 POST');
      return;
    }
    const root = currentRoot();
    if (!root) {
      fail(res, 409, 'root-missing', '尚未配置知识库根目录');
      return;
    }
    const raw = await readBody(req, MAX_BODY_BYTES);
    if (!raw.ok) {
      fail(res, raw.status, raw.code, raw.message);
      return;
    }
    let body = null;
    try {
      body = JSON.parse(raw.text);
    } catch (err) {
      body = null;
    }
    if (!body || typeof body !== 'object') {
      fail(res, 400, 'invalid-json', '请求体不是合法 JSON 对象');
      return;
    }
    const relPath = typeof body.path === 'string' ? body.path : '';
    if (!relPath) {
      fail(res, 400, 'path-required', '缺少 path 参数');
      return;
    }
    const absFile = resolveInsideRoot(root, relPath);
    if (!absFile) {
      fail(res, 400, 'path-out-of-root', '文件路径超出知识库根目录范围');
      return;
    }
    let stats;
    try { stats = io.statSync(absFile); } catch (err) { stats = null; }
    if (!stats || !stats.isFile()) {
      fail(res, 404, 'file-not-found', '文件不存在：' + relPath);
      return;
    }
    const command = revealCommand(platform, absFile);
    try {
      // detached + stdio ignore + unref：fire-and-forget，不阻塞请求也不留僵尸进程。
      const child = spawner(command.cmd, command.args, { detached: true, stdio: 'ignore' });
      if (child && typeof child.unref === 'function') child.unref();
    } catch (err) {
      fail(res, 500, 'reveal-failed', '打开所在目录失败：' + describeErrno(err));
      return;
    }
    sendJson(res, 200, {
      ok: true,
      revealed: true,
      path: relInsideRoot(root, absFile),
      name: path.basename(absFile),
      highlighted: command.highlighted,
      command: command.cmd,
      platform: platform,
    });
  }

  // GET /runs/:id、POST /runs/:id/cancel —— 用 prefix 路由，exact 不支持路径参数。
  async function runsScoped(req, res) {
    const pathname = String(req.url || '').split('?')[0];
    const base = ROUTE_PATHS.runs + '/';
    if (pathname.indexOf(base) !== 0) {
      fail(res, 404, 'run-not-found', '未知的 run 路径');
      return;
    }
    const rest = pathname.slice(base.length).split('/');
    const id = rest[0];
    const tail = rest[1] || '';
    if (!trace.isSafeRunId(id)) {
      fail(res, 404, 'run-not-found', 'run 不存在');
      return;
    }
    const root = currentRoot();
    if (!root) {
      fail(res, 404, 'run-not-found', '尚未配置知识库根目录');
      return;
    }

    if (!tail) {
      if (req.method !== 'GET') {
        fail(res, 405, 'method-not-allowed', '仅支持 GET');
        return;
      }
      const data = trace.readRun(root, id);
      if (!data) {
        fail(res, 404, 'run-not-found', 'run 不存在：' + id);
        return;
      }
      // recovery 只读：只算建议动作，不产生任何副作用。
      const recovery = checkpoint.decideRecovery({
        run: data.run,
        checkpoint: checkpoint.readCheckpoint(root, id),
        engineVersion: ENGINE_VERSION,
      });
      sendJson(res, 200, { ok: true, run: data.run, steps: data.steps, recovery: recovery });
      return;
    }

    if (tail === 'cancel') {
      if (req.method !== 'POST') {
        fail(res, 405, 'method-not-allowed', '仅支持 POST');
        return;
      }
      if (!runs || typeof runs.cancel !== 'function') {
        fail(res, 503, 'orchestrator-unavailable', '编排层未启用');
        return;
      }
      const result = await runs.cancel(id);
      if (!result || result.ok !== true) {
        fail(res, (result && result.status) || 404, (result && result.error && result.error.code) || 'run-not-found', (result && result.error && result.error.message) || 'run 不存在');
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (tail === 'recover') {
      if (req.method !== 'POST') {
        fail(res, 405, 'method-not-allowed', '仅支持 POST');
        return;
      }
      const body = await readJson(req, res);
      if (!body) return;
      const action = body.action === 'restart' ? 'restart'
        : (body.action === 'resume' ? 'resume' : (body.action === 'abandon' ? 'abandon' : null));
      if (!action) {
        fail(res, 400, 'action-invalid', 'action 只能是 resume / restart / abandon');
        return;
      }
      if (!runs || typeof runs.recover !== 'function') {
        fail(res, 503, 'orchestrator-unavailable', '编排层未启用');
        return;
      }
      const result = await runs.recover(id, action);
      if (!result || result.ok !== true) {
        sendJson(res, (result && result.status) || 409, {
          ok: false,
          error: (result && result.error) || { code: 'recovery-failed', message: '恢复失败' },
        });
        return;
      }
      const payload = { ok: true, runId: result.runId };
      if (typeof result.status === 'string') payload.status = result.status;
      sendJson(res, 200, payload);
      return;
    }

    fail(res, 404, 'run-not-found', '未知的 run 子路径：' + tail);
  }

  async function startRun(req, res) {
    if (req.method !== 'POST') {
      fail(res, 405, 'method-not-allowed', '仅支持 POST');
      return;
    }
    const body = await readJson(req, res);
    if (!body) return;
    if (!runs || typeof runs.start !== 'function') {
      fail(res, 503, 'orchestrator-unavailable', '编排层未启用');
      return;
    }
    // kind=archive 的输入在启动前就要挡掉：items 为空或某条缺 reason 都不该起 run。
    if (body.kind === 'archive') {
      const input = body.input && typeof body.input === 'object' ? body.input : {};
      const items = Array.isArray(input.items) ? input.items : [];
      if (items.length === 0) {
        fail(res, 400, 'empty-items', 'items 不能为空');
        return;
      }
      const badReason = items.filter((item) => !item || typeof item.reason !== 'string' || Array.from(item.reason.trim()).length < 4);
      if (badReason.length > 0) {
        fail(res, 400, 'reason-required', '每个 item 都必须写 reason（至少 4 个字符）');
        return;
      }
    }
    // 注意：这里不 reap。preflight 必须在任何写盘之前；reap 由 start 在预检通过后执行。
    const result = await runs.start({ kind: body.kind, mode: body.mode, force: body.force, input: body.input });
    if (!result || result.ok !== true) {
      const status = (result && result.status) || 400;
      const code = (result && result.error && result.error.code) || 'run-start-failed';
      const message = (result && result.error && result.error.message) || 'run 启动失败';
      if (status === 422) {
        const checks = result && result.error && Array.isArray(result.error.checks) ? result.error.checks : [];
        sendJson(res, 422, { ok: false, error: { code: code, message: message, checks: checks } });
        return;
      }
      fail(res, status, code, message);
      return;
    }
    sendJson(res, 200, { ok: true, runId: result.runId });
  }

  return {
    health: wrap(health),
    config: wrap(config),
    validate: wrap(validate),
    save: wrap(save),
    readConfig: wrap(readConfig),
    runsList: wrap(runsList),
    preflight: wrap(preflight),
    skillsList: wrap(skillsList),
    reportsList: wrap(reportsList),
    dashboard: wrap(dashboard),
    doctorGet: wrap(doctorGet),
    doctorRepair: wrap(doctorRepair),
    expertsList: wrap(expertsList),
    expertsScoped: wrap(expertsScoped),
    skillRegistry: wrap(skillRegistry),
    skillCalls: wrap(skillCalls),
    reportDetail: wrap(reportDetail),
    ledgerCalendar: wrap(ledgerCalendar),
    ledgerDay: wrap(ledgerDay),
    filesList: wrap(filesList),
    fileEntry: wrap(fileEntry),
    fileSave: wrap(fileSave),
    fileReveal: wrap(fileReveal),
    runsScoped: wrap(runsScoped),
    startRun: wrap(startRun),
  };
}

function registerOne(webServer, routePath, handler) {
  const dispose = webServer.register({ kind: 'exact', path: routePath, handler: handler });
  return typeof dispose === 'function' ? dispose : null;
}

function registerPrefix(webServer, routePath, handler) {
  const dispose = webServer.register({ kind: 'prefix', path: routePath, handler: handler });
  return typeof dispose === 'function' ? dispose : null;
}

/** 把三条 path（四条行为）注册进 webServer；缺 webServer 时返回空数组，不抛。 */
export function registerRoutes(ctx, options) {
  const webServer = ctx && ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') return [];
  const handlers = createHandlers(Object.assign({ ctx: ctx }, options));
  const disposers = [
    registerOne(webServer, ROUTE_PATHS.health, handlers.health),
    registerOne(webServer, ROUTE_PATHS.config, handlers.config),
    registerOne(webServer, ROUTE_PATHS.validate, handlers.validate),
    registerOne(webServer, ROUTE_PATHS.run, handlers.startRun),
    registerOne(webServer, ROUTE_PATHS.preflight, handlers.preflight),
    registerOne(webServer, ROUTE_PATHS.skills, handlers.skillsList),
    registerOne(webServer, ROUTE_PATHS.reports, handlers.reportsList),
    registerOne(webServer, ROUTE_PATHS.dashboard, handlers.dashboard),
    registerOne(webServer, ROUTE_PATHS.doctor, handlers.doctorGet),
    registerOne(webServer, ROUTE_PATHS.doctorRepair, handlers.doctorRepair),
    registerOne(webServer, ROUTE_PATHS.experts, handlers.expertsList),
    // exact 不支持路径参数：/experts/:id 与 /experts/:id/archive 走 prefix 路由。
    registerPrefix(webServer, ROUTE_PATHS.experts, handlers.expertsScoped),
    registerOne(webServer, ROUTE_PATHS.skillRegistry, handlers.skillRegistry),
    registerOne(webServer, ROUTE_PATHS.skillCalls, handlers.skillCalls),
    // exact 不支持路径参数：/reports/:id 走 prefix 路由。
    registerPrefix(webServer, ROUTE_PATHS.reports, handlers.reportDetail),
    registerOne(webServer, ROUTE_PATHS.ledgerCalendar, handlers.ledgerCalendar),
    registerOne(webServer, ROUTE_PATHS.ledgerDay, handlers.ledgerDay),
    registerOne(webServer, ROUTE_PATHS.files, handlers.filesList),
    registerOne(webServer, ROUTE_PATHS.file, handlers.fileEntry),
    registerOne(webServer, ROUTE_PATHS.fileSave, handlers.fileSave),
    registerOne(webServer, ROUTE_PATHS.fileReveal, handlers.fileReveal),
    registerOne(webServer, ROUTE_PATHS.runs, handlers.runsList),
    // exact 不支持路径参数：/runs/:id 与 /runs/:id/cancel 走 prefix 路由。
    registerPrefix(webServer, ROUTE_PATHS.runs, handlers.runsScoped),
  ].filter((fn) => typeof fn === 'function');
  return disposers;
}
