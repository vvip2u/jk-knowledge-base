/**
 * 断点checkpoint（S4）。
 *
 * 文件：<root>/.jkkb/runs/<runId>/checkpoint.json
 *   { engineVersion, schemaVersion, lastStepKey, completedSteps:[{ key, at, artifacts:[{ path, size, mtimeMs }] }] }
 *
 * 约定：
 * - path 一律绝对路径；size/mtimeMs 取不到写 null（表示"记录过但当时/现在不存在"）。
 * - 写入只能落在 .jkkb/runs/<runId>/checkpoint.json，且每次写前过路径守卫 + 原子替换。
 * - 指纹由引擎的 fingerprintArtifacts 提供（单一真源），本模块不自己 stat。
 */
import fs from 'node:fs';
import path from 'node:path';

import { ENGINE_VERSION } from './engine/index.js';
import * as engine from './engine/index.js';
import { assertWritableSync } from './engine/guard.js';
import { isSafeRunId, writeJsonAtomic } from './trace.js';

export const CHECKPOINT_SCHEMA_VERSION = 1;
export const RESUMABLE_STATUSES = ['failed', 'cancelled', 'stalled', 'timed_out'];
export const FRESH_HEARTBEAT_MS = 120 * 1000;

export function checkpointPath(root, runId) {
  return path.join(String(root), '.jkkb', 'runs', String(runId), 'checkpoint.json');
}

/** 结构校验：形状不对返回 null（调用方按"缺 checkpoint"处理）。 */
export function validateCheckpoint(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const engineVersion = typeof raw.engineVersion === 'string' && raw.engineVersion ? raw.engineVersion : null;
  const schemaVersion = Number.isFinite(raw.schemaVersion) ? raw.schemaVersion : null;
  if (!engineVersion || schemaVersion === null) return null;
  const completedSteps = Array.isArray(raw.completedSteps)
    ? raw.completedSteps
      .filter((item) => item && typeof item === 'object' && typeof item.key === 'string' && item.key)
      .map((item) => ({
        key: item.key,
        at: typeof item.at === 'string' ? item.at : '',
        artifacts: Array.isArray(item.artifacts)
          ? item.artifacts
            .filter((a) => a && typeof a === 'object' && typeof a.path === 'string' && a.path)
            .map((a) => ({
              path: a.path,
              size: Number.isFinite(a.size) ? a.size : null,
              mtimeMs: Number.isFinite(a.mtimeMs) ? a.mtimeMs : null,
            }))
          : [],
      }))
    : [];
  return {
    engineVersion: engineVersion,
    schemaVersion: schemaVersion,
    lastStepKey: typeof raw.lastStepKey === 'string' ? raw.lastStepKey : null,
    completedSteps: completedSteps,
  };
}

export function readCheckpoint(root, runId) {
  if (!root || !isSafeRunId(runId)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(checkpointPath(root, runId), 'utf8'));
    return validateCheckpoint(parsed);
  } catch (err) {
    return null;
  }
}

export async function writeCheckpoint(root, runId, checkpoint) {
  const normalized = validateCheckpoint(checkpoint);
  if (!normalized) {
    const err = new Error('checkpoint 结构非法');
    err.code = 'CHECKPOINT_INVALID';
    throw err;
  }
  const file = checkpointPath(root, runId);
  // 只允许写 checkpoint.json：路径守卫的 .jkkb 白名单之外，这里再钉死一次文件名。
  if (path.basename(file) !== 'checkpoint.json') {
    const err = new Error('checkpoint 只能写 checkpoint.json：' + file);
    err.code = 'PATH_DENIED';
    throw err;
  }
  assertWritableSync(root, file);
  if (!writeJsonAtomic(file, normalized, root)) {
    const err = new Error('checkpoint 写入失败：' + file);
    err.code = 'CHECKPOINT_WRITE_FAILED';
    throw err;
  }
  return normalized;
}

/** 记录一个步骤完成的产物指纹（幂等：同 key 覆盖）。 */
export async function recordStep(args) {
  const a = args || {};
  const root = a.root;
  const runId = a.runId;
  const key = typeof a.key === 'string' ? a.key : '';
  if (!root || !isSafeRunId(runId) || !key) return null;

  const current = readCheckpoint(root, runId) || {
    engineVersion: ENGINE_VERSION,
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    lastStepKey: null,
    completedSteps: [],
  };
  const paths = Array.isArray(a.artifacts) ? a.artifacts.filter((item) => typeof item === 'string' && item) : [];
  let artifacts = [];
  if (paths.length > 0) {
    const fingerprint = engine && typeof engine.fingerprintArtifacts === 'function' ? engine.fingerprintArtifacts : null;
    artifacts = fingerprint ? await fingerprint(paths) : paths.map((item) => ({ path: path.resolve(item), size: null, mtimeMs: null }));
  }
  const at = new Date(typeof a.now === 'number' ? a.now : Date.now()).toISOString();
  const step = { key: key, at: at, artifacts: artifacts };
  const completedSteps = current.completedSteps.filter((item) => item.key !== key).concat([step]);
  return writeCheckpoint(root, runId, {
    engineVersion: current.engineVersion || ENGINE_VERSION,
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    lastStepKey: key,
    completedSteps: completedSteps,
  });
}

function defaultStat(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch (err) {
    return null;
  }
}

/**
 * 恢复决策（纯函数）：6 条规则按优先级从上到下。
 * @returns {{action:'noop'|'resume'|'restart'|'abandon'|'needs-human', reason:string, conflicts:Array}}
 */
export function decideRecovery(args) {
  const a = args || {};
  const run = a.run || null;
  const checkpoint = a.checkpoint || null;
  const nowMs = typeof a.now === 'number' ? a.now : Date.now();
  const engineVersion = typeof a.engineVersion === 'string' ? a.engineVersion : ENGINE_VERSION;
  const statFile = typeof a.statFile === 'function' ? a.statFile : defaultStat;

  // 1) 已完成且验收没被判失败
  if (run && run.status === 'completed' && (!run.acceptance || run.acceptance.ok !== false)) {
    return { action: 'noop', reason: 'run 已完成且验收通过，无需恢复', conflicts: [] };
  }

  // 2) checkpoint 缺失 / 引擎版本不一致
  if (!checkpoint) {
    return { action: 'abandon', reason: '缺少 checkpoint.json（没有可恢复的断点）', conflicts: [] };
  }
  if (checkpoint.engineVersion !== engineVersion) {
    return {
      action: 'abandon',
      reason: '引擎版本不一致（checkpoint=' + checkpoint.engineVersion + '，当前=' + engineVersion + '）',
      conflicts: [],
    };
  }

  // 3) 产物冲突：当前存在但 size / mtimeMs 与记录不符
  const conflicts = [];
  checkpoint.completedSteps.forEach((step) => {
    step.artifacts.forEach((artifact) => {
      const actual = statFile(artifact.path);
      if (!actual) return; // 文件已不存在 → 不算冲突（可被重建）
      const sizeDiff = artifact.size !== null && actual.size !== artifact.size;
      const mtimeDiff = artifact.mtimeMs !== null && Math.abs(actual.mtimeMs - artifact.mtimeMs) > 1;
      if (sizeDiff || mtimeDiff) {
        conflicts.push({
          path: artifact.path,
          expected: { size: artifact.size, mtimeMs: artifact.mtimeMs },
          actual: { size: actual.size, mtimeMs: actual.mtimeMs },
        });
      }
    });
  });
  if (conflicts.length > 0) {
    return { action: 'needs-human', reason: '产物已被修改（' + conflicts.length + ' 处冲突），需人工确认', conflicts: conflicts };
  }

  // 4) 仍在运行且心跳新鲜
  if (run && run.status === 'running') {
    const hb = Date.parse(run.heartbeatAt || run.startedAt || '');
    const age = Number.isFinite(hb) ? nowMs - hb : null;
    if (age !== null && age <= FRESH_HEARTBEAT_MS) {
      return { action: 'needs-human', reason: 'run 仍在运行（心跳 ' + Math.round(age / 1000) + 's 前），避免双写', conflicts: [] };
    }
  }

  // 5) 中断态且无冲突 → 续跑
  if (run && RESUMABLE_STATUSES.indexOf(run.status) >= 0) {
    return { action: 'resume', reason: '上次运行中断（' + run.status + '），可续跑', conflicts: [] };
  }

  // 6) 其余 → 重跑
  return {
    action: 'restart',
    reason: run ? '状态不支持续跑（' + run.status + '），建议重启' : 'run.json 缺失，建议重启',
    conflicts: [],
  };
}
