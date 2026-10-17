/**
 * doctor 引擎入口：diagnose（纯读，单 check 失败降级） + repair（逐项修复、隔离不删除）。
 *
 * 由 host/engine/index.js 转出，供宿主工具/路由使用。
 */
import { EngineError } from '../engine/errors.js';
import { detectRuns, createContext, runChecks } from './checks.js';
import { REPAIRS, applyRepair, buildPlan, repairMeta } from './repairs.js';
import { buildDiagnoseReport } from './report.js';

export { REPAIRS };
export { QUARANTINE_REL } from './quarantine.js';

/** 有心跳新鲜的 running run 时，禁止执行修复（避免踩掉正在跑的 run）。 */
export async function freshRunningIds(ctx) {
  if (!ctx.root) return [];
  const { runs } = await detectRuns(ctx);
  return runs
    .filter((r) => r.run && r.run.status === 'running' && !r.staleRunning)
    .map((r) => r.id);
}

/**
 * @param {{root?:string, store?:object, now?:Date|string, deps?:object}} args
 */
export async function diagnose({ root, store, now, deps = {} } = {}) {
  const ctx = createContext({ root, store, now, deps });
  const checks = await runChecks(ctx);
  // 纯读：引擎不写 .jkkb/doctor/last.json（宿主审计路径独占该文件）。
  return buildDiagnoseReport({ root: ctx.root, checks, now: ctx.now });
}

/**
 * @param {{root?:string, store?:object, now?:Date|string, repairIds?:string[],
 *          dryRun?:boolean, deps?:object}} args
 */
export async function repair({ root, store, now, repairIds, dryRun = false, deps = {} } = {}) {
  const ctx = createContext({ root, store, now, deps });

  // 任何写入之前先卡住"正在运行的 run"（含 dryRun=false 的快照校验）。
  const ids = Array.isArray(repairIds) && repairIds.length ? repairIds.slice() : REPAIRS.map((r) => r.repairId);
  const unknown = ids.filter((id) => !repairMeta(id));
  if (unknown.length) {
    throw new EngineError('UNKNOWN_REPAIR', `未知修复项：${unknown.join('、')}`);
  }
  if (!dryRun) {
    const running = await freshRunningIds(ctx);
    if (running.length) {
      const err = new EngineError('RUN_IN_PROGRESS', `有 ${running.length} 个 run 正在运行，禁止修复：${running.join('、')}`);
      err.runs = running;
      throw err;
    }
  }

  const checks = await runChecks(ctx);

  if (!dryRun) {
    const running = await freshRunningIds(ctx);
    if (running.length) {
      const err = new EngineError('RUN_IN_PROGRESS', `有 ${running.length} 个 run 正在运行，禁止修复：${running.join('、')}`);
      err.runs = running;
      throw err;
    }
  }

  const planned = [];
  const plans = new Map();
  for (const repairId of ids) {
    try {
      const plan = await buildPlan(ctx, repairId);
      if (!plan) continue;
      const item = {
        repairId: plan.repairId,
        checkId: plan.checkId,
        action: plan.action,
        targets: plan.targets,
        risk: plan.risk,
      };
      planned.push(item);
      plans.set(repairId, plan);
    } catch (err) {
      // 检测本身失败：保留在 planned 里并让 apply 记录 failed，不整体中断
      const meta = repairMeta(repairId);
      planned.push({
        repairId,
        checkId: meta.checkId,
        action: `${meta.action}（目标检测失败：${err && err.message ? err.message : err}）`,
        targets: [],
        risk: meta.risk,
      });
    }
  }

  if (dryRun) {
    const result = {
      ok: true,
      dryRun: true,
      planned,
      applied: [],
      summary: { planned: planned.length, applied: 0, skipped: ids.length - planned.length, failed: 0 },
    };
    return result;
  }

  const applied = [];
  if (!ctx.rootUsable) {
    for (const repairId of ids) {
      applied.push({ repairId, status: 'skipped', detail: '根目录不可用或路径守卫不可用（blocked），doctor 不修' });
    }
  } else {
    for (const repairId of ids) {
      const plan = plans.get(repairId);
      if (!plan) {
        applied.push({ repairId, status: 'skipped', detail: '当前没有需要修复的项' });
        continue;
      }
      applied.push(await applyRepair(ctx, repairId, plan));
    }
  }

  const summary = {
    planned: planned.length,
    applied: applied.filter((x) => x.status === 'applied').length,
    skipped: applied.filter((x) => x.status === 'skipped').length,
    failed: applied.filter((x) => x.status === 'failed').length,
  };
  // 不写 last.json：审计记录由宿主（writeDoctorAudit）独占写入。
  return { ok: true, dryRun: false, planned, applied, summary };
}
