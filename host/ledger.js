/**
 * 任务台账（S6 宿主侧）。
 *
 * - 三条 aggregation 是纯函数，日期一律按**本地时区**归日/归月（不是 UTC）。
 * - readAllRuns 合并 index.json 与 archive/index.json（按 id 去重），滚动归档的旧 run 也会出现在台账里。
 * - 人可读 md 每月一个文件：<root>/00_系统与索引/台账-YYYY-MM.md，写入走路径守卫 + 原子替换，失败只返回错误。
 */
import fs from 'node:fs';
import path from 'node:path';

import * as trace from './trace.js';
import { assertWritableSync } from './engine/guard.js';

const MONTH_NAMES = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
const MAX_PER_DAY = 50;

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function localDateKey(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

export function localMonthKey(iso) {
  return localDateKey(iso).slice(0, 7);
}

function startMs(run) {
  const value = Date.parse((run && run.startedAt) || '');
  return Number.isFinite(value) ? value : null;
}

function endMs(run) {
  const value = Date.parse((run && run.endedAt) || '');
  return Number.isFinite(value) ? value : null;
}

export function elapsedMs(run) {
  const start = startMs(run);
  if (start === null) return 0;
  const end = endMs(run);
  return end === null ? 0 : Math.max(0, end - start);
}

function usageValue(run, field) {
  const usage = run && run.usage;
  if (!usage || !Number.isFinite(usage[field])) return null;
  return usage[field];
}

export function hasUsage(run) {
  if (!run || !run.usage) return false;
  return ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    .some((field) => Number.isFinite(run.usage[field]));
}

function sumTokens(runs, field) {
  return runs.reduce((sum, run) => sum + (usageValue(run, field) || 0), 0);
}

function countStatus(runs, status) {
  return runs.filter((run) => run.status === status).length;
}

function totalsOf(runs) {
  return {
    runCount: runs.length,
    totalMs: runs.reduce((sum, run) => sum + elapsedMs(run), 0),
    inputTokens: sumTokens(runs, 'inputTokens'),
    outputTokens: sumTokens(runs, 'outputTokens'),
  };
}

/** month 视图：按月过滤后按本地日期归组。 */
export function aggregate(runs, args) {
  const a = args || {};
  const year = Number(a.year);
  const month = Number(a.month);
  const key = String(year) + '-' + pad2(month);
  const list = (Array.isArray(runs) ? runs : []).filter((run) => localMonthKey(run.startedAt) === key);
  const byDay = new Map();
  list.forEach((run) => {
    const date = localDateKey(run.startedAt);
    if (!date) return;
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push(run);
  });
  const days = Array.from(byDay.keys()).sort().map((date) => {
    const dayRuns = byDay.get(date);
    return {
      date: date,
      runCount: dayRuns.length,
      completed: countStatus(dayRuns, 'completed'),
      failed: dayRuns.filter((run) => run.status === 'failed' || run.status === 'timed_out' || run.status === 'stalled').length,
      totalMs: dayRuns.reduce((sum, run) => sum + elapsedMs(run), 0),
      inputTokens: sumTokens(dayRuns, 'inputTokens'),
      outputTokens: sumTokens(dayRuns, 'outputTokens'),
      hasUsage: dayRuns.some(hasUsage),
    };
  });
  return { view: 'month', year: year, month: month, days: days, totals: totalsOf(list) };
}

/** year 视图：固定返回 12 个月（无数据补 0）。 */
export function aggregateYear(runs, year) {
  const y = Number(year);
  const list = (Array.isArray(runs) ? runs : []).filter((run) => localDateKey(run.startedAt).slice(0, 4) === String(y));
  const months = MONTH_NAMES.map((name, index) => {
    const month = index + 1;
    const key = String(y) + '-' + name;
    const monthRuns = list.filter((run) => localMonthKey(run.startedAt) === key);
    return {
      month: month,
      runCount: monthRuns.length,
      failed: monthRuns.filter((run) => run.status === 'failed' || run.status === 'timed_out' || run.status === 'stalled').length,
      totalMs: monthRuns.reduce((sum, run) => sum + elapsedMs(run), 0),
      inputTokens: sumTokens(monthRuns, 'inputTokens'),
      outputTokens: sumTokens(monthRuns, 'outputTokens'),
    };
  });
  return { view: 'year', year: y, months: months, totals: totalsOf(list) };
}

/** day 视图：单日 run 明细（时间倒序）。 */
export function aggregateDay(runs, date) {
  const list = (Array.isArray(runs) ? runs : []).filter((run) => localDateKey(run.startedAt) === date);
  list.sort((a, b) => {
    const byTime = String(b.startedAt).localeCompare(String(a.startedAt));
    return byTime !== 0 ? byTime : String(b.id).localeCompare(String(a.id));
  });
  return {
    date: date,
    runs: list.map((run) => ({
      id: run.id,
      title: run.title || '',
      kind: run.kind || 'bootstrap',
      status: run.status,
      startedAt: run.startedAt || '',
      endedAt: run.endedAt || null,
      elapsedMs: elapsedMs(run),
      usage: run.usage || null,
      usageSource: run.usageSource || 'unavailable',
      acceptanceFailed: run.acceptanceFailed === true,
      degraded: typeof run.degraded === 'string' ? run.degraded : null,
      stepCount: Number.isFinite(run.stepCount) ? run.stepCount : 0,
    })),
    totals: totalsOf(list),
  };
}

/** 合并 index 与 archive（按 id 去重，index 优先），并补齐 run.json 的完整元数据。 */
export function readAllRuns(root) {
  const index = trace.readIndex(root);
  const archive = trace.readArchiveIndex(root);
  const byId = new Map();
  archive.runs.forEach((entry) => byId.set(entry.id, entry));
  index.runs.forEach((entry) => byId.set(entry.id, entry)); // index 更新，覆盖 archive
  const out = [];
  byId.forEach((entry) => {
    const full = trace.readRun(root, entry.id);
    if (full) {
      out.push(Object.assign({}, entry, full.run, { stepCount: entry.stepCount }));
    } else {
      out.push(Object.assign({}, entry, { usage: null }));
    }
  });
  return out;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);
  if (hours > 0) return hours + 'h' + pad2(minutes) + 'm';
  if (minutes > 0) return minutes + 'm' + pad2(seconds) + 's';
  return seconds + 's';
}

function formatClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--';
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

function formatNumber(value) {
  return Number.isFinite(value) ? String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '0';
}

function kindLabel(kind) {
  if (kind === 'bootstrap') return '建库';
  if (kind === 'verify') return '体检';
  if (kind === 'reindex') return '重建索引';
  return String(kind || '任务');
}

function tokenText(run) {
  if (!hasUsage(run)) return '无 agent，未消耗 token';
  return 'in ' + formatNumber(usageValue(run, 'inputTokens') || 0) + ' / out ' + formatNumber(usageValue(run, 'outputTokens') || 0);
}

export function renderMonthMarkdown(args) {
  const a = args || {};
  const year = Number(a.year);
  const month = Number(a.month);
  const key = String(year) + '-' + pad2(month);
  const list = (Array.isArray(a.runs) ? a.runs : []).filter((run) => localMonthKey(run.startedAt) === key);
  const byDay = new Map();
  list.forEach((run) => {
    const date = localDateKey(run.startedAt);
    if (!date) return;
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push(run);
  });

  const lines = [
    '# JK知识库台账 · ' + year + '-' + pad2(month),
    '',
    '> 由 JK知识库 插件自动生成，请勿手工编辑；每次任务结束重写本月。',
    '',
  ];

  Array.from(byDay.keys()).sort().reverse().forEach((date) => {
    lines.push('## ' + date);
    lines.push('');
    const dayRuns = byDay.get(date).slice().sort((x, y) => {
      const byTime = String(y.startedAt).localeCompare(String(x.startedAt));
      return byTime !== 0 ? byTime : String(y.id).localeCompare(String(x.id));
    });
    dayRuns.slice(0, MAX_PER_DAY).forEach((run) => {
      const parts = [
        formatClock(run.startedAt),
        kindLabel(run.kind),
        run.status,
        formatDuration(elapsedMs(run)),
        tokenText(run),
        run.acceptanceFailed === true ? '验收未过' : (run.acceptance && run.acceptance.ok === false ? '验收未过' : '通过'),
      ];
      lines.push('- ' + parts.join(' · '));
    });
    if (dayRuns.length > MAX_PER_DAY) {
      lines.push('- 另有 ' + (dayRuns.length - MAX_PER_DAY) + ' 条未展示');
    }
    lines.push('');
  });

  return lines.join('\n') + '\n';
}

export function ledgerFileFor(root, year, month) {
  return path.join(String(root), '00_系统与索引', '台账-' + year + '-' + pad2(month) + '.md');
}

/**
 * 重写某月的 md 台账。任何失败都返回 {ok:false,error}，绝不抛、也不影响 run 状态。
 */
export function writeMonthLedger(args) {
  const a = args || {};
  const root = a.root;
  const year = Number(a.year);
  const month = Number(a.month);
  if (!root || !Number.isFinite(year) || !Number.isFinite(month)) {
    return { ok: false, error: { code: 'LEDGER_INVALID', message: 'root / year / month 非法' } };
  }
  const file = ledgerFileFor(root, year, month);
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.台账-' + year + '-' + pad2(month) + '.' + process.pid + '.tmp');
  try {
    const runs = readAllRuns(root);
    const markdown = renderMonthMarkdown({ year: year, month: month, runs: runs });
    assertWritableSync(root, file);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, markdown, 'utf8');
    const replaced = trace.replaceFile(tmp, file);
    if (!replaced.ok) {
      try { fs.unlinkSync(tmp); } catch (cleanupErr) { /* 可能已被移走 */ }
      return { ok: false, error: { code: replaced.code || 'LEDGER_WRITE_FAILED', message: replaced.message || '替换失败' } };
    }
    return { ok: true, file: file, runCount: runs.length };
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (cleanupErr) { /* 忽略 */ }
    return {
      ok: false,
      error: {
        code: (err && err.code) || 'LEDGER_WRITE_FAILED',
        message: String(err && err.message ? err.message : err),
      },
    };
  }
}
