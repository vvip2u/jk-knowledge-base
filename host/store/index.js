/**
 * 仓储出口（P2-0）。
 *
 * 命名空间 ↔ 将来的 SQLite 表名（见 docs/storage-migration.md）：
 *   numbers    → numbering   （编号计数器 registry.json）
 *   skills     → skills
 *   skillCalls → skill_calls
 *   cards      → cards
 *   reports    → reports
 *
 * 说明：本批只落地 numbersRepo 与 skillsRepo；skillCalls/cards/reports 也是
 * 真实可用的通用仓储（同一 adapter + repo 工厂），没有空实现、不会谎报成功。
 */
import fs from 'node:fs';
import path from 'node:path';

import { assertWritableSync } from '../engine/guard.js';
import { createFileAdapter, namespaceDir, writeStoreJson, STORE_SCHEMA_VERSION } from './adapter-file.js';
import { createRepo } from './repo.js';

export { createFileAdapter, STORE_SCHEMA_VERSION };

// 编号前缀白名单（与引擎的编号体系一致）。
// 与 host/skills/catalog.js 的 ID_PREFIXES 对齐（DOC 是收件卡的编号前缀）。
// 与 host/skills/catalog.js 的 ID_PREFIXES 对齐（DOC 是收件卡、EXP 是业务专家的编号前缀）。
export const NUMBER_PREFIXES = ['R', 'S', 'H', 'E', 'D', 'K', 'RT', 'P', 'DOC', 'SK', 'EXP'];
export const NUMBER_NAMESPACE = 'numbering';
export const NUMBER_REGISTRY_FILE = 'registry.json';

export const NAMESPACE_MAP = Object.freeze({
  numbers: 'numbering',
  skills: 'skills',
  skillCalls: 'skill_calls',
  cards: 'cards',
  reports: 'reports',
  experts: 'experts',
});

function emptyRegistry() {
  const counters = {};
  NUMBER_PREFIXES.forEach((prefix) => { counters[prefix] = 0; });
  return { schemaVersion: STORE_SCHEMA_VERSION, counters: counters, updatedAt: null };
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (err) {
    return fallback;
  }
}

function normalizeRegistry(raw) {
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== STORE_SCHEMA_VERSION) return null;
  const counters = {};
  NUMBER_PREFIXES.forEach((prefix) => {
    const value = raw.counters && raw.counters[prefix];
    counters[prefix] = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  });
  return { schemaVersion: STORE_SCHEMA_VERSION, counters: counters, updatedAt: raw.updatedAt || null };
}

function registryPath(root) {
  return path.join(namespaceDir(root, NUMBER_NAMESPACE), NUMBER_REGISTRY_FILE);
}

export function readNumberRegistry(root) {
  const parsed = readJson(registryPath(root), null);
  if (parsed && parsed.schemaVersion !== STORE_SCHEMA_VERSION) {
    const err = new Error('不认识的 registry schemaVersion=' + String(parsed.schemaVersion));
    err.code = 'SCHEMA_UNSUPPORTED';
    throw err;
  }
  return normalizeRegistry(parsed) || emptyRegistry();
}

function padNumber(value) {
  return String(value).padStart(3, '0');
}

/**
 * 编号分配器。
 *
 * allocate 的原子性：readNumberRegistry → 计算区间 → writeNumberRegistry 三步之间
 * **没有任何 await / 异步点**（纯同步 fs），因此同一事件循环 tick 内不会被其它请求插队；
 * 跨进程互斥由调用方持有的 run 锁（.jkkb/lock.json）保证 —— 见 allocateInLock。
 */
function allocate(root, prefix, count, assertWritable) {
  const key = String(prefix || '');
  if (NUMBER_PREFIXES.indexOf(key) < 0) {
    const err = new Error('未知编号前缀：' + key + '（允许：' + NUMBER_PREFIXES.join('/') + '）');
    err.code = 'INVALID_PREFIX';
    throw err;
  }
  const amount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;

  const registry = readNumberRegistry(root);
  const start = (registry.counters[key] || 0) + 1;
  const end = start + amount - 1;
  registry.counters[key] = end;
  registry.updatedAt = new Date().toISOString();

  const file = registryPath(root);
  writeStoreJson(root, file, registry, assertWritable);
  const ids = [];
  for (let value = start; value <= end; value += 1) ids.push(key + padNumber(value));
  return { start: start, end: end, ids: ids };
}

export function createRepos(options) {
  const opts = options || {};
  const root = opts.root;
  if (typeof root !== 'string' || !root) {
    const err = new Error('createRepos 需要 root');
    err.code = 'INVALID_ROOT';
    throw err;
  }
  const assertWritable = typeof opts.assertWritable === 'function' ? opts.assertWritable : null;
  const adapter = opts.adapter || createFileAdapter({ root: root, assertWritable: assertWritable || undefined });

  const numbersRepo = {
    namespace: NUMBER_NAMESPACE,
    /** 必须在调用方持有 run 锁时使用；见 allocateInLock。 */
    allocate(prefix, count) {
      return allocate(root, prefix, count, assertWritable);
    },
    /**
     * 便捷封装：要求传入一个非空锁对象（trace.readLock 的返回值或 { runId }），
     * 没有锁就直接拒绝，避免误用。
     */
    allocateInLock(lock, prefix, count) {
      if (!lock || typeof lock !== 'object' || typeof lock.runId !== 'string' || !lock.runId) {
        const err = new Error('allocateInLock 需要有效的 run 锁（{runId}）');
        err.code = 'LOCK_REQUIRED';
        throw err;
      }
      return allocate(root, prefix, count, assertWritable);
    },
    registryRoot: namespaceDir(root, NUMBER_NAMESPACE),
    RegistryFile: NUMBER_REGISTRY_FILE,
  };

  const skillsRepo = createRepo({ namespace: NAMESPACE_MAP.skills, adapter: adapter, idPrefix: 'SK' });

  // 真实可用的通用仓储（本批未接线，但可正常 CRUD）。
  const skillCallsRepo = createRepo({ namespace: NAMESPACE_MAP.skillCalls, adapter: adapter, idPrefix: 'CALL' });
  const cardsRepo = createRepo({ namespace: NAMESPACE_MAP.cards, adapter: adapter, idPrefix: 'CARD' });
  const reportsRepo = createRepo({ namespace: NAMESPACE_MAP.reports, adapter: adapter, idPrefix: 'RPT' });
  const expertsRepo = createRepo({ namespace: NAMESPACE_MAP.experts, adapter: adapter, idPrefix: 'EXP' });

  return {
    adapter: adapter,
    numbersRepo: numbersRepo,
    skillsRepo: skillsRepo,
    skillCallsRepo: skillCallsRepo,
    cardsRepo: cardsRepo,
    reportsRepo: reportsRepo,
    expertsRepo: expertsRepo,
  };
}
