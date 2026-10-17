/**
 * jk_kb_* 工具（host 半）。
 *
 * 契约要点：
 * - 工具是**全局可见**的，所以每个"动作类"工具都必须带 runId，并校验：
 *   runId 存在、对应 run 仍在 running，否则返回结构化错误（不抛异常）。
 * - 每个动作类工具执行时**自动**追加一条 step（角色/输入摘要/产物/耗时），不依赖 agent 自觉。
 * - 引擎调用一律走 host/engine/index.js。
 *
 * 注册形态是普通对象（不 import @deepseek-ai/dsh-tools），由宿主 tools.register 直接消费。
 */
import * as engine from './engine/index.js';
import * as curateModule from './engine/curate.js';
import * as maintainModule from './engine/maintain.js';
import * as archiveModule from './engine/archive.js';
import { assertWritableSync } from './engine/guard.js';
import { replaceFile } from './trace.js';
import fs from 'node:fs';
import path from 'node:path';
import { byId as skillsById } from './skills/catalog.js';
import { createRepos } from './store/index.js';
import { writeStoreJson } from './store/adapter-file.js';
import { decideCreate, normalizeForCompare, similarity } from './skills/lifecycle.js';
import * as trace from './trace.js';

// 引擎门面若已导出 curate 就用它，否则直接用 curate 模块（同一实现）。
const curateEngine = engine && typeof engine.curate === 'function' ? engine.curate : curateModule.curate;
const maintainEngine = engine && typeof engine.maintain === 'function' ? engine.maintain : maintainModule.maintain;

let doctorEnginePromise = null;
/** doctor 引擎按需加载：优先 host/engine/index.js 的转出，其次 host/doctor 目录。 */
export async function loadDoctorEngine() {
  if (!doctorEnginePromise) {
    doctorEnginePromise = (async () => {
      if (engine && typeof engine.diagnose === 'function' && typeof engine.repair === 'function') {
        return { diagnose: engine.diagnose, repair: engine.repair };
      }
      try {
        const mod = await import('./doctor/index.js');
        if (mod && typeof mod.diagnose === 'function' && typeof mod.repair === 'function') {
          return { diagnose: mod.diagnose, repair: mod.repair };
        }
      } catch (err) { /* 引擎未就绪 */ }
      return null;
    })();
  }
  return doctorEnginePromise;
}

function doctorStamp(date) {
  const d = date instanceof Date ? date : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

export function doctorDir(root) {
  return path.join(String(root), '.jkkb', 'doctor');
}

export function doctorReportPath(root, stamp) {
  return path.join(doctorDir(root), String(stamp) + '.md');
}

export const DOCTOR_LAST_FILE = 'last.json';

export function readDoctorLast(root) {
  try {
    const file = path.join(doctorDir(root), DOCTOR_LAST_FILE);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}

export function renderDoctorReport(args) {
  const a = args || {};
  const diagnosis = a.diagnosis || {};
  const repair = a.repair || null;
  const checks = Array.isArray(diagnosis.checks) ? diagnosis.checks : [];
  const lines = [
    '# doctor 报告 ' + (a.stamp || ''),
    '',
    '> 由 JK知识库 doctor 自动生成；**不删除任何文件**，损坏产物一律移入 .jkkb 的 quarantine 目录。',
    '',
    '- 生成时间：' + (diagnosis.generatedAt || ''),
    '- 根目录：' + (diagnosis.root || a.root || ''),
    '- 检查项：' + (checks.length) + ' 条（ok ' + ((diagnosis.summary || {}).ok || 0)
      + ' / warn ' + ((diagnosis.summary || {}).warn || 0)
      + ' / error ' + ((diagnosis.summary || {}).error || 0)
      + ' / blocked ' + ((diagnosis.summary || {}).blocked || 0) + '）',
    '- 耗时：' + (a.elapsedMs == null ? '-' : a.elapsedMs + ' ms'),
    '',
    '## 检查项',
    '',
  ];
  checks.forEach((check) => {
    lines.push('- [' + check.level + '] ' + check.id + ' ' + (check.title || '') + '：' + (check.detail || ''));
  });
  lines.push('');
  lines.push('## 修复项');
  lines.push('');
  if (!repair) {
    lines.push('- （本次只诊断，未执行修复）');
  } else {
    (repair.applied || []).forEach((item) => {
      lines.push('- ' + item.repairId + ' → ' + item.status + '：' + (item.detail || ''));
      (item.movedTo || []).forEach((target) => lines.push('  - movedTo: ' + target));
    });
    if ((repair.applied || []).length === 0) lines.push('- （没有可应用的修复）');
  }
  lines.push('');
  lines.push('## movedTo 清单');
  lines.push('');
  const moved = [];
  (repair && repair.applied ? repair.applied : []).forEach((item) => {
    (item.movedTo || []).forEach((target) => moved.push(target));
  });
  if (moved.length === 0) lines.push('- （无）');
  else moved.forEach((target) => lines.push('- ' + target));
  lines.push('');
  return lines.join('\n');
}

/** 写一条审计 run + 人读报告 + last.json；任一失败返回 error，不影响修复结果。 */
export async function writeDoctorAudit(args) {
  const a = args || {};
  const root = a.root;
  const stamp = a.stamp || doctorStamp(new Date());
  const out = { runId: null, reportPath: null, lastPath: null, error: null };
  try {
    const run = trace.createRun({ root: root, kind: 'doctor', title: 'doctor 修复' });
    out.runId = run.id;
    trace.finishRun({
      root: root,
      runId: run.id,
      status: 'completed',
      summary: 'doctor：applied=' + ((a.repair && a.repair.summary ? a.repair.summary.applied : 0) || 0),
    });
  } catch (err) {
    out.error = 'run: ' + String(err && err.message ? err.message : err);
  }
  try {
    const reportPath = doctorReportPath(root, stamp);
    writeReportFile(root, reportPath, renderDoctorReport({ root: root, stamp: stamp, diagnosis: a.diagnosis, repair: a.repair, elapsedMs: a.elapsedMs }));
    out.reportPath = reportPath;
  } catch (err) {
    out.error = (out.error ? out.error + '；' : '') + 'report: ' + String(err && err.message ? err.message : err);
  }
  try {
    const lastPath = path.join(doctorDir(root), DOCTOR_LAST_FILE);
    writeStoreJson(root, lastPath, {
      // 宿主是 last.json 的唯一写者：只有真实修复后的审计路径会写它。
      kind: 'repair',
      at: a.diagnosis && a.diagnosis.generatedAt ? a.diagnosis.generatedAt : new Date().toISOString(),
      stamp: stamp,
      runId: out.runId,
      reportPath: out.reportPath,
      summary: a.repair && a.repair.summary ? a.repair.summary : { planned: 0, applied: 0, skipped: 0, failed: 0 },
      issues: a.diagnosis && a.diagnosis.summary
        ? { error: a.diagnosis.summary.error || 0, warn: a.diagnosis.summary.warn || 0, blocked: a.diagnosis.summary.blocked || 0 }
        : { error: 0, warn: 0, blocked: 0 },
      repairIds: Array.isArray(a.repairIds) ? a.repairIds : [],
    }, undefined);
    out.lastPath = lastPath;
  } catch (err) {
    out.error = (out.error ? out.error + '；' : '') + 'last: ' + String(err && err.message ? err.message : err);
  }
  return out;
}
const archiveEngine = engine && typeof engine.archiveItems === 'function' ? engine.archiveItems : archiveModule.archiveItems;

export const REPORT_FINDINGS_LIMIT = 200;
export const REPORT_FINDINGS_HARD_LIMIT = 5000;

/**
 * 生成 reportsRepo 的记录载荷：findings 最多 200 条入库（列表展开够用），
 * 超出时记 findingsTotal 与 truncated:true；完整明细留在 md 与引擎返回值里。
 */
export function buildReportRecord(args) {
  const a = args || {};
  const findings = Array.isArray(a.findings) ? a.findings : [];
  return {
    kind: typeof a.kind === 'string' ? a.kind : 'maintain',
    period: a.period,
    summary: a.summary,
    path: a.path,
    byRule: a.byRule || {},
    scanned: a.scanned || null,
    // 记录里存到 5000 条硬上限（详情页要能看全）；列表接口再按 200 截断。
    findings: findings.slice(0, REPORT_FINDINGS_HARD_LIMIT),
    findingsTotal: findings.length,
    truncated: findings.length > REPORT_FINDINGS_HARD_LIMIT,
  };
}

/** 同一天同一类报告只保留一条记录（更新而不是新建），避免列表里堆重复项。 */
export function saveMaintainReport(repos, payload) {
  const existing = repos.reportsRepo.list().filter((item) => (
    item.kind === 'maintain' && item.period === payload.period
  ))[0];
  if (existing) return repos.reportsRepo.update(existing.id, Object.assign({}, payload, { id: existing.id, createdAt: existing.createdAt }));
  return repos.reportsRepo.create(payload);
}

/** 单条 warning 归一成可读文本：绝不出现 [object Object]。 */
export function formatWarning(warning) {
  if (typeof warning === 'string') return warning;
  if (warning === null || warning === undefined) return '';
  if (typeof warning !== 'object') return String(warning);
  const message = typeof warning.message === 'string' && warning.message ? warning.message : JSON.stringify(warning);
  return typeof warning.code === 'string' && warning.code ? '[' + warning.code + '] ' + message : message;
}

/** 按 code 归类汇总成一句人话（缺节 / 同标题 / 其它）。 */
export function summarizeWarnings(warnings) {
  const list = Array.isArray(warnings) ? warnings : [];
  if (list.length === 0) return '';
  const sections = [];
  const duplicates = [];
  const others = [];
  list.forEach((warning) => {
    if (typeof warning === 'string') { others.push(warning); return; }
    if (!warning || typeof warning !== 'object') { others.push(String(warning)); return; }
    if (warning.code === 'SECTION_MISSING') sections.push(String(warning.section || '未知节'));
    else if (warning.code === 'DUPLICATE_TITLE') duplicates.push(String(warning.path || ''));
    else others.push(formatWarning(warning));
  });
  const parts = [];
  if (sections.length > 0) parts.push('缺节 ' + sections.length + ' 处：' + sections.join(' / '));
  if (duplicates.length > 0) parts.push('同标题卡片已存在：' + duplicates[0]);
  if (others.length > 0) parts.push(others.slice(0, 3).join('；'));
  return parts.join('；');
}

const MAINTAIN_RULE_NAMES = {
  M01: '收件箱超期未归位',
  M03: '低置信度长期未验证',
  M04: '溯源链断链',
  M06: '项目已结束未归档',
  M07: '已废弃内容可归档',
  M08: '缺置信度标记',
};

const MAINTAIN_RULE_ORDER = ['M01', 'M03', 'M04', 'M06', 'M07', 'M08'];
// M06/M07 是「只读提议」：报告只给建议，不执行归档。
const PROPOSAL_RULES = ['M06', 'M07'];

/** 四（六）类命中数汇总成一句。 */
export function summarizeByRule(byRule) {
  const source = byRule || {};
  const keys = MAINTAIN_RULE_ORDER.filter((id) => Object.prototype.hasOwnProperty.call(source, id));
  const list = keys.length > 0 ? keys : ['M01', 'M03', 'M04', 'M08'];
  return list.map((id) => id + '=' + (source[id] || 0)).join(' ');
}

function localDateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 人可读整理报告（纯文本；只读扫描结果，不含任何执行动作）。 */
export function renderMaintainMarkdown(report, period) {
  const r = report || {};
  const byRule = r.byRule || {};
  const findings = Array.isArray(r.findings) ? r.findings : [];
  const lines = [
    '# 整理报告 ' + period,
    '',
    '> 由 JK知识库 插件自动生成；本报告只做只读扫描，未移动、未删除任何文件。',
    '',
    '- 扫描：' + (r.scanned && r.scanned.files != null ? r.scanned.files : 0) + ' 个文件 / '
      + (r.scanned && r.scanned.notes != null ? r.scanned.notes : 0) + ' 篇笔记',
    '- 命中：' + summarizeByRule(byRule)
      + '（共 ' + findings.length + ' 条）',
    '',
  ];
  MAINTAIN_RULE_ORDER.forEach((ruleId) => {
    const items = findings.filter((item) => item.ruleId === ruleId);
    const isProposal = PROPOSAL_RULES.indexOf(ruleId) >= 0;
    lines.push('## ' + ruleId + ' ' + (MAINTAIN_RULE_NAMES[ruleId] || ruleId) + '（' + items.length + ' 条）');
    lines.push('');
    if (isProposal && items.length > 0) {
      lines.push('> 本报告只提议，未执行归档。');
      lines.push('');
    }
    if (items.length === 0) {
      lines.push('- （无）');
    } else {
      items.slice(0, 100).forEach((item) => {
        if (isProposal) {
          lines.push('- ' + (item.relPath || item.path || '') + ' ｜ ' + (item.title || '未命名')
            + ' ｜ 建议归档到 ' + (item.proposedTarget || '（未提供目标）')
            + ' ｜ 原因：' + (item.archiveReason || item.detail || '-'));
        } else {
          lines.push('- ' + (item.relPath || item.path || '') + ' ｜ ' + (item.title || '未命名')
            + ' ｜ 依据：' + (item.basis || '-') + ' ｜ 阈值：' + (item.threshold == null ? '-' : item.threshold)
            + (item.detail ? ' ｜ ' + item.detail : ''));
        }
      });
      if (items.length > 100) lines.push('- 另有 ' + (items.length - 100) + ' 条未展示');
    }
    lines.push('');
  });
  if (Array.isArray(r.warnings) && r.warnings.length > 0) {
    lines.push('## 扫描告警');
    lines.push('');
    r.warnings.forEach((warn) => lines.push('- ' + formatWarning(warn)));
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

/** 守卫 + 原子替换写文本（不复制 replaceFile 逻辑）。 */
export function writeReportFile(root, file, text) {
  return writeTextGuarded(root, file, text);
}

function writeTextGuarded(root, file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.tmp');
  assertWritableSync(root, file);
  const fsMod = fs;
  fsMod.mkdirSync(dir, { recursive: true });
  fsMod.writeFileSync(tmp, text, 'utf8');
  const replaced = replaceFile(tmp, file);
  if (!replaced.ok) {
    try { fsMod.unlinkSync(tmp); } catch (err) { /* 忽略 */ }
    const err = new Error('报告写入失败：' + (replaced.message || replaced.code));
    err.code = replaced.code || 'REPORT_WRITE_FAILED';
    throw err;
  }
}


export const TOOL_NAMES = [
  'jk_kb_bootstrap',
  'jk_kb_verify',
  'jk_kb_reindex',
  'jk_kb_inspect',
  'jk_kb_step',
  'jk_kb_run_finish',
  'jk_kb_curate',
  'jk_kb_maintain',
  'jk_kb_skill_create',
  'jk_kb_skill_find',
  'jk_kb_skill_run',
  'jk_kb_skill_list',
  'jk_kb_archive',
  'jk_kb_expert_create',
  'jk_kb_expert_update',
  'jk_kb_expert_list',
  'jk_kb_expert_archive',
  'jk_kb_expert_restore',
  'jk_kb_doctor',
];

const OUTPUT_ALLOWED = /^(0[3-9]|1[0-2])_/;

function bumpPatch(version) {
  const parts = String(version || '1.0.0').split('.').map((n) => Number(n) || 0);
  return (parts[0] || 1) + '.' + (parts[1] || 0) + '.' + ((parts[2] || 0) + 1);
}

function compareVersion(a, b) {
  const x = String(a || '0').split('.').map((n) => Number(n) || 0);
  const y = String(b || '0').split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const left = x[i] || 0;
    const right = y[i] || 0;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

/** outputs 白名单：03..12 顶层目录，且必须在 root 内。 */
export function validateSkillOutputs(root, outputs) {
  const list = Array.isArray(outputs) ? outputs : [];
  const bad = [];
  list.forEach((item) => {
    if (typeof item !== 'string' || !item.trim()) { bad.push(String(item)); return; }
    const rel = path.relative(path.resolve(root), path.resolve(item));
    if (!rel || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) { bad.push(item); return; }
    const top = rel.split(path.sep)[0];
    if (!OUTPUT_ALLOWED.test(top)) bad.push(item);
  });
  return { ok: bad.length === 0, bad: bad };
}

export const EXPERT_LIMITS = Object.freeze({ name: 60, domain: 40, responsibility: 10, promptFragment: 2000 });

/** 专家字段校验（create 与 update 共用）。返回 null 表示通过。 */
export function validateExpertFields(fields, root) {
  const f = fields || {};
  const name = String(f.name === null || f.name === undefined ? '' : f.name).trim();
  if (!name) return { code: 'name-required', message: 'name 必填' };
  if (Array.from(name).length > EXPERT_LIMITS.name) return { code: 'name-too-long', message: 'name 不能超过 ' + EXPERT_LIMITS.name + ' 字符' };
  const domain = String(f.domain === null || f.domain === undefined ? '' : f.domain).trim();
  if (!domain) return { code: 'domain-required', message: 'domain 必填' };
  if (Array.from(domain).length > EXPERT_LIMITS.domain) return { code: 'domain-too-long', message: 'domain 不能超过 ' + EXPERT_LIMITS.domain + ' 字符' };
  const responsibility = String(f.responsibility === null || f.responsibility === undefined ? '' : f.responsibility).trim();
  if (Array.from(responsibility).length < EXPERT_LIMITS.responsibility) {
    return { code: 'responsibility-too-short', message: 'responsibility 至少 ' + EXPERT_LIMITS.responsibility + ' 个字符' };
  }
  const promptFragment = f.promptFragment === null || f.promptFragment === undefined ? '' : String(f.promptFragment);
  if (Array.from(promptFragment).length > EXPERT_LIMITS.promptFragment) {
    return { code: 'prompt-too-long', message: 'promptFragment 不能超过 ' + EXPERT_LIMITS.promptFragment + ' 字符' };
  }
  const skillIds = Array.isArray(f.skillIds) ? f.skillIds : [];
  const repos = root ? createRepos({ root: root }) : null;
  const SAFE_SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  const unknown = skillIds.filter((id) => {
    const key = String(id || '').trim();
    if (!key) return true;
    if (skillsById.has(key)) return false;
    // 注册表里的 SK 记录：只对合法 id 形态去查（避免 INVALID_ID 抛错）
    if (!SAFE_SKILL_ID.test(key)) return true;
    try {
      if (repos && repos.skillsRepo.get(key)) return false;
    } catch (err) { /* 查不到就当未知 */ }
    return true;
  });
  if (unknown.length > 0) {
    return { code: 'unknown-skill', message: '未知技能 id：' + unknown.join('、'), skillIds: unknown };
  }
  return null;
}

/** 在卡片 frontmatter 里补一行（没有 frontmatter 时创建最小 frontmatter）。 */
export function insertFrontmatterField(text, key, value) {
  const src = String(text === null || text === undefined ? '' : text);
  const line = key + ': "' + String(value).replace(/"/g, '\\"') + '"';
  if (src.indexOf('---') === 0) {
    const end = src.indexOf('\n---', 3);
    if (end >= 0) return src.slice(0, end + 1) + line + '\n' + src.slice(end + 1);
  }
  return '---\n' + line + '\n---\n\n' + src;
}

/** 对外的专家视图（与 GET /experts 列表项结构完全一致）。 */
export function expertView(record) {
  const r = record || {};
  return {
    id: r.id,
    name: r.name,
    domain: r.domain,
    responsibility: r.responsibility,
    skillIds: Array.isArray(r.skillIds) ? r.skillIds : [],
    promptFragment: typeof r.promptFragment === 'string' ? r.promptFragment : '',
    status: r.status || 'active',
    schemaVersion: r.schemaVersion,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function expertError(invalid) {
  return { ok: false, code: invalid.code, message: invalid.message, status: 400 };
}

/** 创建业务专家（工具与 HTTP 共用；lock 可选，给了就用它分配编号）。 */
export function createExpert(args) {
  const a = args || {};
  const invalid = validateExpertFields({
    name: a.name, domain: a.domain, responsibility: a.responsibility,
    promptFragment: a.promptFragment, skillIds: a.skillIds,
  }, a.root);
  if (invalid) return expertError(invalid);

  const repos = createRepos({ root: a.root });
  const lock = a.lock && typeof a.lock.runId === 'string' ? a.lock : null;
  const raw = lock
    ? repos.numbersRepo.allocateInLock(lock, 'EXP', 1).ids[0]
    : repos.numbersRepo.allocate('EXP', 1).ids[0];
  const record = repos.expertsRepo.create({
    id: 'EXP-' + raw.slice('EXP'.length),
    name: String(a.name).trim(),
    domain: String(a.domain).trim(),
    responsibility: String(a.responsibility).trim(),
    skillIds: Array.isArray(a.skillIds) ? a.skillIds.map((item) => String(item).trim()).filter(Boolean) : [],
    promptFragment: typeof a.promptFragment === 'string' ? a.promptFragment : '',
    status: 'active',
  });
  return { ok: true, expert: expertView(record), record: record };
}

/** 局部更新（未传字段保留原值）；已归档的专家不允许再改（409 already-archived）。 */
export function updateExpert(args) {
  const a = args || {};
  const id = String(a.id || '').trim();
  if (!id) return { ok: false, code: 'id-required', message: 'id 必填', status: 400 };
  const repos = createRepos({ root: a.root });
  const existing = repos.expertsRepo.get(id);
  if (!existing) return { ok: false, code: 'expert-not-found', message: '业务专家不存在：' + id, status: 404 };
  if (String(existing.status || 'active') === 'archived') {
    return { ok: false, code: 'already-archived', message: '该专家已归档，不能再修改：' + id, status: 409 };
  }
  const patch = a.patch && typeof a.patch === 'object' ? a.patch : {};
  const merged = {
    name: patch.name !== undefined ? patch.name : existing.name,
    domain: patch.domain !== undefined ? patch.domain : existing.domain,
    responsibility: patch.responsibility !== undefined ? patch.responsibility : existing.responsibility,
    promptFragment: patch.promptFragment !== undefined ? patch.promptFragment : existing.promptFragment,
    skillIds: patch.skillIds !== undefined ? patch.skillIds : existing.skillIds,
  };
  const invalid = validateExpertFields(merged, a.root);
  if (invalid) return expertError(invalid);
  const updated = repos.expertsRepo.update(id, {
    name: String(merged.name).trim(),
    domain: String(merged.domain).trim(),
    responsibility: String(merged.responsibility).trim(),
    skillIds: Array.isArray(merged.skillIds) ? merged.skillIds.map((item) => String(item)) : [],
    promptFragment: typeof merged.promptFragment === 'string' ? merged.promptFragment : '',
    status: 'active',
  });
  return { ok: true, expert: expertView(updated), record: updated };
}

/** 专家产出统计：cardCount / lastUsedAt / skillStates / danglingSkillIds。 */
export function expertStats(root, expert, repos) {
  const repo = repos || createRepos({ root: root });
  const id = String((expert && expert.id) || '');
  let cards = [];
  try {
    cards = repo.cardsRepo.list().filter((card) => String(card.expertId || '') === id && String(card.status || '') !== 'archived');
  } catch (err) { cards = []; }
  let lastUsedAt = null;
  cards.forEach((card) => {
    const at = typeof card.createdAt === 'string' ? card.createdAt : null;
    if (at && (!lastUsedAt || at > lastUsedAt)) lastUsedAt = at;
  });
  const bound = Array.isArray(expert && expert.skillIds) ? expert.skillIds : [];
  const skillStates = bound.map((skillId) => {
    const key = String(skillId || '');
    const builtin = skillsById.get(key);
    if (builtin) return { id: key, name: builtin.name, ok: true };
    let record = null;
    try { record = repo.skillsRepo.get(key); } catch (err) { record = null; }
    if (record) return { id: key, name: record.name, ok: true };
    return { id: key, name: '', ok: false, reason: '技能不存在（内置目录与注册表都没有）' };
  });
  return {
    cardCount: cards.length,
    lastUsedAt: lastUsedAt,
    skillStates: skillStates,
    danglingSkillIds: skillStates.filter((item) => item.ok !== true).map((item) => item.id),
  };
}

/** 恢复归档：status archived→active；已是 active 幂等返回 alreadyActive:true。 */
export function restoreExpert(args) {
  const a = args || {};
  const id = String(a.id || '').trim();
  if (!id) return { ok: false, code: 'ID_REQUIRED', message: 'id 必填', status: 400 };
  const repos = createRepos({ root: a.root });
  const existing = repos.expertsRepo.get(id);
  if (!existing) return { ok: false, code: 'EXPERT_NOT_FOUND', message: '业务专家不存在：' + id, status: 404 };
  if (String(existing.status || 'active') === 'active') {
    return { ok: true, expert: expertView(existing), alreadyActive: true };
  }
  const updated = repos.expertsRepo.update(id, Object.assign({}, existing, { status: 'active' }));
  return { ok: true, expert: expertView(updated), alreadyActive: false };
}

/** 归档 = status='archived'（记录保留）；重复归档返回 409 already-archived。 */
export function archiveExpert(args) {
  const a = args || {};
  const id = String(a.id || '').trim();
  if (!id) return { ok: false, code: 'id-required', message: 'id 必填', status: 400 };
  const repos = createRepos({ root: a.root });
  const existing = repos.expertsRepo.get(id);
  if (!existing) return { ok: false, code: 'expert-not-found', message: '业务专家不存在：' + id, status: 404 };
  if (String(existing.status || 'active') === 'archived') {
    return { ok: false, code: 'already-archived', message: '该专家已归档：' + id, status: 409 };
  }
  const updated = repos.expertsRepo.update(id, Object.assign({}, existing, { status: 'archived' }));
  return { ok: true, expert: expertView(updated), record: updated };
}

export const SKILL_CALL_TASK_MAX = 200;
export const SKILL_CALL_REASON_MIN = 4;

/**
 * 记录一次 SKILL 调用回执（工具与 HTTP 路由共用的唯一实现）。
 * 返回 { ok:true, id, call } 或 { ok:false, code, message, outputs? }；
 * code 用小写短横线形式，调用方各自映射成自己的错误码/HTTP 状态。
 */
export function recordSkillCall(args) {
  const a = args || {};
  const root = a.root;
  const repos = a.repos || createRepos({ root: root });
  const skillId = String(a.skillId === null || a.skillId === undefined ? '' : a.skillId);
  const task = String(a.task === null || a.task === undefined ? '' : a.task).trim();
  const result = a.result === 'ok' || a.result === 'fail' ? a.result : null;
  const reason = typeof a.reason === 'string' ? a.reason.trim() : '';
  const outputs = Array.isArray(a.outputs) ? a.outputs : [];

  if (!result) return { ok: false, code: 'result-invalid', message: 'result 只能是 ok / fail' };
  if (!task) return { ok: false, code: 'task-required', message: 'task 必填' };
  if (Array.from(task).length > SKILL_CALL_TASK_MAX) {
    return { ok: false, code: 'task-too-long', message: 'task 不能超过 ' + SKILL_CALL_TASK_MAX + ' 字符' };
  }
  if (result === 'fail' && Array.from(reason).length < SKILL_CALL_REASON_MIN) {
    return { ok: false, code: 'reason-required', message: 'result=fail 时必须写 reason（至少 ' + SKILL_CALL_REASON_MIN + ' 个字符）' };
  }
  const checked = validateSkillOutputs(root, outputs);
  if (!checked.ok) {
    return { ok: false, code: 'output-forbidden', outputs: checked.bad, message: 'outputs 只允许 03..12 顶层目录且必须在知识库根目录内' };
  }
  const skill = repos.skillsRepo.get(skillId);
  if (!skill) return { ok: false, code: 'skill-not-found', message: 'SKILL 不存在：' + skillId };

  try {
    const call = repos.skillCallsRepo.create({
      ts: typeof a.ts === 'string' && a.ts.trim() ? a.ts.trim() : new Date().toISOString(),
      skill: skill.id,
      name: skill.name,
      version: skill.version,
      task: task,
      result: result,
      reason: reason,
      outputs: outputs,
      source: a.source === 'manual' ? 'manual' : 'agent',
      runId: typeof a.runId === 'string' && a.runId ? a.runId : null,
    });
    return { ok: true, id: call.id, call: call };
  } catch (err) {
    return { ok: false, code: (err && err.code) || 'skill-call-write-failed', message: String(err && err.message ? err.message : err) };
  }
}

/**
 * 执行归档 + 写 reportsRepo 撤销依据（工具与降级路径共用的唯一实现）。
 * 返回 { archiveDir, archivedAt, moved, failed, skipped, reportId }。
 */
export async function performArchive(args) {
  const a = args || {};
  const impl = typeof a.archiveEngine === 'function' ? a.archiveEngine : archiveEngine;
  const result = await impl({ root: a.root, items: a.items, onStep: a.onStep });
  const rawMoved = Array.isArray(result && result.moved) ? result.moved : [];
  const rawFailed = Array.isArray(result && result.failed) ? result.failed : [];
  // 目录归档已上线：不再有「目录不支持」这条路径，任何失败都归入 failed。
  const skipped = [];
  const failed = rawFailed.map((item) => ({
    relPath: String((item && item.relPath) || ''),
    code: String((item && item.code) || 'ARCHIVE_FAILED'),
    message: String((item && item.message) || '归档失败'),
  }));
  const archivedAt = (result && result.archivedAt) || new Date().toISOString();
  const rootAbs = path.resolve(a.root);
  const relOf = (target) => {
    const rel = path.relative(rootAbs, path.resolve(String(target || '')));
    return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : String(target || '');
  };
  const moved = rawMoved.map((item) => ({
    from: item.from,
    to: item.to,
    kind: item.kind === 'dir' ? 'dir' : 'file',
  }));
  // 撤销依据里存相对路径（可移植，不绑死某台机器的临时目录）
  const undoItems = moved.map((item) => {
    const relTo = relOf(item.to);
    const matched = (a.reasons || []).filter((entry) => entry.to === relTo)[0];
    return {
      from: relOf(item.from),
      to: relTo,
      kind: item.kind === 'dir' ? 'dir' : 'file',
      reason: matched && matched.reason ? matched.reason : '',
      archivedAt: archivedAt,
    };
  });
  let reportId = null;
  try {
    const record = createRepos({ root: a.root }).reportsRepo.create({
      kind: 'archive',
      period: localDateKey(new Date()),
      summary: 'moved=' + moved.length + ' failed=' + failed.length + (skipped.length > 0 ? ' skipped=' + skipped.length : ''),
      path: (result && result.archiveDir) || '',
      items: undoItems,
    });
    reportId = record.id;
  } catch (err) { reportId = null; }
  return {
    archiveDir: (result && result.archiveDir) || '',
    archivedAt: archivedAt,
    moved: moved,
    failed: failed,
    skipped: skipped,
    undoItems: undoItems,
    reportId: reportId,
    recordError: reportId ? null : 'archive-report-write-failed',
  };
}

// 共用函数的小写 code → 工具侧的既有错误码（保持对外契约不变）。
const SKILL_CALL_TOOL_CODES = {
  'result-invalid': 'RESULT_INVALID',
  'task-required': 'TASK_REQUIRED',
  'task-too-long': 'TASK_TOO_LONG',
  'reason-required': 'REASON_REQUIRED',
  'output-forbidden': 'OUTPUT_FORBIDDEN',
  'skill-not-found': 'SKILL_NOT_FOUND',
};

// 工具返回值统一收敛成这四个键，schema 才能用 additionalProperties:false。
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    runId: { type: 'string' },
    code: { type: 'string' },
    message: { type: 'string' },
    id: { type: 'string' },
    path: { type: 'string' },
    reportPath: { type: 'string' },
    byRule: {
      type: 'object',
      additionalProperties: false,
      properties: {
        M01: { type: 'number' },
        M03: { type: 'number' },
        M04: { type: 'number' },
        M08: { type: 'number' },
      },
    },
    version: { type: 'string' },
    archiveDir: { type: 'string' },
    mode: { type: 'string' },
    alreadyActive: { type: 'boolean' },
    auditError: { type: 'string' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          level: { type: 'string' },
          title: { type: 'string' },
          detail: { type: 'string' },
          code: { type: 'string' },
          repairId: { type: 'string' },
          repairable: { type: 'boolean' },
        },
      },
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      properties: {
        total: { type: 'number' },
        ok: { type: 'number' },
        warn: { type: 'number' },
        error: { type: 'number' },
        blocked: { type: 'number' },
        repairable: { type: 'number' },
        planned: { type: 'number' },
        applied: { type: 'number' },
        skipped: { type: 'number' },
        failed: { type: 'number' },
      },
    },
    planned: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repairId: { type: 'string' },
          checkId: { type: 'string' },
          action: { type: 'string' },
          risk: { type: 'string' },
          targets: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    applied: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repairId: { type: 'string' },
          status: { type: 'string' },
          detail: { type: 'string' },
          movedTo: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    movedTo: { type: 'array', items: { type: 'string' } },
    runs: { type: 'array', items: { type: 'string' } },
    reportId: { type: 'string' },
    preview: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
    moved: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          kind: { type: 'string' },
        },
      },
    },
    failed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          relPath: { type: 'string' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          relPath: { type: 'string' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          version: { type: 'string' },
    archiveDir: { type: 'string' },
    mode: { type: 'string' },
    alreadyActive: { type: 'boolean' },
    auditError: { type: 'string' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          level: { type: 'string' },
          title: { type: 'string' },
          detail: { type: 'string' },
          code: { type: 'string' },
          repairId: { type: 'string' },
          repairable: { type: 'boolean' },
        },
      },
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      properties: {
        total: { type: 'number' },
        ok: { type: 'number' },
        warn: { type: 'number' },
        error: { type: 'number' },
        blocked: { type: 'number' },
        repairable: { type: 'number' },
        planned: { type: 'number' },
        applied: { type: 'number' },
        skipped: { type: 'number' },
        failed: { type: 'number' },
      },
    },
    planned: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repairId: { type: 'string' },
          checkId: { type: 'string' },
          action: { type: 'string' },
          risk: { type: 'string' },
          targets: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    applied: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repairId: { type: 'string' },
          status: { type: 'string' },
          detail: { type: 'string' },
          movedTo: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    movedTo: { type: 'array', items: { type: 'string' } },
    runs: { type: 'array', items: { type: 'string' } },
    reportId: { type: 'string' },
    preview: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
    moved: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          kind: { type: 'string' },
        },
      },
    },
    failed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          relPath: { type: 'string' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          relPath: { type: 'string' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
          purpose: { type: 'string' },
          pagePath: { type: 'string' },
          score: { type: 'number' },
        },
      },
    },
    expert: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        domain: { type: 'string' },
        responsibility: { type: 'string' },
        promptFragment: { type: 'string' },
        status: { type: 'string' },
      },
    },
    experts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          domain: { type: 'string' },
          responsibility: { type: 'string' },
          promptFragment: { type: 'string' },
          status: { type: 'string' },
          skillIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          version: { type: 'string' },
    archiveDir: { type: 'string' },
    mode: { type: 'string' },
    alreadyActive: { type: 'boolean' },
    auditError: { type: 'string' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          level: { type: 'string' },
          title: { type: 'string' },
          detail: { type: 'string' },
          code: { type: 'string' },
          repairId: { type: 'string' },
          repairable: { type: 'boolean' },
        },
      },
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      properties: {
        total: { type: 'number' },
        ok: { type: 'number' },
        warn: { type: 'number' },
        error: { type: 'number' },
        blocked: { type: 'number' },
        repairable: { type: 'number' },
        planned: { type: 'number' },
        applied: { type: 'number' },
        skipped: { type: 'number' },
        failed: { type: 'number' },
      },
    },
    planned: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repairId: { type: 'string' },
          checkId: { type: 'string' },
          action: { type: 'string' },
          risk: { type: 'string' },
          targets: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    applied: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repairId: { type: 'string' },
          status: { type: 'string' },
          detail: { type: 'string' },
          movedTo: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    movedTo: { type: 'array', items: { type: 'string' } },
    runs: { type: 'array', items: { type: 'string' } },
    reportId: { type: 'string' },
    preview: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
    moved: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          kind: { type: 'string' },
        },
      },
    },
    failed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          relPath: { type: 'string' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          relPath: { type: 'string' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
          status: { type: 'string' },
          path: { type: 'string' },
        },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ruleId: { type: 'string' },
          relPath: { type: 'string' },
          path: { type: 'string' },
          title: { type: 'string' },
          detail: { type: 'string' },
          basis: { type: 'string' },
          level: { type: 'string' },
          threshold: { type: 'string' },
        },
      },
    },
  },
  required: ['ok'],
};

function render(_args, value) {
  const v = value || {};
  const head = v.ok === true ? 'OK' : 'FAIL';
  const id = v.runId ? ' [' + v.runId + ']' : '';
  const code = v.ok === true ? '' : (v.code ? ' ' + v.code + ':' : '');
  return [{ type: 'text', text: head + id + code + (v.message ? ' ' + v.message : '') }];
}

function runIdParam(description) {
  return { type: 'string', description: description, };
}

export function createToolHandlers(deps) {
  const store = deps && deps.store;
  const engineOverride = deps && deps.engine && typeof deps.engine === 'object' ? deps.engine : null;
  const maintainImpl = engineOverride && typeof engineOverride.maintain === 'function' ? engineOverride.maintain : maintainEngine;
  const archiveImpl = engineOverride && typeof engineOverride.archiveItems === 'function' ? engineOverride.archiveItems : archiveEngine;

  function currentRoot() {
    const settings = store && typeof store.get === 'function' ? store.get() : null;
    return settings && typeof settings.root === 'string' && settings.root ? settings.root : null;
  }

  function guard(args) {
    const a = args || {};
    const runId = typeof a.runId === 'string' ? a.runId.trim() : '';
    if (!runId) return { error: { ok: false, code: 'run-id-required', message: '必须提供 runId' } };
    if (!trace.isSafeRunId(runId)) return { error: { ok: false, runId: runId, code: 'run-id-invalid', message: 'runId 非法' } };
    const root = currentRoot();
    if (!root) return { error: { ok: false, runId: runId, code: 'root-missing', message: '尚未配置知识库根目录' } };
    const data = trace.readRun(root, runId);
    if (!data) return { error: { ok: false, runId: runId, code: 'run-not-found', message: 'run 不存在：' + runId } };
    if (data.run.status !== 'running') {
      return { error: { ok: false, runId: runId, code: 'run-not-running', message: 'run 已结束（' + data.run.status + '），拒绝继续写入' } };
    }
    // 每次工具调用进入都刷 agent 心跳；失败/终态时 touchRun 自己返回 null，不报错。
    trace.touchRun(root, runId, 'agent');
    return { root: root, runId: runId, run: data.run };
  }

  async function action(args, meta, work) {
    const g = guard(args);
    if (g.error) return g.error;
    const startedAt = new Date().toISOString();
    const collector = trace.createStepCollector({ root: g.root, runId: g.runId, role: meta.role });
    try {
      const summary = await work({ root: g.root, runId: g.runId, collector: collector, args: args || {} });
      collector.record({
        title: meta.title,
        status: 'ok',
        startedAt: startedAt,
        endedAt: new Date().toISOString(),
        inputSummary: meta.inputSummary,
        outputSummary: typeof summary === 'string' ? summary : '',
        artifacts: meta.artifacts,
      });
      await collector.flush();
      return { ok: true, runId: g.runId, message: typeof summary === 'string' ? summary : '' };
    } catch (err) {
      const text = String(err && err.message ? err.message : err);
      collector.record({
        title: meta.title,
        status: 'error',
        startedAt: startedAt,
        endedAt: new Date().toISOString(),
        inputSummary: meta.inputSummary,
        error: text,
      });
      await collector.flush();
      return { ok: false, runId: g.runId, code: (err && err.code) || 'tool-failed', message: text };
    }
  }

  const handlers = {
    async bootstrap(args) {
      const a = args || {};
      const mode = a.mode === 'topic' ? 'topic' : 'asset';
      const force = a.force === true;
      return action(a, {
        role: 'AGENT',
        title: 'jk_kb_bootstrap',
        inputSummary: 'mode=' + mode + (force ? ' force=true' : ''),
      }, async (ctx) => {
        const result = await engine.bootstrap({ root: ctx.root, mode: mode, force: force, onStep: ctx.collector.onEngineStep });
        return '建库完成：新建 ' + (result && result.created ? result.created.length : 0) + ' 项，跳过 ' + (result && result.skipped ? result.skipped.length : 0) + ' 项';
      });
    },

    async verify(args) {
      const a = args || {};
      return action(a, {
        role: 'AGENT',
        title: 'jk_kb_verify',
        inputSummary: '体检',
      }, async (ctx) => {
        const result = await engine.verify({ root: ctx.root });
        const summary = String(result && result.summary ? result.summary : '体检完成');
        if (result && result.ok === false) {
          const err = new Error(summary);
          err.code = 'verify-failed';
          throw err;
        }
        return summary;
      });
    },

    async reindex(args) {
      const a = args || {};
      return action(a, {
        role: 'AGENT',
        title: 'jk_kb_reindex',
        inputSummary: '重建索引',
      }, async (ctx) => {
        const result = await engine.reindex({ root: ctx.root, onStep: ctx.collector.onEngineStep });
        return '索引已重建' + (result && typeof result.noteCount === 'number' ? '：' + result.noteCount + ' 条笔记' : '');
      });
    },

    async inspect(args) {
      const a = args || {};
      // 只读工具：不强制 runId；但给了就必须是 running 的 run。
      if (typeof a.runId === 'string' && a.runId.trim()) {
        const g = guard(a);
        if (g.error) return g.error;
      }
      const root = currentRoot();
      if (!root) return { ok: false, code: 'root-missing', message: '尚未配置知识库根目录' };
      try {
        const result = await engine.inspect({ root: root });
        const text = JSON.stringify(result);
        return { ok: true, message: text.length > 1500 ? text.slice(0, 1500) + '…' : text };
      } catch (err) {
        return { ok: false, code: 'inspect-failed', message: String(err && err.message ? err.message : err) };
      }
    },

    async step(args) {
      const g = guard(args);
      if (g.error) return g.error;
      const a = args || {};
      const status = trace.STEP_STATUSES.indexOf(a.status) >= 0 ? a.status : 'ok';
      const title = typeof a.title === 'string' && a.title ? a.title : 'step';
      const appended = await trace.appendStep({
        root: g.root,
        runId: g.runId,
        step: {
          role: typeof a.role === 'string' && a.role ? a.role : 'AGENT',
          title: title,
          status: status,
          inputSummary: typeof a.inputSummary === 'string' ? a.inputSummary : '',
          outputSummary: typeof a.outputSummary === 'string' ? a.outputSummary : '',
          artifacts: Array.isArray(a.artifacts) ? a.artifacts : [],
          error: status === 'error' ? (typeof a.error === 'string' ? a.error : 'error') : null,
        },
      });
      if (!appended) return { ok: false, runId: g.runId, code: 'step-write-failed', message: 'step 写入失败' };
      return { ok: true, runId: g.runId, message: '已记录 step：' + title };
    },

    async curate(args) {
      const a = args || {};
      const g = guard(a);
      if (g.error) return g.error;

      const skill = skillsById.get(String(a.skillId || ''));
      if (!skill) return { ok: false, runId: g.runId, code: 'UNKNOWN_SKILL', message: '未知技能：' + String(a.skillId) };

      // expertId 可选：存在且 active 才接受（未知/已归档 → EXPERT_INVALID，不落盘）。
      const expertId = typeof a.expertId === 'string' && a.expertId.trim() ? a.expertId.trim() : '';
      let expert = null;
      if (expertId) {
        expert = createRepos({ root: g.root }).expertsRepo.get(expertId);
        if (!expert || expert.status !== 'active') {
          return { ok: false, runId: g.runId, code: 'EXPERT_INVALID', message: '专家不存在或已归档：' + expertId };
        }
      }

      // 必须在锁内分配编号：锁必须属于当前 run。
      let lock = null;
      try { lock = trace.readLock(g.root); } catch (err) { lock = null; }
      if (!lock || lock.runId !== g.runId) {
        return { ok: false, runId: g.runId, code: 'LOCK_REQUIRED', message: '入柜必须在持有当前 run 锁时进行' };
      }

      const repos = createRepos({ root: g.root, assertWritable: a.assertWritable });
      let nextId;
      try {
        nextId = repos.numbersRepo.allocateInLock(lock, skill.idPrefix || 'SK', 1).ids[0];
      } catch (err) {
        return {
          ok: false,
          runId: g.runId,
          code: (err && err.code) || 'NUMBER_ALLOCATE_FAILED',
          message: String(err && err.message ? err.message : err),
        };
      }

      const startedAt = new Date().toISOString();
      const collector = trace.createStepCollector({ root: g.root, runId: g.runId, role: 'AGENT' });
      const steps = [];
      try {
        const result = await curateEngine({
          root: g.root,
          skillId: a.skillId,
          title: a.title,
          body: a.body,
          tags: a.tags,
          confidence: a.confidence,
          confWhy: a.confWhy,
          source: a.source,
          nextId: nextId,
          onStep: (event) => {
            steps.push(event);
            trace.touchRun(g.root, g.runId, 'engine');
            collector.onEngineStep(event);
          },
        });

        // 命中专家时把 expert 写进卡片 frontmatter（引擎不认 expertId，宿主补一行）。
        if (expert) {
          try {
            const original = fs.readFileSync(result.path, 'utf8');
            writeReportFile(g.root, result.path, insertFrontmatterField(original, 'expert', expert.id + ' ' + expert.name));
          } catch (frontErr) {
            collector.record({
              title: '卡片 expert 字段写入失败',
              status: 'error',
              error: String(frontErr && frontErr.message ? frontErr.message : frontErr),
            });
          }
        }

        // 卡片记录（id 为身份，path 只是字段）。
        try {
          const cardRecord = {
            id: result.id,
            kind: 'card',
            title: String(a.title || ''),
            path: result.path,
            sourceRunId: g.runId,
            skillId: a.skillId,
            tags: Array.isArray(a.tags) ? a.tags : [],
          };
          if (expert) cardRecord.expertId = expert.id;
          repos.cardsRepo.create(cardRecord);
        } catch (recordErr) {
          collector.record({
            title: '卡片记录写入失败',
            status: 'error',
            startedAt: startedAt,
            endedAt: new Date().toISOString(),
            error: String(recordErr && recordErr.message ? recordErr.message : recordErr),
          });
          await collector.flush();
          return {
            ok: false,
            runId: g.runId,
            code: (recordErr && recordErr.code) || 'CARD_RECORD_FAILED',
            message: '卡片已落盘但记录失败：' + (recordErr && recordErr.message ? recordErr.message : recordErr) + '（' + result.path + '）',
          };
        }

        collector.record({
          title: 'jk_kb_curate',
          status: 'ok',
          startedAt: startedAt,
          endedAt: new Date().toISOString(),
          inputSummary: 'skill=' + a.skillId + ' id=' + result.id,
          outputSummary: result.path,
          artifacts: [result.path],
        });
        await collector.flush();
        return {
          ok: true,
          runId: g.runId,
          id: result.id,
          path: result.path,
          message: (summarizeWarnings(result.warnings) || '入柜完成'),
        };
      } catch (err) {
        const text = String(err && err.message ? err.message : err);
        collector.record({
          title: 'jk_kb_curate',
          status: 'error',
          startedAt: startedAt,
          endedAt: new Date().toISOString(),
          inputSummary: 'skill=' + a.skillId,
          error: text,
        });
        await collector.flush();
        return { ok: false, runId: g.runId, code: (err && err.code) || 'curate-failed', message: text };
      }
    },

    async maintain(args) {
      const a = args || {};
      const g = guard(a);
      if (g.error) return g.error;

      const startedAt = new Date().toISOString();
      const collector = trace.createStepCollector({ root: g.root, runId: g.runId, role: 'AGENT' });
      try {
        const result = await maintainImpl({
          root: g.root,
          thresholds: a.thresholds && typeof a.thresholds === 'object' ? a.thresholds : null,
          onStep: (event) => {
            trace.touchRun(g.root, g.runId, 'engine');
            collector.onEngineStep(event);
          },
        });

        const period = localDateKey(result && result.generatedAt ? result.generatedAt : new Date());
        const reportPath = path.join(g.root, '00_系统与索引', '整理报告-' + period + '.md');
        writeTextGuarded(g.root, reportPath, renderMaintainMarkdown(result, period));

        const byRule = (result && result.byRule) || {};
        const summary = summarizeByRule(byRule);
        try {
          saveMaintainReport(createRepos({ root: g.root }), buildReportRecord({
            kind: 'maintain',
            period: period,
            summary: summary,
            path: reportPath,
            byRule: byRule,
            scanned: result && result.scanned ? result.scanned : null,
            findings: result && result.findings ? result.findings : [],
          }));
        } catch (recordErr) {
          collector.record({
            title: '整理报告记录写入失败',
            status: 'error',
            error: String(recordErr && recordErr.message ? recordErr.message : recordErr),
          });
        }

        collector.record({
          title: 'jk_kb_maintain',
          status: 'ok',
          startedAt: startedAt,
          endedAt: new Date().toISOString(),
          inputSummary: 'thresholds=' + JSON.stringify(a.thresholds || null),
          outputSummary: summary + ' → ' + reportPath,
          artifacts: [reportPath],
        });
        await collector.flush();
        return {
          ok: true,
          runId: g.runId,
          reportPath: reportPath,
          byRule: byRule,
          findings: Array.isArray(result && result.findings) ? result.findings : [],
          message: summary,
        };
      } catch (err) {
        const text = String(err && err.message ? err.message : err);
        collector.record({
          title: 'jk_kb_maintain',
          status: 'error',
          startedAt: startedAt,
          endedAt: new Date().toISOString(),
          error: text,
        });
        await collector.flush();
        return { ok: false, runId: g.runId, code: (err && err.code) || 'maintain-failed', message: text };
      }
    },

    async doctor(args) {
      const a = args || {};
      const root = typeof a.root === 'string' && a.root.trim() ? a.root.trim() : currentRoot();
      if (!root) return { ok: false, code: 'root-missing', message: '尚未配置知识库根目录' };
      const api = await loadDoctorEngine();
      if (!api) return { ok: false, code: 'doctor-unavailable', message: 'doctor 引擎不可用' };

      const startedAt = Date.now();
      let diagnosis;
      try {
        diagnosis = await api.diagnose({ root: root });
      } catch (err) {
        return { ok: false, code: (err && err.code) || 'doctor-failed', message: String(err && err.message ? err.message : err) };
      }
      const repairIds = Array.isArray(a.repairIds)
        ? a.repairIds.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
        : [];

      if (repairIds.length > 0 && a.confirm !== true) {
        let planned = [];
        try {
          const preview = await api.repair({ root: root, repairIds: repairIds, dryRun: true });
          planned = Array.isArray(preview && preview.planned) ? preview.planned : [];
        } catch (err) { planned = []; }
        return {
          ok: false,
          code: 'NEED_CONFIRM',
          checks: diagnosis.checks,
          summary: diagnosis.summary,
          planned: planned,
          message: '执行修复需要 confirm:true（先看 planned 预览）',
        };
      }

      if (repairIds.length === 0) {
        return {
          ok: true,
          mode: 'diagnose',
          root: root,
          checks: diagnosis.checks,
          summary: diagnosis.summary,
          message: '只诊断，未执行任何修复',
        };
      }

      let repair;
      try {
        repair = await api.repair({ root: root, repairIds: repairIds, dryRun: false });
      } catch (err) {
        const payload = {
          ok: false,
          code: (err && err.code) || 'repair-failed',
          message: String(err && err.message ? err.message : err),
        };
        if (err && Array.isArray(err.runs)) payload.runs = err.runs;
        return payload;
      }
      const audit = await writeDoctorAudit({
        root: root, diagnosis: diagnosis, repair: repair, repairIds: repairIds, elapsedMs: Date.now() - startedAt,
      });
      const movedTo = [];
      (repair.applied || []).forEach((item) => { (item.movedTo || []).forEach((target) => movedTo.push(target)); });
      const payload = {
        ok: true,
        mode: 'repair',
        root: root,
        applied: repair.applied || [],
        summary: repair.summary || {},
        movedTo: movedTo,
        reportPath: audit.reportPath,
        runId: audit.runId,
        message: '修复完成：applied=' + ((repair.summary && repair.summary.applied) || 0),
      };
      if (audit.error) payload.auditError = audit.error;
      return payload;
    },

    async archive(args) {
      const a = args || {};
      const g = guard(a);
      if (g.error) return g.error;
      const items = Array.isArray(a.items) ? a.items : [];
      if (items.length === 0) {
        return { ok: false, runId: g.runId, code: 'empty-items', message: 'items 不能为空' };
      }
      const badReason = items.filter((item) => (
        !item || typeof item.reason !== 'string' || Array.from(item.reason.trim()).length < 4
      ));
      if (badReason.length > 0) {
        return {
          ok: false,
          runId: g.runId,
          code: 'reason-required',
          message: '每个 item 都必须写 reason（至少 4 个字符）',
          failed: badReason.map((item) => ({
            relPath: String(item && item.relPath ? item.relPath : ''),
            code: 'REASON_REQUIRED',
            message: 'reason 必填且至少 4 个字符',
          })),
        };
      }

      const preview = items.map((item) => ({
        from: String(item.relPath || '').trim(),
        to: path.posix.join('12_归档与历史', '03_归档笔记', String(item.relPath || '').trim()),
        reason: String(item.reason || '').trim(),
      }));
      if (a.confirm !== true) {
        return {
          ok: false,
          runId: g.runId,
          code: 'NEED_CONFIRM',
          preview: preview,
          message: '归档是破坏性操作，必须带 confirm:true 才会执行（当前未写任何文件）',
        };
      }

      const startedAt = new Date().toISOString();
      const collector = trace.createStepCollector({ root: g.root, runId: g.runId, role: 'AGENT' });
      try {
        const outcome = await performArchive({
          root: g.root,
          items: items.map((item) => ({
            relPath: String(item.relPath || '').trim(),
            reason: String(item.reason || '').trim(),
            successorLink: typeof item.successorLink === 'string' && item.successorLink ? item.successorLink : undefined,
          })),
          reasons: preview,
          archiveEngine: archiveImpl,
          onStep: (event) => {
            trace.touchRun(g.root, g.runId, 'engine');
            collector.onEngineStep(event);
          },
        });
        const moved = outcome.moved;
        const failed = outcome.failed;
        const skipped = outcome.skipped;
        const reportId = outcome.reportId;
        if (outcome.recordError) {
          collector.record({ title: '归档记录写入失败', status: 'error', error: outcome.recordError });
        }

        collector.record({
          title: 'jk_kb_archive',
          status: failed.length > 0 ? 'error' : 'ok',
          startedAt: startedAt,
          endedAt: new Date().toISOString(),
          inputSummary: items.length + ' 项，confirm=true',
          outputSummary: 'moved=' + moved.length + ' failed=' + failed.length + ' skipped=' + skipped.length,
          artifacts: outcome.undoItems.map((item) => item.to),
        });
        await collector.flush();

        return {
          ok: true,
          runId: g.runId,
          archiveDir: outcome.archiveDir || '',
          moved: moved.map((item) => ({ from: item.from, to: item.to, kind: item.kind })),
          failed: failed,
          skipped: skipped,
          reportId: reportId,
          message: '已归档 ' + moved.length + ' 项'
            + (failed.length > 0 ? '，失败 ' + failed.length + ' 项' : '')
            ,
        };
      } catch (err) {
        const text = String(err && err.message ? err.message : err);
        collector.record({ title: 'jk_kb_archive', status: 'error', startedAt: startedAt, endedAt: new Date().toISOString(), error: text });
        await collector.flush();
        return { ok: false, runId: g.runId, code: (err && err.code) || 'archive-failed', message: text };
      }
    },

    async expertCreate(args) {
      const a = args || {};
      const g = guard(a);
      if (g.error) return g.error;
      let lock = null;
      try { lock = trace.readLock(g.root); } catch (err) { lock = null; }
      const result = createExpert({
        root: g.root,
        name: a.name, domain: a.domain, responsibility: a.responsibility,
        promptFragment: a.promptFragment, skillIds: a.skillIds,
        lock: lock && lock.runId === g.runId ? lock : null,
      });
      if (!result.ok) return { ok: false, runId: g.runId, code: result.code, message: result.message };
      return { ok: true, runId: g.runId, id: result.expert.id, expert: result.expert, message: '已创建业务专家 ' + result.expert.id };
    },

    async expertUpdate(args) {
      const a = args || {};
      const g = guard(a);
      if (g.error) return g.error;
      const result = updateExpert({ root: g.root, id: a.id, patch: a.patch });
      if (!result.ok) return { ok: false, runId: g.runId, code: result.code, message: result.message };
      return { ok: true, runId: g.runId, id: result.expert.id, expert: result.expert, message: '已更新 ' + result.expert.id };
    },

    async expertRestore(args) {
      const a = args || {};
      const root = currentRoot();
      if (!root) return { ok: false, code: 'root-missing', message: '尚未配置知识库根目录' };
      if (typeof a.runId === 'string' && a.runId.trim()) {
        const g = guard(a);
        if (g.error) return g.error;
      }
      const result = restoreExpert({ root: root, id: a.id });
      if (!result.ok) return { ok: false, runId: a.runId, code: result.code, message: result.message };
      return {
        ok: true,
        runId: typeof a.runId === 'string' ? a.runId : undefined,
        id: result.expert.id,
        expert: result.expert,
        alreadyActive: result.alreadyActive,
        message: result.alreadyActive ? '专家已是 active' : '已恢复 ' + result.expert.id,
      };
    },

    async expertList(args) {
      const a = args || {};
      const root = currentRoot();
      if (!root) return { ok: false, code: 'root-missing', message: '尚未配置知识库根目录' };
      if (typeof a.runId === 'string' && a.runId.trim()) {
        const g = guard(a);
        if (g.error) return g.error;
      }
      const status = a.status === 'archived' ? 'archived' : 'active';
      const experts = createRepos({ root: root }).expertsRepo.list()
        .filter((item) => String(item.status || 'active') === status)
        .map((item) => expertView(item));
      return { ok: true, experts: experts, message: '共 ' + experts.length + ' 位（' + status + '）' };
    },

    async expertArchive(args) {
      const a = args || {};
      const g = guard(a);
      if (g.error) return g.error;
      const result = archiveExpert({ root: g.root, id: a.id });
      if (!result.ok) return { ok: false, runId: g.runId, code: result.code, message: result.message };
      return { ok: true, runId: g.runId, id: result.expert.id, expert: result.expert, message: '已归档 ' + result.expert.id };
    },

    async skillCreate(args) {
      const a = args || {};
      const g = guard(a);
      if (g.error) return g.error;
      const name = String(a.name === null || a.name === undefined ? '' : a.name).trim();
      const purpose = String(a.purpose === null || a.purpose === undefined ? '' : a.purpose).trim();
      if (!name) return { ok: false, runId: g.runId, code: 'NAME_REQUIRED', message: 'name 必填' };
      if (!purpose) return { ok: false, runId: g.runId, code: 'PURPOSE_REQUIRED', message: 'purpose 必填' };

      const repos = createRepos({ root: g.root });
      const existing = repos.skillsRepo.list().filter((item) => item.status !== 'archived');
      const decision = decideCreate({ name: name, purpose: purpose, existing: existing });
      const confirm = a.confirm === true;
      if (decision.action !== 'ok' && !confirm) {
        return {
          ok: false,
          runId: g.runId,
          code: 'NEED_CONFIRM',
          matches: decision.matches,
          message: decision.action === 'duplicate'
            ? '同名 SKILL 已存在：' + (decision.matches[0] || {}).id + '（再次创建会升级版本）'
            : '发现相似的 SKILL（' + decision.matches.length + ' 条），请确认是否仍要新建',
        };
      }

      let lock = null;
      try { lock = trace.readLock(g.root); } catch (err) { lock = null; }
      if (!lock || lock.runId !== g.runId) {
        return { ok: false, runId: g.runId, code: 'LOCK_REQUIRED', message: '创建 SKILL 必须在持有当前 run 锁时进行' };
      }

      const keywords = Array.isArray(a.keywords) ? a.keywords.filter((item) => typeof item === 'string' && item.trim()) : [];
      const fields = Array.isArray(a.fields) ? a.fields.filter((item) => typeof item === 'string' && item.trim()) : [];
      const scenario = typeof a.scenario === 'string' ? a.scenario : '';
      const profession = typeof a.profession === 'string' && a.profession.trim() ? a.profession.trim() : '通用';
      const startedAt = new Date().toISOString();
      const collector = trace.createStepCollector({ root: g.root, runId: g.runId, role: 'AGENT' });

      try {
        let record = null;
        let pageAbs = null;
        let archivedAbs = null;
        if (decision.action === 'duplicate') {
          const target = repos.skillsRepo.get(decision.matches[0].id);
          if (!target) return { ok: false, runId: g.runId, code: 'not-found', message: '同名 SKILL 记录丢失' };
          const explicit = typeof a.version === 'string' && a.version.trim() ? a.version.trim() : null;
          const nextVersion = explicit && compareVersion(explicit, target.version) > 0 ? explicit : bumpPatch(target.version);
          const page = engine.renderSkillPage({
            skill: { id: target.id, name: name, purpose: purpose, scenario: scenario || target.scenario || '', keywords: keywords, fields: fields, version: nextVersion, profession: profession || target.profession || '通用' },
          });
          archivedAbs = await engine.archiveSkillPage({
            root: g.root,
            skill: { id: target.id, name: target.name, purpose: target.purpose, scenario: target.scenario || '', keywords: target.keywords || [], fields: target.fields || [], version: target.version, profession: target.profession || '通用' },
            reason: '升级到 v' + nextVersion,
            nextVersionLink: page.relPath,
          });
          pageAbs = path.join(g.root, page.relPath);
          writeReportFile(g.root, pageAbs, page.content);
          record = repos.skillsRepo.update(target.id, Object.assign({}, target, {
            name: name, purpose: purpose, scenario: scenario, keywords: keywords, fields: fields,
            version: nextVersion, status: 'active', path: pageAbs, relPath: page.relPath,
            profession: profession || target.profession || '通用',
            archivedPath: archivedAbs && archivedAbs.archivedPath ? archivedAbs.archivedPath : null,
          }));
        } else {
          const nextId = repos.numbersRepo.allocateInLock(lock, 'SK', 1).ids[0];
          const version = '1.0.0';
          const page = engine.renderSkillPage({
            skill: { id: nextId, name: name, purpose: purpose, scenario: scenario, keywords: keywords, fields: fields, version: version, profession: profession },
          });
          pageAbs = path.join(g.root, page.relPath);
          writeReportFile(g.root, pageAbs, page.content);
          record = repos.skillsRepo.create({
            id: nextId, name: name, purpose: purpose, scenario: scenario, keywords: keywords, fields: fields,
            version: version, status: 'active', path: pageAbs, relPath: page.relPath, profession: profession,
          });
        }

        collector.record({
          title: 'jk_kb_skill_create',
          status: 'ok',
          startedAt: startedAt,
          endedAt: new Date().toISOString(),
          inputSummary: 'name=' + name + ' action=' + decision.action,
          outputSummary: record.id + ' v' + record.version + ' → ' + pageAbs,
          artifacts: [pageAbs],
        });
        await collector.flush();
        return {
          ok: true,
          runId: g.runId,
          id: record.id,
          version: record.version,
          path: pageAbs,
          message: decision.action === 'duplicate' ? ('已升级到 v' + record.version) : ('已创建 ' + record.id),
        };
      } catch (err) {
        const text = String(err && err.message ? err.message : err);
        collector.record({ title: 'jk_kb_skill_create', status: 'error', startedAt: startedAt, endedAt: new Date().toISOString(), error: text });
        await collector.flush();
        return { ok: false, runId: g.runId, code: (err && err.code) || 'skill-create-failed', message: text };
      }
    },

    async skillFind(args) {
      const a = args || {};
      // 验收要求：find 也必须在 running run 上调用（只有 list 允许无 runId）。
      const g = guard(a);
      if (g.error) return g.error;
      const root = g.root;
      const query = normalizeForCompare(a.query);
      if (!query) return { ok: false, code: 'QUERY_REQUIRED', message: 'query 必填' };
      const all = createRepos({ root: root }).skillsRepo.list();
      const hits = all.filter((item) => {
        const haystack = normalizeForCompare([item.id, item.name, item.purpose, (item.keywords || []).join(' ')].join(' '));
        if (haystack.indexOf(query) >= 0) return true;
        return similarity(a.query, String(item.name || '')) >= 0.5;
      });
      if (hits.length === 0) {
        return { ok: false, code: 'NO_MATCH', message: '库里没有匹配的 SKILL，不做猜测' };
      }
      return {
        ok: true,
        skills: hits.map((item) => ({ id: item.id, name: item.name, version: item.version, status: item.status, path: item.path })),
        message: '命中 ' + hits.length + ' 条',
      };
    },

    async skillRun(args) {
      const a = args || {};
      const g = guard(a);
      if (g.error) return g.error;
      const recorded = recordSkillCall({
        root: g.root,
        skillId: a.skillId,
        task: a.task,
        result: a.result,
        reason: a.reason,
        outputs: a.outputs,
        ts: a.ts,
        source: 'agent',
        runId: g.runId,
      });
      if (!recorded.ok) {
        const payload = {
          ok: false,
          runId: g.runId,
          code: SKILL_CALL_TOOL_CODES[recorded.code] || String(recorded.code || 'SKILL_RUN_FAILED').toUpperCase().replace(/-/g, '_'),
          message: recorded.message,
        };
        if (recorded.outputs) payload.outputs = recorded.outputs;
        return payload;
      }
      return {
        ok: true,
        runId: g.runId,
        id: recorded.id,
        message: '已记录调用回执：' + recorded.call.skill + ' · ' + recorded.call.result,
      };
    },

    async skillList(args) {
      const a = args || {};
      const root = currentRoot();
      if (!root) return { ok: false, code: 'root-missing', message: '尚未配置知识库根目录' };
      if (typeof a.runId === 'string' && a.runId.trim()) {
        const g = guard(a);
        if (g.error) return g.error;
      }
      const skills = createRepos({ root: root }).skillsRepo.list()
        .map((item) => ({ id: item.id, name: item.name, version: item.version, status: item.status, path: item.path }));
      return { ok: true, skills: skills, message: '共 ' + skills.length + ' 条' };
    },

    async runFinish(args) {
      const g = guard(args);
      if (g.error) return g.error;
      const a = args || {};
      const status = trace.TERMINAL_RUN_STATUSES.indexOf(a.status) >= 0 ? a.status : null;
      if (!status) {
        return { ok: false, runId: g.runId, code: 'status-invalid', message: 'status 只能是 completed / failed / cancelled' };
      }
      const finished = trace.finishRun({
        root: g.root,
        runId: g.runId,
        status: status,
        summary: typeof a.summary === 'string' ? a.summary : '',
      });
      // 收尾必须清锁，否则下一个 run 会看到"锁被占用"。
      trace.releaseLock({ root: g.root, runId: g.runId });
      if (!finished) return { ok: false, runId: g.runId, code: 'run-finish-failed', message: 'run 收尾失败' };
      return { ok: true, runId: g.runId, message: 'run 已收尾：' + status };
    },
  };

  return handlers;
}

/** 生成可直接交给宿主 tools.register 的普通对象定义。 */
export function createToolDefinitions(deps) {
  const h = createToolHandlers(deps);
  return [
    {
      name: 'jk_kb_bootstrap',
      description: 'JK知识库：建库 / 补齐 13 个顶层目录与系统文件。必须带当前 runId；自动记录一条 trace step。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: '当前运行的 id（必填）' },
          mode: { type: 'string', enum: ['asset', 'topic'], description: '目录方案，默认 asset' },
          force: { type: 'boolean', description: 'true 时覆盖已存在的系统文件' },
        },
        required: ['runId'],
      },
      output: { schema: OUTPUT_SCHEMA, render: render },
      execute: (args) => h.bootstrap(args),
    },
    {
      name: 'jk_kb_verify',
      description: 'JK知识库：只读体检（结构、规范、索引完整性）。必须带当前 runId；自动记录 step。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { runId: { type: 'string', description: '当前运行的 id（必填）' } },
        required: ['runId'],
      },
      output: { schema: OUTPUT_SCHEMA, render: render },
      execute: (args) => h.verify(args),
    },
    {
      name: 'jk_kb_reindex',
      description: 'JK知识库：重建索引页与首页目录地图（不改用户笔记）。必须带当前 runId；自动记录 step。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { runId: { type: 'string', description: '当前运行的 id（必填）' } },
        required: ['runId'],
      },
      output: { schema: OUTPUT_SCHEMA, render: render },
      execute: (args) => h.reindex(args),
    },
    {
      name: 'jk_kb_inspect',
      description: 'JK知识库：只读概览（目录数、笔记数、最近文件）。runId 可选；给了就必须是运行中的 run。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { runId: { type: 'string', description: '可选：当前运行的 id' } },
      },
      output: { schema: OUTPUT_SCHEMA, render: render },
      execute: (args) => h.inspect(args),
    },
    {
      name: 'jk_kb_step',
      description: 'JK知识库：手动追加一条 trace step（编排官说明自己做了什么）。必须带当前 runId。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: '当前运行的 id（必填）' },
          role: { type: 'string', description: '角色，例如 ORCH / AGENT / PLUGIN' },
          title: { type: 'string', description: '步骤标题' },
          status: { type: 'string', enum: ['start', 'ok', 'skip', 'error'], description: '步骤状态' },
          inputSummary: { type: 'string', description: '输入摘要' },
          outputSummary: { type: 'string', description: '输出摘要' },
          artifacts: { type: 'array', items: { type: 'string' }, description: '产物路径列表' },
          error: { type: 'string', description: 'status=error 时的错误信息' },
        },
        required: ['runId', 'title'],
      },
      output: { schema: OUTPUT_SCHEMA, render: render },
      execute: (args) => h.step(args),
    },
    {
      name: 'jk_kb_curate',
      description: 'JK知识库：把一份内容按指定技能入柜成正式卡片（分配编号、落盘、登记卡片记录）。必须带当前 runId，且调用时持有该 run 的锁。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: '当前运行的 id（必填）' },
          skillId: { type: 'string', description: '技能 id（取自 GET /skills 的 47 条目录）' },
          title: { type: 'string', description: '卡片标题（≤120 字符）' },
          body: { type: 'string', description: '卡片正文（非空）' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签数组（至少 1 个）' },
          confidence: { type: 'string', enum: ['高', '中', '低'], description: '置信度；填「低」必须给 confWhy' },
          confWhy: { type: 'string', description: '低置信度理由（≥4 字符）' },
          source: { type: 'string', description: '来源（链接 / 对话 / 文件名）' },
          expertId: { type: 'string', description: '可选：业务专家 id（形如 EXP-001），命中会写进卡片 frontmatter' },
        },
        required: ['runId', 'skillId', 'title', 'body', 'tags', 'confidence'],
      },
      output: { schema: OUTPUT_SCHEMA, render: render },
      execute: (args) => h.curate(args),
    },
    {
      name: 'jk_kb_maintain',
      description: 'JK知识库：只读整理扫描（M01/M03/M04/M08），生成整理报告 md 并登记 reportsRepo。绝不移动或删除任何文件。必须带当前 runId。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: '当前运行的 id（必填）' },
          thresholds: {
            type: 'object',
            additionalProperties: false,
            properties: {
              M01: { type: 'number', description: '收件箱超期天数（默认 7）' },
              M03: { type: 'number', description: '低置信度未验证天数（默认 30）' },
              M06: { type: 'number', description: '项目已结束未归档的提议天数（默认 30）' },
              M07: { type: 'number', description: '已废弃内容可归档的提议天数（默认 30）' },
              projectDays: { type: 'number', description: 'M06 别名：项目/废弃内容归档提议的天数，默认 30' },
              deprecatedDays: { type: 'number', description: 'M07 别名：废弃内容归档提议的天数，默认 30' },
            },
          },
        },
        required: ['runId'],
      },
      output: { schema: OUTPUT_SCHEMA, render: render },
      execute: (args) => h.maintain(args),
    },
    {
      name: 'jk_kb_doctor',
      description: 'JK知识库：诊断与修复（只读诊断 → 显式选择修复项）。**不删文件、只补缺、损坏产物移入 .jkkb 的 quarantine 目录**；不带 repairIds 时只诊断，带 repairIds 必须 confirm:true 才执行。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', description: '可选：知识库根目录（默认用已配置的根）' },
          repairIds: { type: 'array', items: { type: 'string' }, description: '要执行的修复项 id（如 R-DIR-01）；不给则只诊断' },
          confirm: { type: 'boolean', description: '执行修复必须 true；否则只返回 planned 预览' },
        },
      },
      output: { schema: OUTPUT_SCHEMA, render: render },
      execute: (args) => h.doctor(args),
    },
    {
      name: 'jk_kb_archive',
      description: 'JK知识库：把选中条目归档到 12_归档与历史/03_归档笔记（破坏性操作：confirm!==true 只返回预览，不写任何文件）。items 只能来自用户选择，不得自行扩项。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: '当前运行的 id（必填）' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                relPath: { type: 'string', description: '相对根目录的文件路径' },
                reason: { type: 'string', description: '归档原因（≥4 字符）' },
                successorLink: { type: 'string', description: '继任版本链接（可选）' },
              },
              required: ['relPath', 'reason'],
            },
          },
          confirm: { type: 'boolean', description: '用户已确认才可传 true；否则只返回预览' },
        },
        required: ['runId', 'items'],
      },
      output: { schema: OUTPUT_SCHEMA, render: render },
      execute: (args) => h.archive(args),
    },
    {
      name: 'jk_kb_expert_create',
      description: 'JK知识库：创建业务专家角色卡（分配 EXP 编号，登记 expertsRepo）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: '当前运行的 id（必填）' },
          name: { type: 'string', description: '专家名称（≤60 字符）' },
          domain: { type: 'string', description: '领域（≤40 字符）' },
          responsibility: { type: 'string', description: '职责（≥10 字符）' },
          skillIds: { type: 'array', items: { type: 'string' }, description: '绑定的技能 id（内置 47 技能或注册表里的 SK）' },
          promptFragment: { type: 'string', description: '提示词片段（≤2000 字符，可选）' },
        },
        required: ['runId', 'name', 'domain', 'responsibility'],
      },
      output: { schema: OUTPUT_SCHEMA, render: render },
      execute: (args) => h.expertCreate(args),
    },
    {
      name: 'jk_kb_expert_update',
      description: 'JK知识库：局部更新业务专家角色卡（只改 patch 里的字段）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: '当前运行的 id（必填）' },
          id: { type: 'string', description: '专家 id（形如 EXP-001）' },
          patch: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              domain: { type: 'string' },
              responsibility: { type: 'string' },
              skillIds: { type: 'array', items: { type: 'string' } },
              promptFragment: { type: 'string' },
            },
          },
        },
        required: ['runId', 'id'],
      },
      output: { schema: OUTPUT_SCHEMA, render: render },
      execute: (args) => h.expertUpdate(args),
    },
    {
      name: 'jk_kb_expert_restore',
      description: 'JK知识库：把归档的业务专家恢复为 active（配置类工具，不强制 runId）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '专家 id（形如 EXP-001）' },
          runId: { type: 'string', description: '可选：当前运行的 id' },
        },
        required: ['id'],
      },
      output: { schema: OUTPUT_SCHEMA, render: render },
      execute: (args) => h.expertRestore(args),
    },
    {
      name: 'jk_kb_expert_list',
      description: 'JK知识库：列出业务专家（默认只返回 active，status=archived 可看归档）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: '可选：当前运行的 id' },
          status: { type: 'string', enum: ['active', 'archived'], description: '默认 active' },
        },
      },
      output: { schema: OUTPUT_SCHEMA, render: render },
      execute: (args) => h.expertList(args),
    },
    {
      name: 'jk_kb_expert_archive',
      description: 'JK知识库：归档业务专家（status=archived，不物理删除）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: '当前运行的 id（必填）' },
          id: { type: 'string', description: '专家 id（形如 EXP-001）' },
        },
        required: ['runId', 'id'],
      },
      output: { schema: OUTPUT_SCHEMA, render: render },
      execute: (args) => h.expertArchive(args),
    },
    {
      name: 'jk_kb_skill_create',
      description: 'JK知识库：创建 / 升级一条 SKILL（分配 SK 编号、渲染页面、登记注册表）。命中同名或相似时必须先拿到用户确认再传 confirm:true。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: '当前运行的 id（必填）' },
          name: { type: 'string', description: 'SKILL 名称' },
          purpose: { type: 'string', description: '一句话用途（解决什么问题）' },
          scenario: { type: 'string', description: '适用场景' },
          keywords: { type: 'array', items: { type: 'string' }, description: '关键词' },
          fields: { type: 'array', items: { type: 'string' }, description: '记录字段' },
          profession: { type: 'string', description: '岗位（默认「通用」）' },
          version: { type: 'string', description: '升级时显式指定更高版本（可选）' },
          confirm: { type: 'boolean', description: '用户已确认同名 / 相似风险后才允许 true' },
        },
        required: ['runId', 'name', 'purpose'],
      },
      output: { schema: OUTPUT_SCHEMA, render: render },
      execute: (args) => h.skillCreate(args),
    },
    {
      name: 'jk_kb_skill_find',
      description: 'JK知识库：按关键词 / 名称在 SKILL 注册表里查找；没有命中会返回 NO_MATCH，绝不猜测。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: '可选：当前运行的 id' },
          query: { type: 'string', description: '搜索词' },
        },
        required: ['query'],
      },
      output: { schema: OUTPUT_SCHEMA, render: render },
      execute: (args) => h.skillFind(args),
    },
    {
      name: 'jk_kb_skill_run',
      description: 'JK知识库：记录一次 SKILL 调用回执（result=ok/fail；fail 必须写 reason；outputs 只能是 03..12 顶层目录内的路径）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: '当前运行的 id（必填）' },
          skillId: { type: 'string', description: 'SKILL id（如 SK001）' },
          task: { type: 'string', description: '这次用它做了什么' },
          result: { type: 'string', enum: ['ok', 'fail'], description: '结果' },
          reason: { type: 'string', description: 'result=fail 时必填' },
          outputs: { type: 'array', items: { type: 'string' }, description: '产物路径（必须在 03..12 目录内）' },
        },
        required: ['runId', 'skillId', 'task', 'result'],
      },
      output: { schema: OUTPUT_SCHEMA, render: render },
      execute: (args) => h.skillRun(args),
    },
    {
      name: 'jk_kb_skill_list',
      description: 'JK知识库：列出 SKILL 注册表（id / name / version / status / path）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: '可选：当前运行的 id' },
        },
      },
      output: { schema: OUTPUT_SCHEMA, render: render },
      execute: (args) => h.skillList(args),
    },
    {
      name: 'jk_kb_run_finish',
      description: 'JK知识库：收尾当前 run（completed / failed / cancelled）。必须带当前 runId。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', description: '当前运行的 id（必填）' },
          status: { type: 'string', enum: ['completed', 'failed', 'cancelled'], description: '终态' },
          summary: { type: 'string', description: '一句话结果' },
        },
        required: ['runId', 'status'],
      },
      output: { schema: OUTPUT_SCHEMA, render: render },
      execute: (args) => h.runFinish(args),
    },
  ];
}
