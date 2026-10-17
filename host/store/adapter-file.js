/**
 * 文件适配器（P2-0）：**只有本文件可以拼 .jkkb/store 的落盘路径**。
 *
 * 布局：<root>/.jkkb/store/<namespace>/<id>.json  +  <namespace>/index.json（id 列表索引）
 * 写入：assertWritableSync（路径守卫）+ writeJsonAtomic（tmp→replaceFile 原子替换）。
 * 业务代码只拿记录（id 是身份），绝不关心路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { assertWritableSync } from '../engine/guard.js';
import { replaceFile } from '../trace.js';

export const STORE_SCHEMA_VERSION = 1;
export const STORE_REL_DIR = path.join('.jkkb', 'store');

const NAMESPACE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isSafeNamespace(value) {
  return typeof value === 'string' && NAMESPACE_PATTERN.test(value);
}

export function isSafeRecordId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function storeDir(root) {
  return path.join(String(root), STORE_REL_DIR);
}

export function namespaceDir(root, namespace) {
  return path.join(storeDir(root), String(namespace));
}

export function recordPath(root, namespace, id) {
  return path.join(namespaceDir(root, namespace), String(id) + '.json');
}

export function indexPath(root, namespace) {
  return path.join(namespaceDir(root, namespace), 'index.json');
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (err) {
    return fallback;
  }
}

/**
 * 仓储自己的原子写：guard（可注入）→ tmp → replaceFile。
 * 不走 trace.writeJsonAtomic，因为那层还有一道针对 .jkkb 白名单的守卫；
 * 仓储的路径约束由本文件的 assertWritable 一处负责。
 */
export function writeStoreJson(root, file, value, assertWritable) {
  const guard = typeof assertWritable === 'function' ? assertWritable : assertWritableSync;
  guard(root, file);
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    const replaced = replaceFile(tmp, file);
    if (!replaced.ok) {
      try { fs.unlinkSync(tmp); } catch (cleanupErr) { /* 可能已被移走 */ }
      const err = new Error('仓储写入失败：' + file + '（' + replaced.message + '）');
      err.code = replaced.code || 'STORE_WRITE_FAILED';
      throw err;
    }
    return true;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (cleanupErr) { /* 忽略 */ }
    throw err;
  }
}

function assertNamespace(namespace) {
  if (!isSafeNamespace(namespace)) {
    const err = new Error('非法命名空间：' + String(namespace));
    err.code = 'INVALID_NAMESPACE';
    throw err;
  }
}

function assertId(id) {
  if (!isSafeRecordId(id)) {
    const err = new Error('非法记录 id：' + String(id));
    err.code = 'INVALID_ID';
    throw err;
  }
}

export function createFileAdapter(options) {
  const opts = options || {};
  const root = opts.root;
  // 路径守卫可注入（默认引擎的 assertWritableSync）。注入只用于测试/迁移期，生产不传。
  const assertWritable = typeof opts.assertWritable === 'function' ? opts.assertWritable : assertWritableSync;
  if (typeof root !== 'string' || !root) {
    const err = new Error('文件适配器需要 root');
    err.code = 'INVALID_ROOT';
    throw err;
  }

  function readIndexFile(namespace) {
    const raw = readJson(indexPath(root, namespace), null);
    const ids = raw && Array.isArray(raw.ids) ? raw.ids.filter(isSafeRecordId) : [];
    return { version: STORE_SCHEMA_VERSION, ids: ids };
  }

  function writeIndexFile(namespace, ids) {
    const file = indexPath(root, namespace);
    writeStoreJson(root, file, { version: STORE_SCHEMA_VERSION, ids: ids, updatedAt: new Date().toISOString() }, assertWritable);
  }

  return {
    root: root,

    /** 返回 id 列表（身份），不是记录；记录请用 readRecord。 */
    listRecords(namespace) {
      assertNamespace(namespace);
      return readIndexFile(namespace).ids;
    },

    readRecord(namespace, id) {
      assertNamespace(namespace);
      assertId(id);
      const record = readJson(recordPath(root, namespace, id), null);
      return record && typeof record === 'object' ? record : null;
    },

    writeRecord(namespace, record) {
      assertNamespace(namespace);
      if (!record || typeof record !== 'object') {
        const err = new Error('记录必须是对象');
        err.code = 'INVALID_RECORD';
        throw err;
      }
      assertId(record.id);
      const file = recordPath(root, namespace, record.id);
      writeStoreJson(root, file, record, assertWritable);
      const current = readIndexFile(namespace).ids.filter((item) => item !== record.id);
      current.push(record.id);
      writeIndexFile(namespace, current);
      return record;
    },

    deleteRecord(namespace, id) {
      assertNamespace(namespace);
      assertId(id);
      const file = recordPath(root, namespace, id);
      assertWritable(root, file);
      try {
        fs.unlinkSync(file);
      } catch (err) {
        if (!err || err.code !== 'ENOENT') throw err;
      }
      const next = readIndexFile(namespace).ids.filter((item) => item !== id);
      writeIndexFile(namespace, next);
      return true;
    },

    /** 当前环境下 .jkkb/store 是否已被引擎守卫放行（用于诊断/迁移）。 */
    guardProbe() {
      try {
        assertWritable(root, path.join(namespaceDir(root, 'skills'), '.guard-probe.json'));
        return { ok: true, code: null, message: '' };
      } catch (err) {
        return { ok: false, code: (err && err.code) || 'UNKNOWN', message: String(err && err.message ? err.message : err) };
      }
    },

    readIndex(namespace) {
      assertNamespace(namespace);
      return readIndexFile(namespace);
    },
  };
}
