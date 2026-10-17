/**
 * doctor 报告：汇总 + 落盘 .jkkb/doctor/last.json（最近一次诊断/修复的完整记录）。
 */
import path from 'node:path';
import { writeAtomic } from '../engine/paths.js';
import { pad, summarize } from './util.js';

export function nowIso(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function lastReportPath(root) {
  return path.join(String(root), '.jkkb', 'doctor', 'last.json');
}

export function buildDiagnoseReport({ root, checks, now }) {
  return {
    ok: true,
    generatedAt: nowIso(now),
    root: root || null,
    checks,
    summary: summarize(checks),
  };
}

/**
 * 写 last.json（**仅供宿主审计路径调用**；引擎的 diagnose/repair 绝不隐式调用，
 * 保证 last.json 只有一个写者）。根不可用时静默跳过。
 */
export async function writeLastReport(ctx, payload) {
  if (!ctx.root || !ctx.rootUsable) return null;
  const abs = lastReportPath(ctx.root);
  try {
    await writeAtomic(abs, `${JSON.stringify(payload, null, 2)}\n`, { force: true, root: ctx.root });
    return abs;
  } catch {
    return null;
  }
}
