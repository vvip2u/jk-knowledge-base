/**
 * 整理规则扫描（report 类）：M01 / M03 / M04 / M08。
 *
 * 硬约束：本模块**没有任何写文件或移动文件的代码路径**——只读扫描、只产 finding，
 * 不 import writeAtomic / ensureDir，也不接受 target / action 参数。任何移动/归档/删除
 * 都必须由用户在宿主侧逐条确认后另行执行。
 *
 * 数据源：assets/maintenance-rules.json（名称/依据/原因），阈值可传参覆盖（默认 M01=7 天、M03=30 天）。
 * onStep key 序列：validate → scan → rules → report。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EngineError, throwIfAborted } from './errors.js';
import { nowIso, resolveRoot, sanitizeRelPath } from './paths.js';
import { parseFrontmatter, scanVault, stripBom } from './scan.js';

export const MAINTAIN_VERSION = 1;
const RULES_URL = new URL('../../assets/maintenance-rules.json', import.meta.url);

/** 支持 6 条只读规则：M06/M07 只产「建议归档」提议，不移动/删除任何文件。 */
export const REPORT_RULES = Object.freeze(['M01', 'M03', 'M04', 'M06', 'M07', 'M08']);
export const DEFAULT_THRESHOLDS = Object.freeze({ M01: 7, M03: 30, M06: 30, M07: 30 });
const ARCHIVE_NOTE_ROOT = path.join('12_归档与历史', '03_归档笔记');

const DAY_MS = 24 * 60 * 60 * 1000;

function parseRefs(value) {
  if (value == null) return [];
  const raw = String(value).trim().replace(/^\[|\]$/g, '');
  if (!raw || raw === '""' || raw === "''") return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter((s) => s && s !== '自指');
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(String(value).trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(from, to) {
  return (to.getTime() - from.getTime()) / DAY_MS;
}

function asNow(input) {
  if (input instanceof Date && !Number.isNaN(input.getTime())) return input;
  if (typeof input === 'string' && input.trim()) {
    const d = new Date(input);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function normalizeThresholds(input) {
  const t = { ...DEFAULT_THRESHOLDS };
  const src = input || {};
  if (Number.isFinite(src.M01)) t.M01 = src.M01;
  if (Number.isFinite(src.inboxDays)) t.M01 = src.inboxDays;
  if (Number.isFinite(src.M03)) t.M03 = src.M03;
  if (Number.isFinite(src.lowConfidenceDays)) t.M03 = src.lowConfidenceDays;
  if (Number.isFinite(src.M06)) t.M06 = src.M06;
  if (Number.isFinite(src.projectDays)) t.M06 = src.projectDays;
  if (Number.isFinite(src.M07)) t.M07 = src.M07;
  if (Number.isFinite(src.deprecatedDays)) t.M07 = src.deprecatedDays;
  return t;
}

async function loadRuleMeta() {
  let raw;
  try {
    raw = await fs.readFile(RULES_URL, 'utf8');
  } catch {
    throw new EngineError('ASSETS_MISSING', '缺少整理规则数据 assets/maintenance-rules.json');
  }
  let parsed;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch (err) {
    throw new EngineError('ASSETS_MISSING', '整理规则数据不是合法 JSON', String(err && err.message));
  }
  const map = new Map();
  for (const r of parsed.rules || []) map.set(r.id, r);
  return { all: parsed, byId: map };
}

/**
 * @param {{root:string, rules?:string[], thresholds?:object, now?:Date|string,
 *          shouldAbort?:Function, onStep?:Function}} args
 */
export async function maintain({
  root,
  rules = null,
  thresholds = null,
  now,
  shouldAbort = null,
  onStep = null,
} = {}) {
  if (shouldAbort !== null && typeof shouldAbort !== 'function') {
    throw new EngineError('INVALID_ROOT', 'shouldAbort 必须是函数或 null');
  }
  const started = Date.now();
  const nowDate = asNow(now);
  const warnings = [];
  const emit = (key, status, detail) => {
    if (typeof onStep !== 'function') return;
    try {
      onStep({ key, step: key, status, detail });
    } catch {
      /* 上层回调异常不影响扫描 */
    }
  };
  const gate = (key) => {
    try {
      throwIfAborted(shouldAbort);
    } catch (err) {
      emit(key, 'error', err && err.message ? err.message : String(err));
      throw err;
    }
  };

  // validate
  gate('validate');
  emit('validate', 'start', '校验根目录与规则');
  const abs = await resolveRoot(root);
  const limits = normalizeThresholds(thresholds);
  const meta = await loadRuleMeta();
  let selected = REPORT_RULES.slice();
  if (Array.isArray(rules) && rules.length) {
    const asked = rules.map((r) => String(r).toUpperCase());
    const unknown = asked.filter((id) => !REPORT_RULES.includes(id));
    if (unknown.length) warnings.push(`忽略不支持的规则：${unknown.join('、')}（仅支持 M01/M03/M04/M08）`);
    selected = REPORT_RULES.filter((id) => asked.includes(id));
  }
  for (const id of selected) {
    if (!meta.byId.has(id)) warnings.push(`规则数据里缺少 ${id} 的元信息，仍按内置阈值扫描`);
  }
  emit('validate', 'ok', `${selected.join('/')} ｜ M01=${limits.M01}d M03=${limits.M03}d`);

  // scan
  gate('scan');
  emit('scan', 'start', '只读扫描');
  const scan = await scanVault(abs, {});
  if (scan.truncated) warnings.push('扫描达到上限（5000 文件），统计为下限，findings 可能不完整');
  const notes = [];
  let unreadable = 0;
  for (let i = 0; i < scan.notes.length; i += 1) {
    if (i % 200 === 0) gate('scan');
    const f = scan.notes[i];
    try {
      const text = stripBom(await fs.readFile(f.abs, 'utf8'));
      notes.push({ ...f, text, fm: parseFrontmatter(text) });
    } catch {
      unreadable += 1;
    }
  }
  if (unreadable) warnings.push(`${unreadable} 篇笔记读取失败，已跳过`);
  emit('scan', 'ok', `文件 ${scan.files.length} 个 / 笔记 ${scan.notes.length} 篇`);

  // 全库编号集合与实验引用集合（M03 / M04 共用）
  const ids = new Set();
  const experimentRefs = new Set();
  for (const n of notes) {
    const id = (n.fm.id || '').trim();
    if (id) ids.add(id);
    for (const ref of parseRefs(n.fm.ref_experiment)) experimentRefs.add(ref);
    for (const m of n.text.match(/\bE-\d{4}-\d{3}\b/g) || []) experimentRefs.add(m);
  }

  // rules
  gate('rules');
  emit('rules', 'start', `执行 ${selected.length} 条规则`);
  const findings = [];
  const byRule = { M01: 0, M03: 0, M04: 0, M06: 0, M07: 0, M08: 0 };
  const metaOf = (id) => meta.byId.get(id) || { id, name: id, basis: '' };

  const add = (ruleId, note, detail, basis, threshold, extra = {}) => {
    findings.push({
      ruleId,
      level: 'warn',
      path: note.abs,
      relPath: note.rel,
      title: (note.fm.title || note.name || '').trim(),
      detail,
      basis,
      threshold,
      ...extra,
    });
    byRule[ruleId] += 1;
  };
  const proposeTarget = (rel) => sanitizeRelPath(path.join(ARCHIVE_NOTE_ROOT, rel));

  for (let i = 0; i < notes.length; i += 1) {
    if (i % 200 === 0) gate('rules');
    const n = notes[i];
    const fm = n.fm;

    // M01 收件箱超期未归位
    if (selected.includes('M01') && n.rel.startsWith('01_收件箱/')) {
      const age = daysBetween(new Date(n.mtimeMs), nowDate);
      if (age > limits.M01) {
        add(
          'M01',
          n,
          `在收件箱停留 ${age.toFixed(1)} 天（最后修改 ${new Date(n.mtimeMs).toISOString().slice(0, 10)}）`,
          'relPath + mtimeMs',
          `> ${limits.M01} 天`,
        );
      }
    }

    // M08 缺置信度（系统层文件与目录说明由引擎生成，不参与 M08，避免整库噪声）
    const isSystemNote = n.rel.startsWith('00_系统与索引/') || n.name === '_说明.md';
    if (selected.includes('M08') && !isSystemNote) {
      const conf = (fm.confidence || '').trim();
      if (!conf) {
        add('M08', n, 'frontmatter 缺 confidence 字段', 'confidence', '必填（高/中/低）');
      } else if (conf === '低' && !(fm.conf_why || '').trim()) {
        add('M08', n, 'confidence=低 但 conf_why 为空', 'confidence + conf_why', '低档必须写理由');
      }
    }

    // M03 低置信度长期未验证
    if (selected.includes('M03') && (fm.confidence || '').trim() === '低') {
      const created = parseDate(fm.created || fm.date || fm.updated);
      const age = created ? daysBetween(created, nowDate) : daysBetween(new Date(n.mtimeMs), nowDate);
      const refs = [...parseRefs(fm.ref_experiment), ...(n.text.match(/\bE-\d{4}-\d{3}\b/g) || [])];
      if (age > limits.M03 && refs.length === 0) {
        add(
          'M03',
          n,
          `低置信度已 ${age.toFixed(1)} 天且未被任何实验编号引用`,
          'confidence + created/date + ref_experiment',
          `> ${limits.M03} 天`,
        );
      }
    }

    // M04 溯源链断链
    if (selected.includes('M04')) {
      for (const key of ['ref_hypothesis', 'ref_experiment']) {
        for (const ref of parseRefs(fm[key])) {
          if (!/^[A-Za-z]+-\d{4}-\d{3}$/.test(ref)) continue;
          if (!ids.has(ref)) {
            add('M04', n, `${key}=${ref} 在库内不存在（当前共 ${ids.size} 个编号）`, key, '编号必须存在于库内');
          }
        }
      }
    }
  }

  // M06 项目已结束未归档（只读提议；按项目目录提议，不移动任何文件）
  if (selected.includes('M06')) {
    const projectRels = scan.dirs
      .map((d) => d.rel)
      .filter((rel) => rel && rel.startsWith('09_项目与运营/'))
      .filter((rel) => !rel.slice('09_项目与运营/'.length).includes('/'));
    for (const projRel of projectRels) {
      gate('rules');
      const prefix = `${projRel}/`;
      const homeNotes = notes
        .filter((n) => n.rel.startsWith(prefix) && !n.rel.slice(prefix.length).includes('/'))
        .sort((a, b) => (a.rel < b.rel ? -1 : 1));
      const doneNote = homeNotes.find((n) => ['done', 'ended', 'closed'].includes(String(n.fm.status || '').trim().toLowerCase()));
      if (!doneNote) continue;
      const updated = parseDate(doneNote.fm.updated || doneNote.fm.created);
      if (!updated) continue;
      const age = daysBetween(updated, nowDate);
      if (age <= limits.M06) continue;
      const target = proposeTarget(projRel);
      add(
        'M06',
        { abs: path.join(abs, projRel), rel: projRel, name: path.basename(projRel), fm: { title: doneNote.fm.title || path.basename(projRel) } },
        `项目状态 ${String(doneNote.fm.status).trim()} 已 ${age.toFixed(1)} 天未更新`,
        '项目首页 status + updated',
        `> ${limits.M06} 天`,
        {
          level: 'info',
          action: 'propose-archive',
          proposedTarget: target,
          archiveReason: `项目已结束（${String(doneNote.fm.status).trim()}）且 ${age.toFixed(0)} 天未更新，建议归档保留历史`,
        },
      );
    }
  }

  // M07 已废弃内容可归档（只读提议）
  if (selected.includes('M07')) {
    for (const n of notes) {
      if (String(n.fm.status || '').trim().toLowerCase() !== 'deprecated') continue;
      const updated = parseDate(n.fm.updated || n.fm.created);
      if (!updated) continue;
      const age = daysBetween(updated, nowDate);
      if (age <= limits.M07) continue;
      add(
        'M07',
        n,
        `status=deprecated 已 ${age.toFixed(1)} 天`,
        'status + updated',
        `> ${limits.M07} 天`,
        {
          level: 'info',
          action: 'propose-archive',
          proposedTarget: proposeTarget(n.rel),
          archiveReason: `内容已废弃 ${age.toFixed(0)} 天，建议归档（保留历史，不删除）`,
        },
      );
    }
  }
  findings.sort((a, b) => (a.ruleId === b.ruleId ? (a.relPath < b.relPath ? -1 : 1) : a.ruleId < b.ruleId ? -1 : 1));
  emit('rules', 'ok', `命中 ${findings.length} 条`);

  // report
  emit('report', 'start', '汇总报告');
  const summary = selected.map((id) => `${id}=${byRule[id]}`).join(' ');
  emit('report', 'ok', summary || '未执行任何规则');

  return {
    ok: true,
    generatedAt: nowIso(nowDate),
    scanned: { files: scan.files.length, notes: scan.notes.length },
    elapsedMs: Date.now() - started,
    findings,
    byRule,
    warnings,
  };
}
