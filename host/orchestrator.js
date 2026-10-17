/**
 * 多 agent 编排层。
 *
 * 设计：
 * - run 的唯一真源在 host/trace.js（<root>/.jkkb/runs/），本文件只做"起 run / 起子代理 / 收尾"。
 * - 优先起一个编排官子代理（spawn），由它按 bootstrap → verify → reindex 调 jk_kb_* 工具；
 *   拿不到模型 route、宿主没有 subagents、或起子代理失败时**降级**为插件自己顺序调引擎，
 *   并把 run.degraded 标成 'no-route' / 'no-agent'，step 的 role 写 'PLUGIN'——绝不假装是 agent 干的。
 * - 引擎调用一律走 host/engine/index.js（bootstrap/verify/reindex），onStep 直接转成 step。
 */
import fs from 'node:fs';
import path from 'node:path';

import * as engine from './engine/index.js';
import { ENGINE_VERSION } from './engine/index.js';
import * as trace from './trace.js';
import * as checkpoint from './checkpoint.js';
import * as backup from './backup.js';
import * as ledger from './ledger.js';
import * as curateModule from './engine/curate.js';
import * as maintainModule from './engine/maintain.js';
import { byId as skillsById, SKILLS } from './skills/catalog.js';
import { createRepos } from './store/index.js';
import { buildReportRecord, performArchive, renderMaintainMarkdown, saveMaintainReport, summarizeByRule, writeReportFile } from './tools.js';

export const ORCH_LABEL = 'JKKB-ORCH';

// 子代理只允许看到这 6 个工具，避免它能改宿主其它东西。
export const ALLOWED_TOOLS = [
  'jk_kb_bootstrap',
  'jk_kb_verify',
  'jk_kb_reindex',
  'jk_kb_inspect',
  'jk_kb_step',
  'jk_kb_run_finish',
];

export const RUN_KINDS = ['bootstrap', 'verify', 'reindex', 'curate', 'maintain', 'skill', 'archive'];

export const RUN_TITLES = {
  bootstrap: '建库 / 补齐结构',
  verify: '体检',
  reindex: '重建索引',
  curate: '入柜（按技能写卡）',
  maintain: '整理报告（只读扫描）',
  skill: '创建 / 升级 SKILL',
  archive: '归档（破坏性，需确认）',
};

const curateEngine = engine && typeof engine.curate === 'function' ? engine.curate : curateModule.curate;
const maintainEngine = engine && typeof engine.maintain === 'function' ? engine.maintain : maintainModule.maintain;

/** 47 条技能 brief（id / 名称 / 岗位 / 阶段 / 用途），供编排官选技能。 */
export function skillsBriefText() {
  return SKILLS.map((skill) => '- ' + skill.id + ' ｜ ' + skill.name + ' ｜ 岗位=' + skill.profession
    + ' ｜ 阶段=' + skill.stage + ' ｜ ' + skill.purpose).join('\n');
}

/** 可选服务统一走 ctx.get：cordis 是严格服务门禁，直接读未 inject 的服务属性会抛。 */
export function serviceOf(ctx, name) {
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch (err) {
    return undefined;
  }
}

export const PREFLIGHT_LIMITS = Object.freeze({ maxFiles: 5000, minFreeBytes: 200 * 1024 * 1024 });
export const REQUIRED_TOOLS = ['jk_kb_bootstrap', 'jk_kb_verify', 'jk_kb_reindex'];

/** settings.limits 覆盖默认值；缺省 / 脏值一律回落默认。 */
export function preflightLimits(settings) {
  const raw = settings && typeof settings === 'object' && settings.limits && typeof settings.limits === 'object' ? settings.limits : {};
  const maxFiles = Number.isFinite(raw.maxFiles) && raw.maxFiles > 0 ? Math.floor(raw.maxFiles) : PREFLIGHT_LIMITS.maxFiles;
  const minFreeBytes = Number.isFinite(raw.minFreeBytes) && raw.minFreeBytes >= 0 ? Math.floor(raw.minFreeBytes) : PREFLIGHT_LIMITS.minFreeBytes;
  return { maxFiles: maxFiles, minFreeBytes: minFreeBytes };
}

/**
 * 轻量可写探针：只写 <root>/.jkkb/runs/ 下的临时文件，写完立刻删。
 * 运行中复检用它（不重跑文件计数）。
 */
export function probeRootWritable(root) {
  const dir = path.join(String(root), '.jkkb', 'runs');
  const file = path.join(dir, '.preflight-' + process.pid + '-' + Date.now().toString(36) + '.tmp');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, 'probe\n', 'utf8');
    try { fs.unlinkSync(file); } catch (cleanupErr) { /* 删不掉也说明可写 */ }
    return { ok: true, errno: null };
  } catch (err) {
    try { fs.unlinkSync(file); } catch (cleanupErr) { /* 可能压根没建出来 */ }
    const code = err && err.code ? err.code : 'UNKNOWN';
    return { ok: false, errno: code + ': ' + (err && err.message ? err.message : String(err)) };
  }
}

function hostChecks(deps, settings, root) {
  const checks = [];
  const ack = settings && settings.rootRiskAck && settings.rootConfirmedAt;
  let realMatches = false;
  let real = null;
  try {
    real = fs.realpathSync(root);
    // 两侧都 realpath 后再比：macOS 的 /var → /private/var 属正常重定向，不算不一致。
    const realSaved = fs.realpathSync(String(settings.root));
    realMatches = path.resolve(real) === path.resolve(realSaved);
    // 保存的路径本身若是软链（可被人工改指），视为不一致。
    try {
      if (fs.lstatSync(String(settings.root)).isSymbolicLink()) realMatches = false;
    } catch (lstatErr) { /* 拿不到 lstat 就按上面的结果 */ }
  } catch (err) {
    realMatches = false;
  }
  if (!ack) {
    checks.push({
      id: 'authorization',
      code: 'ROOT_NOT_AUTHORIZED',
      level: 'error',
      title: '根目录授权',
      detail: 'settings.json 缺少风险确认记录（rootRiskAck / rootConfirmedAt）：' + String(root),
      fix: '回到「设置 → JK知识库」重新选择根目录并勾选风险确认',
    });
  } else if (!realMatches) {
    checks.push({
      id: 'authorization',
      code: 'ROOT_NOT_AUTHORIZED',
      level: 'error',
      title: '根目录授权',
      detail: 'settings.root 与磁盘 realpath 不一致：' + String(settings.root) + ' → ' + String(real),
      fix: '在设置页重新保存根目录（路径可能被移动或软链改指）',
    });
  } else {
    checks.push({ id: 'authorization', level: 'ok', title: '根目录授权', detail: '已确认：' + String(real) });
  }

  const hasToolState = !!(deps && typeof deps.toolState === 'function');
  const state = hasToolState ? deps.toolState() : null;
  const registered = state && Array.isArray(state.registered) ? state.registered : [];
  const missing = hasToolState ? REQUIRED_TOOLS.filter((name) => registered.indexOf(name) < 0) : [];
  if (!hasToolState) {
    checks.push({ id: 'tools', level: 'ok', title: '工具注册', detail: '未接入工具服务（跳过检查）' });
  } else if (missing.length > 0) {
    checks.push({
      id: 'tools',
      code: 'TOOLS_MISSING',
      level: 'error',
      title: '工具注册',
      detail: '缺少工具：' + missing.join('、'),
      fix: '重启 DSH 让插件重新注册；仍缺失时看 /health 的 tools.failed',
    });
  } else {
    checks.push({ id: 'tools', level: 'ok', title: '工具注册', detail: REQUIRED_TOOLS.length + ' 个必备工具在线' });
  }

  if (!resolveRoute(deps && deps.ctx)) {
    checks.push({
      id: 'route',
      code: 'NO_ROUTE',
      level: 'warn',
      title: '模型路由',
      detail: '没有可用的默认模型 / agent 路由：本次将降级为插件顺序执行（degraded=no-route）',
      fix: '在设置里配置默认模型以启用编排官',
    });
  } else {
    checks.push({ id: 'route', level: 'ok', title: '模型路由', detail: '可用' });
  }

  const lock = trace.readLock(root);
  if (lock) {
    const age = Date.now() - Date.parse(lock.heartbeatAt);
    if (Number.isFinite(age) && age <= trace.LOCK_STALE_MS) {
      checks.push({
        id: 'lock',
        code: 'LOCK_HELD',
        level: 'error',
        title: '运行锁',
        detail: '锁被占用：runId=' + lock.runId + '，心跳 ' + Math.round(age / 1000) + 's 前',
        fix: '等待该 run 结束；确认无进程在跑后可在知识库根目录的 .jkkb 中删除 lock.json',
      });
    }
  }
  return checks;
}

/**
 * 宿主侧预检：engine.preflight（只读 + 白名单探针）+ 宿主检查（授权 / 工具 / 路由 / 锁）。
 * @returns {{status:number, ok:boolean, report:object|null, error?:object}}
 */
export async function runHostPreflight(deps, args) {
  const d = deps || {};
  const settings = d.store && typeof d.store.get === 'function' ? d.store.get() : null;
  const root = settings && typeof settings.root === 'string' && settings.root ? settings.root : null;
  if (!root) {
    return { status: 409, ok: false, report: null, error: { code: 'root-missing', message: '尚未配置知识库根目录' } };
  }
  const limits = preflightLimits(settings);
  const kind = args && typeof args.kind === 'string' ? args.kind : 'bootstrap';
  const mode = args && args.mode === 'topic' ? 'topic' : 'asset';

  let report;
  const skipFileScan = kind === 'curate' || kind === 'archive';
  // 入柜 / 归档不需要扫全库：把计数上限放大、时间预算压到 1ms（引擎内部会立即截断）。
  const engineLimits = skipFileScan
    ? Object.assign({}, limits, { maxFiles: Number.MAX_SAFE_INTEGER, timeBudgetMs: 1 })
    : limits;
  const enginePreflight = engine && typeof engine.preflight === 'function' ? engine.preflight : null;
  if (enginePreflight) {
    report = await enginePreflight({ root: root, mode: mode, kind: kind, limits: engineLimits });
  } else {
    report = {
      ok: true,
      code: 'OK',
      checks: [{ id: 'engine', level: 'warn', title: '预检引擎', detail: 'engine.preflight 不可用，已跳过只读预检' }],
      counts: { files: 0, notes: 0, limit: limits.maxFiles, truncated: false },
      freeBytes: null,
      elapsedMs: 0,
    };
  }

  if (skipFileScan) {
    // 明确标注：本次未做文件数预检。
    report.checks = (Array.isArray(report.checks) ? report.checks : []).map((check) => (
      check && check.id === 'files'
        ? Object.assign({}, check, { level: 'ok', detail: '本次未做文件数预检（入柜不需要扫全库）' })
        : check
    )).concat([{
      id: kind + '-no-file-scan',
      level: 'ok',
      title: '文件数预检',
      detail: '本次未做文件数预检（入柜不需要扫全库）',
    }]);
  }
  const merged = (Array.isArray(report.checks) ? report.checks.slice() : []).concat(hostChecks(d, settings, root));
  const firstError = merged.filter((item) => item && item.level === 'error')[0];
  const ok = report.ok !== false && !firstError;
  const code = report.ok === false ? (report.code || 'ROOT_UNAVAILABLE') : (firstError ? (firstError.code || firstError.id) : 'OK');
  return {
    status: 200,
    ok: ok,
    report: {
      ok: ok,
      code: code,
      checks: merged,
      counts: report.counts || { files: 0, notes: 0, limit: limits.maxFiles },
      freeBytes: report.freeBytes === undefined ? null : report.freeBytes,
      elapsedMs: report.elapsedMs === undefined ? 0 : report.elapsedMs,
    },
  };
}

function preflightMessage(report) {
  const failed = (report && Array.isArray(report.checks) ? report.checks : []).filter((item) => item && item.level === 'error');
  const detail = failed.map((item) => item.detail).filter(Boolean).join('；') || '预检未通过';
  return '预检未通过（' + (report && report.code ? report.code : 'PREFLIGHT_FAILED') + '）：' + detail;
}

/**
 * 传给引擎的 shouldAbort：返回字符串即中断原因，返回 false 继续。
 * 判定：signal 已 abort / run.cancelRequestedAt 非空 / now > run.deadlineAt。
 */
export function makeShouldAbort(args) {
  const a = args || {};
  return function shouldAbort() {
    try {
      if (a.signal && a.signal.aborted) return 'run 已取消（signal aborted）';
      const current = trace.readRun(a.root, a.runId);
      if (!current) return 'run 记录不存在';
      if (current.run.cancelRequestedAt) return '收到取消请求（cancelRequestedAt=' + current.run.cancelRequestedAt + '）';
      const deadlineMs = Date.parse(current.run.deadlineAt || '');
      if (Number.isFinite(deadlineMs) && Date.now() > deadlineMs) {
        return '超过运行预算（deadline=' + current.run.deadlineAt + '）';
      }
      return false;
    } catch (err) {
      return 'shouldAbort 检查失败：' + (err && err.message ? err.message : err);
    }
  };
}

/** 取 model route：优先默认模型服务，回退第一个 root agent 的 options；缺 provider/model 即视为没有。 */
export function resolveRoute(ctx) {
  try {
    const service = ctx && typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null;
    const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null;
    if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string' && selection.provider && selection.model) {
      return {
        provider: selection.provider,
        model: selection.model,
        source: 'default',
        ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
      };
    }
  } catch (err) { /* 服务没装 / 没配置，继续回退 */ }
  try {
    const agents = serviceOf(ctx, 'agents');
    const roots = agents && typeof agents.roots === 'function' ? agents.roots() : [];
    const options = roots && roots[0] && roots[0].options ? roots[0].options : null;
    if (options && typeof options.provider === 'string' && typeof options.model === 'string' && options.provider && options.model) {
      return { provider: options.provider, model: options.model, source: 'agent' };
    }
  } catch (err) { /* 同上 */ }
  return null;
}

function firstLiveAgent(list) {
  if (!Array.isArray(list)) return null;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i]) return list[i];
  }
  return null;
}

/** parent 取第一个活 agent：agents.list() 优先（宿主内部用的是它），roots() 兜底。 */
export function pickParent(ctx) {
  const agents = serviceOf(ctx, 'agents');
  try {
    if (agents && typeof agents.list === 'function') {
      const found = firstLiveAgent(agents.list());
      if (found) return found;
    }
  } catch (err) { /* 继续回退 */ }
  try {
    if (agents && typeof agents.roots === 'function') {
      return firstLiveAgent(agents.roots());
    }
  } catch (err) { /* 没有就是没有 */ }
  return null;
}

/** subagent provider：list() 里有 'spawn' 就用 spawn，否则取第一个；没有 provider 返回 null。 */
export function resolveSubagentProvider(ctx) {
  try {
    const subagents = serviceOf(ctx, 'subagents');
    if (!subagents || typeof subagents.list !== 'function') return null;
    const names = subagents.list();
    if (!Array.isArray(names) || names.length === 0) return null;
    const usable = names.filter((name) => typeof name === 'string' && name);
    if (usable.length === 0) return null;
    return usable.indexOf('spawn') >= 0 ? 'spawn' : usable[0];
  } catch (err) {
    return null;
  }
}

/** `run.result.output` 是内容分片数组；把 part.text 拼成纯文本。 */
export function outputText(output) {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map((part) => {
      if (!part) return '';
      if (typeof part === 'string') return part;
      if (typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  if (typeof output === 'object' && typeof output.text === 'string') return output.text;
  return '';
}

export function truncate(text, max) {
  const value = String(text === null || text === undefined ? '' : text);
  const limit = typeof max === 'number' && max > 0 ? max : 500;
  return value.length > limit ? value.slice(0, limit) + '…' : value;
}

/** stopReason → run 终态：completed / aborted(→cancelled) / 其它（→failed）。 */
export function statusFromStopReason(stopReason) {
  if (stopReason === 'completed') return 'completed';
  if (stopReason === 'aborted' || stopReason === 'cancelled') return 'cancelled';
  return 'failed';
}

/** 编排官宪章：普通建库/体检/重建索引。 */
function buildStandardCharter(root, runId) {
  return [
    '你是 JK知识库 的编排官（JKKB-ORCH），只负责调度，不直接读写任何文件。',
    '根目录：' + root,
    '本次 runId：' + runId,
    '',
    '规则：',
    '1. 严格按 bootstrap → verify → reindex 顺序执行；每一步都必须调用对应的工具，且每次调用都要带 runId=' + runId + '。',
    '2. 需要观察状态时调用 jk_kb_inspect；要补充说明时调用 jk_kb_step。',
    '3. 任意一步返回 ok:false，立即停止：调用 jk_kb_run_finish({ runId, status:"failed", summary:"<失败步骤与原因>" })，不要再重试。',
    '4. 全部成功：调用 jk_kb_run_finish({ runId, status:"completed", summary:"<一句话结果>" })。',
    '5. 除上述 jk_kb_* 工具外不要调用任何工具；不要修改文件；不要新建 run。',
  ].join('\n');
}

/**
 * 解析本次 run 指定的业务专家（存在且 active 才可用）。
 * 返回 { expert, skillLines, unavailable, warning }；无 expertId 时全部为空。
 */
export function resolveExpertContext(root, input) {
  const source = input && typeof input === 'object' ? input : {};
  const expertId = typeof source.expertId === 'string' && source.expertId.trim() ? source.expertId.trim() : '';
  if (!expertId) return { expertId: '', expert: null, unavailable: '', warning: null };
  if (!root) return { expertId: expertId, expert: null, unavailable: '知识库根目录未知', warning: 'expert-unavailable: ' + expertId + '（根目录未知）' };
  let expert = null;
  try {
    expert = createRepos({ root: root }).expertsRepo.get(expertId);
  } catch (err) {
    expert = null;
  }
  if (!expert) {
    return { expertId: expertId, expert: null, unavailable: '专家不存在', warning: 'expert-unavailable: ' + expertId + '（不存在）' };
  }
  if (String(expert.status || 'active') !== 'active') {
    return { expertId: expertId, expert: expert, unavailable: '专家已归档', warning: 'expert-unavailable: ' + expertId + '（已归档）' };
  }
  return { expertId: expertId, expert: expert, unavailable: '', warning: null };
}

/** 把专家的绑定技能 id 翻成「id 名称」。 */
function expertSkillNames(expert, root) {
  const ids = Array.isArray(expert && expert.skillIds) ? expert.skillIds : [];
  return ids.map((id) => {
    const builtin = skillsById.get(id);
    if (builtin) return id + ' ' + builtin.name;
    try {
      const record = root ? createRepos({ root: root }).skillsRepo.get(id) : null;
      if (record) return id + ' ' + record.name;
    } catch (err) { /* 查不到就只留 id */ }
    return id;
  });
}

/** kind=curate 的宪章：47 条技能 brief + 用户输入 + 置信度规则。 */
export function buildCurateCharter(args) {
  const a = args || {};
  const root = a.root || '';
  const runId = a.runId || '';
  const input = a.input && typeof a.input === 'object' ? a.input : {};
  const text = typeof input.text === 'string' ? input.text : '';
  const expertCtx = resolveExpertContext(root, input);
  const expertLines = [];
  if (expertCtx.expertId) {
    expertLines.push('', '本次由专家处理：');
    if (expertCtx.unavailable) {
      expertLines.push('- 指定的专家不可用（' + expertCtx.unavailable + '）：' + expertCtx.expertId + '，本次按通用流程处理。');
    } else {
      const expert = expertCtx.expert;
      expertLines.push('- 专家：' + expert.id + ' ｜ ' + expert.name + ' ｜ 领域：' + expert.domain);
      expertLines.push('- 职责：' + expert.responsibility);
      if (expert.promptFragment) expertLines.push('- 提示词片段：' + expert.promptFragment);
      const names = expertSkillNames(expert, root);
      expertLines.push('- 绑定技能：' + (names.length > 0 ? names.join('、') : '（未绑定）'));
      const boundIds = Array.isArray(expert.skillIds) ? expert.skillIds : [];
      if (typeof input.skillId === 'string' && input.skillId && boundIds.length > 0 && boundIds.indexOf(input.skillId) < 0) {
        expertLines.push('- ⚠️ 用户指定技能 ' + input.skillId + ' 不在该专家绑定范围内，请先确认。');
      }
    }
    expertLines.push('');
  }
  return [
    '你是 JK知识库 的入柜编排官，只负责调度，不直接写文件。',
    '根目录：' + root,
    '本次 runId：' + runId,
    '',
    '任务：把下面这段用户输入，按最合适的技能入柜成一张正式卡片。',
    '',
    '规则：',
    '1. 先判定技能：从下面的 47 条技能里挑一条。**不确定就先问用户，不要猜**（用 jk_kb_step 记录你的疑问并停下）。',
    '2. 调用 jk_kb_curate({ runId, skillId, title, body, tags, confidence, confWhy, source })，runId 必须是 ' + runId + '。',
    '3. **不得编造 confidence**：只能依据输入里的信息判断「高/中/低」。',
    '4. 置信度为「低」时**必须**在 confWhy 里写清理由（≥4 字符），没有理由不允许落盘。',
    '5. tags 至少 1 个；title ≤ 120 字符；body 用用户原文，不要凭空扩写。',
    '6. 成功后调用 jk_kb_run_finish({ runId: "' + runId + '", status: "completed", summary: "<技能 + 卡片路径>" })；失败则 status:"failed" 并写清原因。',
    '7. 若用户指定了业务专家（形如 EXP-001），调用 jk_kb_curate 时传 expertId；没指定就不要传。',
    '8. 除 jk_kb_curate / jk_kb_step / jk_kb_run_finish 外不要调用其它工具。',
  ].concat(expertLines).concat([
    '技能目录（47 条：id ｜ 名称 ｜ 岗位 ｜ 阶段 ｜ 用途）：',
    skillsBriefText(),
    '',
    '用户输入：',
    text || '（空）',
  ]).join('\n');
}

/** kind=maintain 的宪章：只读扫描、绝不移动/删除、按规则分组汇报。 */
export function buildMaintainCharter(args) {
  const a = args || {};
  const input = a.input && typeof a.input === 'object' ? a.input : {};
  return [
    '你是 JK知识库 的整理报告编排官，只负责调度，不写文件。',
    '根目录：' + a.root,
    '本次 runId：' + a.runId,
    '',
    '规则：',
    '1. 只调用 jk_kb_maintain({ runId: "' + a.runId + '", thresholds? })，它是**只读扫描**。',
    '2. **绝不移动或删除任何文件**：本版本没有任何执行类工具；你也不能用其它工具去改文件。',
    '3. 按规则分组汇报结果（M01 收件箱超期 / M03 低置信度未验证 / M04 溯源链断链 / M08 缺置信度标记），每组给命中数与典型条目。',
    '4. 敏感项（例如低置信度且长期未验证的卡片）只能**提示用户确认后再处理**，不要自行决定。',
    '5. 成功后调用 jk_kb_run_finish({ runId: "' + a.runId + '", status: "completed", summary: "<四类命中数 + 报告路径>" })；失败则 status:"failed" 并写清原因。',
    '6. 除 jk_kb_maintain / jk_kb_step / jk_kb_run_finish 外不要调用其它工具。',
    '7. 专家配置不参与本类任务：业务专家（EXP）只影响入柜，不要按专家设定改变扫描口径。',
    input.thresholds ? '用户指定的阈值：' + JSON.stringify(input.thresholds) : '阈值：使用默认值（M01=7 天、M03=30 天）。',
  ].join('\n');
}

/** kind=skill 的宪章：先问清要素，NEED_CONFIRM 必须复述风险并等用户确认。 */
export function buildSkillCharter(args) {
  const a = args || {};
  const input = a.input && typeof a.input === 'object' ? a.input : {};
  return [
    '你是 JK知识库 的 SKILL 编排官，只负责调度，不直接写文件。',
    '根目录：' + a.root,
    '本次 runId：' + a.runId,
    '',
    '规则：',
    '1. 先用 jk_kb_skill_find 查库里是否已有相关 SKILL，再动手。',
    '2. 创建前必须问清 5 个要素：name（名称）、purpose（一句话用途）、scenario（适用场景）、keywords（关键词）、fields（记录字段）。**缺哪个就问哪个，不要替用户编造**。',
    '3. 调用 jk_kb_skill_create({ runId: "' + a.runId + '", name, purpose, scenario, keywords, fields })。',
    '4. 返回 NEED_CONFIRM 时：把 matches 里的重复 / 相似 SKILL（id、名称、版本、相似度）复述给用户，**等待用户明确确认**；**绝不自行传 confirm:true**。',
    '5. 用户确认后，再调一次 jk_kb_skill_create 并带上 confirm:true。同名会升级版本（第三段 +1），旧页会归档到 12_归档与历史/03_历史版本。',
    '6. 成功后调用 jk_kb_run_finish({ runId: "' + a.runId + '", status: "completed", summary: "<SK id + 版本 + 页面路径>" })；失败 status:"failed" 并写清原因。',
    '7. 除 jk_kb_skill_* 与 jk_kb_run_finish 外不要调用其它工具。',
    input.name ? '用户已给出的名称：' + input.name : '用户尚未给出名称。',
    input.text ? '用户输入：' + input.text : '',
  ].filter(Boolean).join('\n');
}

/** kind=archive 的宪章：破坏性操作，只能按用户给定的 items 执行。 */
export function buildArchiveCharter(args) {
  const a = args || {};
  const input = a.input && typeof a.input === 'object' ? a.input : {};
  const items = Array.isArray(input.items) ? input.items : [];
  const confirmed = input.confirmed === true;
  return [
    '你是 JK知识库 的归档编排官，只负责调度，不直接改文件。',
    '根目录：' + a.root,
    '本次 runId：' + a.runId,
    '',
    '**这是破坏性操作（会把文件移走）**，规则：',
    '1. items 只能来自用户选择：**不得自行扩项、不得臆造路径、不得替用户决定**。用户给几项就处理几项。',
    '2. 只有用户已明确确认时才允许执行；本 run 的确认状态：' + (confirmed ? '已确认（true）' : '**未确认**'),
    confirmed
      ? '3. 调用 jk_kb_archive({ runId: "' + a.runId + '", items, confirm: true })。'
      : '3. 未确认：**不要调用 jk_kb_archive**，先向用户复述将要移动的条目并等待其确认。',
    '4. 返回后逐条汇报 moved / failed；目录项与文件项一样支持归档（moved 里 kind=dir，整棵目录树已移动、首页会自动补四要素），失败项只在 failed 里逐条说明原因。',
    '5. 成功后调用 jk_kb_run_finish({ runId: "' + a.runId + '", status: "completed", summary: "moved=X failed=Y" })。',
    '6. 除 jk_kb_archive / jk_kb_step / jk_kb_run_finish 外不要调用其它工具。',
    '7. 专家配置不参与本类任务：业务专家（EXP）只影响入柜，不要按专家设定改变归档范围。',
    '',
    '用户选中的 items：',
    items.length === 0 ? '（空）' : items.map((item) => '- ' + (item && item.relPath ? item.relPath : '') + ' ｜ 原因：' + (item && item.reason ? item.reason : '（未填）')).join('\n'),
  ].join('\n');
}

export function buildCharter(args) {
  const a = args || {};
  if (a.kind === 'curate') return buildCurateCharter(a);
  if (a.kind === 'maintain') return buildMaintainCharter(a);
  if (a.kind === 'skill') return buildSkillCharter(a);
  if (a.kind === 'archive') return buildArchiveCharter(a);
  return buildStandardCharter(a.root || '', a.runId || '');
}

function disposeActivation(activation) {
  if (!activation) return;
  try {
    if (typeof activation.dispose === 'function') { activation.dispose(); return; }
    if (activation.handle && typeof activation.handle.dispose === 'function') { activation.handle.dispose(); return; }
    if (activation.activation && typeof activation.activation.dispose === 'function') activation.activation.dispose();
  } catch (err) { /* 释放失败不影响 run 收尾 */ }
}

async function awaitActivation(activation) {
  if (!activation) return null;
  if (activation.result && typeof activation.result.then === 'function') return activation.result;
  if (typeof activation.then === 'function') return activation;
  return null;
}

function summaryOfResult(result) {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result.slice(0, 2000);
  try {
    const text = JSON.stringify(result);
    return text.length > 2000 ? text.slice(0, 2000) + '…' : text;
  } catch (err) {
    return String(result).slice(0, 2000);
  }
}

function failedByResult(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.ok === false) return true;
  if (typeof result.status === 'string' && (result.status === 'failed' || result.status === 'error')) return true;
  return false;
}

/**
 * @param {{ctx: any, store: any}} deps
 */
export function createRunService(deps) {
  const ctx = deps && deps.ctx;
  const store = deps && deps.store;
  const toolWarnings = deps && typeof deps.toolWarnings === 'function' ? deps.toolWarnings : null;
  const toolState = deps && typeof deps.toolState === 'function' ? deps.toolState : null;
  // 引擎可注入（测试用假引擎验证 shouldAbort / ABORTED 路径）。
  const engineApi = (deps && deps.engine) || engine;
  const active = new Map(); // runId -> { root, controller }

  function resolveRoot() {
    const settings = store && typeof store.get === 'function' ? store.get() : null;
    return settings && typeof settings.root === 'string' && settings.root ? settings.root : null;
  }

  function abortStatus(a, err) {
    try {
      const current = trace.readRun(a.root, a.runId);
      if (current && current.run.cancelRequestedAt) return 'cancelled';
      const deadlineMs = current ? Date.parse(current.run.deadlineAt || '') : NaN;
      if (Number.isFinite(deadlineMs) && Date.now() > deadlineMs) return 'timed_out';
    } catch (ignore) { /* 读不到就按失败处理 */ }
    return 'failed';
  }

  async function executeSequential(args) {
    const a = args;
    const collector = trace.createStepCollector({ root: a.root, runId: a.runId, role: 'PLUGIN' });
    const baseShouldAbort = typeof a.shouldAbort === 'function'
      ? a.shouldAbort
      : makeShouldAbort({ root: a.root, runId: a.runId, signal: a.signal });

    // 运行中复检：每 15 个 step 或每 60s（先到者）跑一次轻量可写探针；失败即中断。
    let runtimeAbort = null;
    let stepCount = 0;
    let lastRecheck = Date.now();
    const checkpointPending = [];
    const shouldAbort = () => runtimeAbort || baseShouldAbort();
    const recordCheckpoint = (event) => {
      if (!event || typeof event.key !== 'string' || !event.key) return;
      checkpointPending.push(
        checkpoint.recordStep({ root: a.root, runId: a.runId, key: event.key, artifacts: event.artifacts }).catch(() => null)
      );
    };
    const onStep = (event) => {
      trace.touchRun(a.root, a.runId, 'engine');
      collector.onEngineStep(event);
      recordCheckpoint(event);
      stepCount += 1;
      if (stepCount % 15 !== 0 && Date.now() - lastRecheck < 60000) return;
      lastRecheck = Date.now();
      const probe = probeRootWritable(a.root);
      if (probe.ok) return;
      runtimeAbort = 'ROOT_UNAVAILABLE: ' + probe.errno;
      collector.record({
        title: '运行中复检失败（可写性）',
        status: 'error',
        inputSummary: 'step#' + stepCount,
        error: runtimeAbort,
      });
    };

    collector.record({
      title: '降级：插件直接顺序执行（' + a.reason + '）',
      status: 'ok',
      inputSummary: a.error ? String(a.error && a.error.message ? a.error.message : a.error) : '没有可用的子代理编排通道',
    });

    try {
      if (a.kind === 'curate') {
        const input = a.input && typeof a.input === 'object' ? a.input : {};
        const skill = skillsById.get(String(input.skillId || ''));
        if (!skill) {
          collector.record({
            title: '入柜需要先判定技能',
            status: 'error',
            inputSummary: 'skillId=' + String(input.skillId || ''),
            error: '降级执行无法自行判定技能：请在 input 里给 skillId（或改用 agent 路径）',
          });
          await collector.flush();
          trace.finishRun(Object.assign({
            root: a.root, runId: a.runId, status: 'failed',
            summary: '入柜需要先判定技能（缺 skillId）', degraded: a.reason,
          }, usageFields(a)));
          return;
        }
        if (!input.confidence) {
          collector.record({ title: '入柜缺少置信度', status: 'error', error: 'input.confidence 必填（不得编造）' });
          await collector.flush();
          trace.finishRun(Object.assign({
            root: a.root, runId: a.runId, status: 'failed',
            summary: '入柜缺少 confidence', degraded: a.reason,
          }, usageFields(a)));
          return;
        }
        const lock = trace.readLock(a.root);
        let nextId = null;
        try {
          nextId = createRepos({ root: a.root }).numbersRepo.allocateInLock(lock, skill.idPrefix || 'SK', 1).ids[0];
        } catch (err) {
          collector.record({ title: '编号分配失败', status: 'error', error: String(err && err.message ? err.message : err) });
          await collector.flush();
          trace.finishRun(Object.assign({
            root: a.root, runId: a.runId, status: 'failed',
            summary: '编号分配失败：' + (err && err.message ? err.message : err), degraded: a.reason,
          }, usageFields(a)));
          return;
        }
        const result = await curateEngine({
          root: a.root,
          skillId: input.skillId,
          title: input.title || String(input.text || '').slice(0, 40),
          body: input.text,
          tags: Array.isArray(input.tags) && input.tags.length > 0 ? input.tags : ['入柜'],
          confidence: input.confidence,
          confWhy: input.confWhy || '',
          source: input.source || '',
          nextId: nextId,
          onStep: onStep,
        });
        try {
          createRepos({ root: a.root }).cardsRepo.create({
            id: result.id,
            kind: 'card',
            title: String(input.title || ''),
            path: result.path,
            sourceRunId: a.runId,
            skillId: input.skillId,
            tags: Array.isArray(input.tags) ? input.tags : [],
          });
        } catch (recordErr) {
          collector.record({ title: '卡片记录写入失败', status: 'error', error: String(recordErr && recordErr.message ? recordErr.message : recordErr) });
        }
        await collector.flush();
        await Promise.all(checkpointPending);
        await finishWithAcceptance(a, '降级执行完成：入柜 ' + result.id + ' → ' + result.path, a.reason);
        return;
      }

      if (a.kind === 'maintain') {
        const input = a.input && typeof a.input === 'object' ? a.input : {};
        const result = await maintainEngine({
          root: a.root,
          thresholds: input.thresholds && typeof input.thresholds === 'object' ? input.thresholds : null,
          onStep: onStep,
        });
        const period = new Date(result && result.generatedAt ? result.generatedAt : Date.now());
        const pad = (value) => String(value).padStart(2, '0');
        const dayKey = period.getFullYear() + '-' + pad(period.getMonth() + 1) + '-' + pad(period.getDate());
        const reportPath = path.join(a.root, '00_系统与索引', '整理报告-' + dayKey + '.md');
        // 与工具同源：复用 tools 的渲染/写入导出，避免第二份实现。
        writeReportFile(a.root, reportPath, renderMaintainMarkdown(result, dayKey));
        const byRule = (result && result.byRule) || {};
        const summary = summarizeByRule(byRule);
        try {
          saveMaintainReport(createRepos({ root: a.root }), buildReportRecord({
            kind: 'maintain', period: dayKey, summary: summary, path: reportPath,
            byRule: byRule, scanned: result && result.scanned ? result.scanned : null,
            findings: result && result.findings ? result.findings : [],
          }));
        } catch (recordErr) {
          collector.record({ title: '整理报告记录写入失败', status: 'error', error: String(recordErr && recordErr.message ? recordErr.message : recordErr) });
        }
        await collector.flush();
        await Promise.all(checkpointPending);
        await finishWithAcceptance(a, '降级执行完成：整理扫描 ' + summary, a.reason);
        return;
      }

      if (a.kind === 'archive') {
        const input = a.input && typeof a.input === 'object' ? a.input : {};
        const items = Array.isArray(input.items) ? input.items : [];
        if (input.confirmed !== true) {
          collector.record({ title: '归档未确认', status: 'error', error: 'input.confirmed !== true，未执行任何移动' });
          await collector.flush();
          trace.finishRun(Object.assign({
            root: a.root, runId: a.runId, status: 'failed',
            summary: '归档需要用户确认（input.confirmed=true）', degraded: a.reason,
          }, usageFields(a)));
          return;
        }
        if (items.length === 0) {
          collector.record({ title: '归档条目为空', status: 'error', error: 'input.items 为空' });
          await collector.flush();
          trace.finishRun(Object.assign({
            root: a.root, runId: a.runId, status: 'failed', summary: '归档条目为空', degraded: a.reason,
          }, usageFields(a)));
          return;
        }
        const outcome = await performArchive({ root: a.root, items: items, archiveEngine: (args2) => (engine && typeof engine.archiveItems === 'function' ? engine.archiveItems(args2) : Promise.reject(Object.assign(new Error('archiveItems 不可用'), { code: 'ENGINE_UNAVAILABLE' }))), onStep: onStep });
        collector.record({
          title: 'jk_kb_archive',
          status: outcome.failed.length > 0 ? 'error' : 'ok',
          outputSummary: 'moved=' + outcome.moved.length + ' failed=' + outcome.failed.length + ' skipped=' + outcome.skipped.length,
          artifacts: outcome.undoItems.map((item) => item.to),
        });
        await collector.flush();
        await Promise.all(checkpointPending);
        await finishWithAcceptance(a, '降级执行完成：归档 moved=' + outcome.moved.length + ' failed=' + outcome.failed.length, a.reason);
        return;
      }

      if (a.kind === 'skill') {
        collector.record({
          title: 'SKILL 创建需要用户确认',
          status: 'error',
          error: '降级执行没有用户交互通道，无法完成 NEED_CONFIRM 流程；请在 agent 路径下创建 SKILL',
        });
        await collector.flush();
        trace.finishRun(Object.assign({
          root: a.root, runId: a.runId, status: 'failed',
          summary: '创建 SKILL 需要编排官与用户确认（降级路径不执行）', degraded: a.reason,
        }, usageFields(a)));
        return;
      }

      if (a.kind === 'bootstrap') {
        const result = await engineApi.bootstrap({ root: a.root, mode: a.mode, force: a.force === true, onStep: onStep, shouldAbort: shouldAbort });
        await collector.flush();
        await Promise.all(checkpointPending);
        await finishWithAcceptance(a, '降级执行完成：新建 ' + (result && result.created ? result.created.length : 0) + ' 项，跳过 ' + (result && result.skipped ? result.skipped.length : 0) + ' 项', a.reason);
        return;
      }
      if (a.kind === 'verify') {
        const result = await engineApi.verify({ root: a.root, shouldAbort: shouldAbort });
        collector.record({
          title: 'verify',
          status: result && result.ok ? 'ok' : 'error',
          inputSummary: a.root,
          outputSummary: String(result && result.summary ? result.summary : ''),
        });
        await collector.flush();
        trace.finishRun(Object.assign({
          root: a.root,
          runId: a.runId,
          status: result && result.ok ? 'completed' : 'failed',
          summary: String(result && result.summary ? result.summary : ''),
          degraded: a.reason,
        }, usageFields(a)));
        return;
      }
      const result = await engineApi.reindex({ root: a.root, onStep: onStep, shouldAbort: shouldAbort });
      await collector.flush();
      await Promise.all(checkpointPending);
      await finishWithAcceptance(a, '降级执行完成：索引已重建' + (result && typeof result.noteCount === 'number' ? '（' + result.noteCount + ' 条笔记）' : ''), a.reason);
    } catch (err) {
      const aborted = err && err.code === 'ABORTED';
      const status = aborted ? abortStatus(a, err) : 'failed';
      const text = String(err && err.message ? err.message : err);
      collector.record({ title: '执行失败：' + a.kind, status: 'error', error: text });
      await collector.flush();
      trace.finishRun({
        root: a.root,
        runId: a.runId,
        status: status,
        summary: text,
        degraded: a.reason,
      });
    }
  }

  // ───────────────────────── S3 验收门 ─────────────────────────
  function acceptanceFromResult(result, checkedAt) {
    const errors = Array.isArray(result && result.errors)
      ? result.errors.filter((item) => item && typeof item === 'object').map((item) => ({
        id: typeof item.id === 'string' ? item.id : 'verify',
        level: 'error',
        message: typeof item.message === 'string' ? item.message : String(item),
        ...(typeof item.fix === 'string' ? { fix: item.fix } : {}),
      }))
      : [];
    const warnings = Array.isArray(result && result.warnings)
      ? result.warnings.filter((item) => item && typeof item === 'object').map((item) => ({
        id: typeof item.id === 'string' ? item.id : 'verify',
        level: 'warn',
        message: typeof item.message === 'string' ? item.message : String(item),
        ...(typeof item.fix === 'string' ? { fix: item.fix } : {}),
      }))
      : [];
    return {
      ok: result && result.ok === true,
      checkedAt: checkedAt,
      errors: errors,
      warnings: warnings,
      summary: String((result && result.summary) || ''),
    };
  }

  async function appendAcceptanceStep(a, acceptance, startedAt) {
    const firstThree = acceptance.errors.slice(0, 3).map((item) => item.message).filter(Boolean).join(' | ');
    await trace.appendStep({
      root: a.root,
      runId: a.runId,
      step: {
        role: 'PLUGIN',
        title: '验收（host 强制）',
        status: acceptance.ok ? 'ok' : 'error',
        startedAt: startedAt,
        endedAt: new Date().toISOString(),
        inputSummary: 'kind=' + a.kind,
        outputSummary: acceptance.ok ? acceptance.summary : firstThree,
        artifacts: [],
        error: acceptance.ok ? null : (firstThree || acceptance.summary || '验收未通过'),
      },
    });
  }

  async function runAcceptance(a) {
    const startedAt = new Date().toISOString();
    const checkedAt = new Date().toISOString();
    // 验收可能很慢：期间持续刷 engine 心跳，避免被 reap 判 stalled。
    const timer = setInterval(() => trace.touchRun(a.root, a.runId, 'engine'), 30000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    try {
      const result = await engineApi.verify({ root: a.root, shouldAbort: a.shouldAbort });
      const acceptance = acceptanceFromResult(result, checkedAt);
      await appendAcceptanceStep(a, acceptance, startedAt);
      return acceptance;
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      const acceptance = {
        ok: false,
        checkedAt: checkedAt,
        errors: [{ id: 'acceptance', level: 'error', message: message }],
        warnings: [],
        summary: message,
        abortCode: err && err.code === 'ABORTED' ? 'ABORTED' : null,
      };
      await appendAcceptanceStep(a, acceptance, startedAt);
      return acceptance;
    } finally {
      clearInterval(timer);
    }
  }

  function deadlinePassed(a) {
    try {
      const current = trace.readRun(a.root, a.runId);
      const deadline = current ? Date.parse(current.run.deadlineAt || '') : NaN;
      return Number.isFinite(deadline) && Date.now() > deadline;
    } catch (err) {
      return false;
    }
  }

  // 返回 { status, summary, acceptance, acceptanceFailed }
  async function gateCompletion(a, summary) {
    if (a.kind === 'verify') {
      return { status: 'completed', summary: summary, acceptance: null, acceptanceFailed: false };
    }
    if (deadlinePassed(a)) {
      // 死锁保护：预算已过就不再开始验收，直接按 timed_out 收尾。
      return { status: 'timed_out', summary: '超过运行预算，未开始验收', acceptance: null, acceptanceFailed: false };
    }
    const acceptance = await runAcceptance(a);
    if (!acceptance.ok && acceptance.abortCode === 'ABORTED' && deadlinePassed(a)) {
      return { status: 'timed_out', summary: acceptance.summary, acceptance: acceptance, acceptanceFailed: true };
    }
    return {
      status: acceptance.ok ? 'completed' : 'failed',
      summary: acceptance.ok ? summary : ('验收未通过：' + (acceptance.summary || (acceptance.errors[0] && acceptance.errors[0].message) || '')),
      acceptance: acceptance,
      acceptanceFailed: !acceptance.ok,
    };
  }

  /** completed 之前先验收，成功后只写一次终态（避免 completed→failed 双写）。 */
  async function finishWithAcceptance(a, summary, degraded) {
    const gate = await gateCompletion(a, summary);
    return trace.finishRun(Object.assign({
      root: a.root,
      runId: a.runId,
      status: gate.status,
      summary: truncate(gate.summary, 500),
      degraded: typeof degraded === 'string' ? degraded : undefined,
      acceptance: gate.acceptance,
      acceptanceFailed: gate.acceptanceFailed,
    }, usageFields(a)));
  }

  async function finishIfRunning(a, status, summary) {
    const current = trace.readRun(a.root, a.runId);
    if (!current || current.run.status !== 'running') return null;
    if (status === 'completed') return finishWithAcceptance(a, summary, a.reason);
    return trace.finishRun(Object.assign(
      { root: a.root, runId: a.runId, status: status, summary: truncate(summary, 500) },
      usageFields(a)
    ));
  }

  // 编排官可能已经用 jk_kb_run_finish 写了 completed：这里必须复核并可能改判 failed。
  // （唯一会出现 completed→failed 双写的路径，收尾后立刻改写 run.json 与 index.json。）
  async function enforceAcceptanceAfterCompletion(a) {
    try {
      if (!a || a.kind === 'verify') return;
      const current = trace.readRun(a.root, a.runId);
      if (!current) return;
      if (current.run.acceptance) return; // 已经验收过
      if (current.run.status !== 'completed') return;
      const gate = await gateCompletion(a, current.run.summary || '');
      if (gate.status === 'completed') {
        trace.updateRun(a.root, a.runId, { acceptance: gate.acceptance, acceptanceFailed: false });
        return;
      }
      trace.finishRun({
        root: a.root,
        runId: a.runId,
        status: gate.status,
        summary: truncate(gate.summary, 500),
        degraded: current.run.degraded,
        acceptance: gate.acceptance,
        acceptanceFailed: gate.acceptanceFailed,
      });
    } catch (err) { /* 验收异常不能影响收尾流程 */ }
  }

  // 真实结构：run.result → { output, stopReason, structured? }
  async function applyAgentOutcome(a, outcome) {
    const result = outcome && typeof outcome === 'object' ? outcome : {};
    const text = truncate(outputText(result.output), 500);
    const status = statusFromStopReason(result.stopReason);
    return finishIfRunning(a, status, text || ('stopReason=' + String(result.stopReason === undefined ? 'unknown' : result.stopReason)));
  }

  async function runViaStart(a, subagents, provider, request) {
    let run = null;
    let phase = 'start';
    try {
      run = await Promise.resolve(subagents.start(provider, request));
      phase = 'result';
      const outcome = run && run.result ? await run.result : null;
      const collected = collectAgentUsage(a, run);
      a.usage = collected.usage;
      a.usageSource = collected.usageSource;
      await applyAgentOutcome(a, outcome);
    } catch (err) {
      if (phase === 'start') {
        // start 阶段就失败（provider 拒绝 / 参数不合法）→ 降级。
        await executeSequential(Object.assign({}, a, { reason: 'no-agent', error: err }));
      } else {
        // 子代理已启动、result 阶段出错 → run 标 failed，不退化成插件执行。
        await finishIfRunning(a, 'failed', String(err && err.message ? err.message : err));
      }
    } finally {
      if (run && typeof run.dispose === 'function') {
        try { await run.dispose(); } catch (err) { /* 释放失败不影响 run 收尾 */ }
      }
      const record = active.get(a.runId);
      if (record && record.controller === a.signalOwner) active.delete(a.runId);
    }
  }

  // 兼容分支：老版本 / 其它宿主可能只有 startActivation。
  async function runViaActivation(a, subagents, request) {
    let activation = null;
    try {
      activation = subagents.startActivation(Object.assign({ provider: 'spawn', delivery: 'caller', signal: a.signal }, { label: ORCH_LABEL, request: request }));
    } catch (err) {
      await executeSequential(Object.assign({}, a, { reason: 'no-agent', error: err }));
      return;
    }
    try {
      const result = await awaitActivation(activation);
      const legacyCollected = collectAgentUsage(a, activation);
      a.usage = legacyCollected.usage;
      a.usageSource = legacyCollected.usageSource;
      await finishIfRunning(a, failedByResult(result) ? 'failed' : 'completed', summaryOfResult(result));
    } catch (err) {
      await finishIfRunning(a, 'failed', String(err && err.message ? err.message : err));
    } finally {
      // 只 dispose 一次：能 await 就 await，拿不到 dispose 再走兼容清理。
      if (activation && typeof activation.dispose === 'function') {
        try { await activation.dispose(); } catch (err) { /* 忽略 */ }
      } else {
        disposeActivation(activation);
      }
      const record = active.get(a.runId);
      if (record && record.controller === a.signalOwner) active.delete(a.runId);
    }
  }

  function collectAgentUsage(a, activation) {
    try {
      const agents = serviceOf(ctx, 'agents');
      const projections = serviceOf(ctx, 'sessionProjections');
      const sessionId = (activation && (activation.id || activation.sessionId)) || a.runId;
      const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : null;
      if (!agent || !agent.session || !projections || typeof projections.snapshot !== 'function') {
        return { usage: null, usageSource: 'unavailable' };
      }
      const snapshot = projections.snapshot(agent.session, ['tokenUsage']);
      const raw = snapshot && snapshot.values ? snapshot.values.tokenUsage : null;
      if (!raw || typeof raw !== 'object') return { usage: null, usageSource: 'unavailable' };
      const pick = (value) => (Number.isFinite(value) ? value : null);
      const usage = {
        inputTokens: pick(raw.uncachedInputTokens),
        outputTokens: pick(raw.outputTokens),
        cacheReadTokens: pick(raw.cacheReadTokens),
        cacheWriteTokens: pick(raw.cacheWriteTokens),
      };
      const hasValue = Object.keys(usage).some((key) => usage[key] !== null);
      // 读不到就是 null，绝不写 0。
      return hasValue ? { usage: usage, usageSource: 'agent' } : { usage: null, usageSource: 'unavailable' };
    } catch (err) {
      return { usage: null, usageSource: 'unavailable' };
    }
  }

  function usageFields(a) {
    return {
      usage: a && a.usage !== undefined ? a.usage : null,
      usageSource: a && typeof a.usageSource === 'string' ? a.usageSource : 'unavailable',
    };
  }

  /** 收尾后重写台账：run 起始月 + 当前月各一次（跨月不漏账）。失败只 warn。 */
  function refreshLedger(root, runId) {
    try {
      if (!root || !runId) return;
      const data = trace.readRun(root, runId);
      if (!data || data.run.status === 'running') return;
      const started = new Date(data.run.startedAt || Date.now());
      const now = new Date();
      const targets = [
        [started.getFullYear(), started.getMonth() + 1],
        [now.getFullYear(), now.getMonth() + 1],
      ];
      const seen = new Set();
      targets.forEach(([year, month]) => {
        const key = year + '-' + month;
        if (seen.has(key)) return;
        seen.add(key);
        try { ledger.writeMonthLedger({ root: root, year: year, month: month }); } catch (err) { /* warn 级别 */ }
      });
    } catch (err) { /* 台账失败不影响 run */ }
  }

  async function execute(args) {
    try {
      return await executeInner(args);
    } finally {
      // 兜底：无论走哪条分支（agent / 降级 / 抛错）都释放锁。
      trace.releaseLock({ root: args && args.root, runId: args && args.runId });
      const record = active.get(args && args.runId);
      if (record && record.controller === args.signalOwner) active.delete(args.runId);
      // 所有终态都重写台账（含编排官自己调 run_finish 的路径）。
      refreshLedger(args && args.root, args && args.runId);
    }
  }

  async function executeInner(args) {
    const a = args;
    // 默认按"纯引擎、无 LLM"记账；agent 路径成功后会被真实用量覆盖。
    if (a.usage === undefined) a.usage = null;
    if (a.usageSource === undefined) a.usageSource = 'degraded';
    const route = resolveRoute(ctx);
    const parent = pickParent(ctx);
    const subagents = serviceOf(ctx, 'subagents');
    const provider = resolveSubagentProvider(ctx);

    if (!route) {
      await executeSequential(Object.assign({}, a, { reason: 'no-route', error: new Error('没有可用的模型 route（provider/model 缺失）') }));
      return;
    }
    if (!subagents) {
      await executeSequential(Object.assign({}, a, { reason: 'no-agent', error: new Error('宿主没有 subagents 服务') }));
      return;
    }
    if (!provider) {
      await executeSequential(Object.assign({}, a, { reason: 'no-agent', error: new Error('subagents.list() 里没有可用 provider') }));
      return;
    }
    if (!parent) {
      await executeSequential(Object.assign({}, a, { reason: 'no-agent', error: new Error('没有活的 parent agent（agents.list()/roots() 都为空）') }));
      return;
    }

    const agentOptions = { provider: route.provider, model: route.model };
    if (route.reasoningEffort) agentOptions.reasoningEffort = route.reasoningEffort;

    const request = {
      label: ORCH_LABEL,
      prompt: [{ type: 'text', text: buildCharter({ root: a.root, runId: a.runId, kind: a.kind, input: a.input }) }],
      parent: parent,
      signal: a.signal,
      agentOptions: agentOptions,
      maxDepth: 1,
      toolFilter: { allow: ALLOWED_TOOLS.slice() },
    };

    if (typeof subagents.start === 'function') {
      await runViaStart(a, subagents, provider, request);
      await enforceAcceptanceAfterCompletion(a);
      return;
    }
    if (typeof subagents.startActivation === 'function') {
      await runViaActivation(a, subagents, request);
      await enforceAcceptanceAfterCompletion(a);
      return;
    }
    await executeSequential(Object.assign({}, a, { reason: 'no-agent', error: new Error('subagents 既没有 start() 也没有 startActivation()') }));
  }

  const service = {
    getActive(runId) {
      return active.get(runId) || null;
    },

    /** @returns {{ok:true, runId:string}|{ok:false, status?:number, error:{code,message}}} */
    async start(input) {
      const body = input || {};
      const kind = RUN_KINDS.indexOf(body.kind) >= 0 ? body.kind : null;
      if (!kind) return { ok: false, status: 400, error: { code: 'kind-invalid', message: 'kind 只能是 bootstrap / verify / reindex' } };
      const mode = body.mode === 'topic' ? 'topic' : 'asset';
      const root = resolveRoot();
      if (!root) return { ok: false, status: 409, error: { code: 'root-missing', message: '尚未配置知识库根目录' } };

      // 0) 开跑前预检：任何 error 直接 422，不建 run、不拿锁、不写任何文件。
      const pre = await runHostPreflight({ ctx: ctx, store: store, toolState: toolState }, { kind: kind, mode: mode });
      if (pre.status === 409) return { ok: false, status: 409, error: pre.error };
      if (!pre.ok) {
        return {
          ok: false,
          status: 422,
          error: { code: pre.report.code, message: preflightMessage(pre.report), checks: pre.report.checks },
        };
      }

      // 1) 先收割上一轮的遗留 running（超预算 / 心跳静默）。
      try { trace.reap(root); } catch (err) { /* 收割失败不阻塞新 run */ }

      // 2) 再抢锁：同一根目录同时只允许一个 run。
      const runId = trace.runIdFor(kind, new Date());
      let lock;
      try {
        lock = trace.acquireLock({ root: root, runId: runId });
      } catch (err) {
        return { ok: false, status: 500, error: { code: 'lock-failed', message: '取锁失败：' + (err && err.message ? err.message : err) } };
      }
      if (!lock.ok) {
        const age = Math.round((lock.ageMs || 0) / 1000);
        return {
          ok: false,
          status: 409,
          error: {
            code: 'lock-held',
            message: '锁被占用：runId=' + (lock.lock && lock.lock.runId ? lock.lock.runId : 'unknown') + '，心跳 ' + age + 's 前',
          },
        };
      }
      // 抢占到过期锁：把旧 run 标 stalled。
      if (lock.previous && trace.isSafeRunId(lock.previous.runId)) {
        const stale = trace.readRun(root, lock.previous.runId);
        if (stale && stale.run.status === 'running') {
          trace.finishRun({ root: root, runId: lock.previous.runId, status: 'stalled', summary: '锁心跳过期，被新 run 抢占' });
        }
      }

      const running = trace.findRunning(root);
      if (running) {
        trace.releaseLock({ root: root, runId: runId });
        return { ok: false, status: 409, error: { code: 'run-conflict', message: '同一根目录同时只允许一个 run，运行中：' + running.id } };
      }

      let run;
      try {
        const expertContext = resolveExpertContext(root, body.input);
        run = trace.createRun({
          id: runId,
          root: root,
          kind: kind,
          mode: mode,
          title: RUN_TITLES[kind] || kind,
          // 工具注册失败 → 编排官无工具可用；写进 run.json，GET /runs/:id 能看到。
          warnings: (toolWarnings ? toolWarnings() : []).concat(expertContext.warning ? [expertContext.warning] : []),
          deadlineAt: new Date(Date.now() + trace.budgetFor(kind)).toISOString(),
          engineVersion: typeof ENGINE_VERSION === 'string' ? ENGINE_VERSION : null,
          schemaVersion: checkpoint.CHECKPOINT_SCHEMA_VERSION,
          resumedFrom: typeof body.resumedFrom === 'string' && body.resumedFrom ? body.resumedFrom : null,
        });
      } catch (err) {
        trace.releaseLock({ root: root, runId: runId });
        return { ok: false, status: 500, error: { code: 'trace-write-failed', message: '运行记录创建失败：' + (err && err.message ? err.message : err) } };
      }

      const controller = new AbortController();
      active.set(run.id, { root: root, controller: controller });
      const args = {
        root: root,
        runId: run.id,
        kind: kind,
        mode: mode,
        input: body.input && typeof body.input === 'object' ? body.input : null,
        force: body.force === true,
        signal: controller.signal,
        signalOwner: controller,
        shouldAbort: makeShouldAbort({ root: root, runId: run.id, signal: controller.signal }),
      };
      execute(args).catch((err) => {
        const current = trace.readRun(root, run.id);
        if (current && current.run.status === 'running') {
          trace.finishRun({ root: root, runId: run.id, status: 'failed', summary: '编排器内部错误：' + (err && err.message ? err.message : String(err)) });
        }
      }).finally(() => {
        trace.releaseLock({ root: root, runId: run.id });
        active.delete(run.id);
      });
      return { ok: true, runId: run.id };
    },

    /** 尽力而为的取消。 */
    async cancel(runId) {
      const id = String(runId || '');
      if (!trace.isSafeRunId(id)) return { ok: false, status: 404, error: { code: 'run-not-found', message: 'run 不存在' } };
      const root = resolveRoot();
      if (!root) return { ok: false, status: 404, error: { code: 'run-not-found', message: '尚未配置知识库根目录' } };
      const current = trace.readRun(root, id);
      if (!current) return { ok: false, status: 404, error: { code: 'run-not-found', message: 'run 不存在：' + id } };

      // 跨进程可取消：先把意图写进 run.json，再由 shouldAbort / 引擎边界感知。
      if (current.run.status === 'running') {
        trace.updateRun(root, id, { cancelRequestedAt: new Date().toISOString() });
      }
      const record = active.get(id);
      if (record && record.controller) {
        try { record.controller.abort(); } catch (err) { /* abort 失败也继续收尾 */ }
      }
      // 本进程内没有执行器（例如插件重启过）时，直接落终态并释放锁。
      if (current.run.status === 'running' && !record) {
        trace.finishRun({ root: root, runId: id, status: 'cancelled', summary: '已请求取消' });
        trace.releaseLock({ root: root, runId: id });
      }
      active.delete(id);
      return { ok: true };
    },

    /**
     * 断点恢复：action 必须与 decideRecovery 的结论一致。
     * restart 必须先备份（备份失败 → 422 且不启动）；resume 不备份。
     */
    async recover(runId, action) {
      const id = String(runId || '');
      if (!trace.isSafeRunId(id)) return { ok: false, status: 404, error: { code: 'run-not-found', message: 'run 不存在' } };
      const root = resolveRoot();
      if (!root) return { ok: false, status: 404, error: { code: 'run-not-found', message: '尚未配置知识库根目录' } };
      const current = trace.readRun(root, id);
      if (!current) return { ok: false, status: 404, error: { code: 'run-not-found', message: 'run 不存在：' + id } };

      // 放弃：任何「非 running」的 run 都允许；不改动任何文件，只落终态 + 释放锁。
      if (action === 'abandon') {
        if (current.run.status === 'running') {
          return {
            ok: false,
            status: 409,
            error: { code: 'run-running', message: 'run 仍在运行，请先取消再放弃', suggested: 'cancel' },
          };
        }
        trace.finishRun({ root: root, runId: id, status: 'abandoned', summary: '用户放弃（未删除任何文件）' });
        trace.releaseLock({ root: root, runId: id });
        return { ok: true, status: 'abandoned', runId: id };
      }

      const cp = checkpoint.readCheckpoint(root, id);
      const decision = checkpoint.decideRecovery({
        run: current.run,
        checkpoint: cp,
        engineVersion: ENGINE_VERSION,
      });

      if (action !== decision.action) {
        return {
          ok: false,
          status: 409,
          error: {
            code: 'recovery-mismatch',
            message: '请求的动作是 ' + action + '，但建议动作是 ' + decision.action + '：' + decision.reason,
            suggested: decision.action,
            decision: decision,
          },
        };
      }
      if (decision.action !== 'resume' && decision.action !== 'restart') {
        return {
          ok: false,
          status: 409,
          error: {
            code: 'recovery-not-allowed',
            message: '当前不可恢复（' + decision.action + '）：' + decision.reason,
            suggested: decision.action,
            decision: decision,
          },
        };
      }

      if (decision.action === 'restart') {
        const files = [];
        (cp ? cp.completedSteps : []).forEach((step) => step.artifacts.forEach((artifact) => files.push(artifact.path)));
        const backupResult = backup.backupArtifacts({ root: root, runId: id, files: files });
        if (!backupResult.ok) {
          const first = backupResult.failed[0] || {};
          return {
            ok: false,
            status: 422,
            error: {
              code: 'backup-failed',
              message: '备份失败，未启动新 run：' + (first.reason || '未知原因'),
              backup: backupResult,
            },
          };
        }
      }

      return service.start({
        kind: current.run.kind,
        // 沿用 run.json 里持久化的模式，绝不硬编码 asset（topic 库恢复会 MODE_CONFLICT）。
        mode: current.run.mode === 'topic' ? 'topic' : 'asset',
        force: false,
        resumedFrom: id,
      });
    },
  };
  return service;
}
