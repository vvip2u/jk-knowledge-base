/**
 * 通用仓储工厂（P2-0）。
 *
 * 约定：
 * - 记录身份是 id，path 只是普通字段；文件移动不改变 id。
 * - 每次写自动补 schemaVersion / id / createdAt / updatedAt。
 * - 读到不认识的 schemaVersion 必须抛 SCHEMA_UNSUPPORTED，绝不静默丢弃。
 * - 本层不碰文件系统（只调 adapter），便于将来换成 SQLite 适配器。
 */
import crypto from 'node:crypto';

export const REPO_SCHEMA_VERSION = 1;

const MANAGED_FIELDS = ['schemaVersion', 'id', 'createdAt', 'updatedAt'];

function errorWith(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function generateId(prefix) {
  return String(prefix || 'rec') + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

function stripManaged(data) {
  const out = {};
  Object.keys(data || {}).forEach((key) => {
    if (MANAGED_FIELDS.indexOf(key) >= 0) return;
    out[key] = data[key];
  });
  return out;
}

export function createRepo(options) {
  const opts = options || {};
  const namespace = opts.namespace;
  const adapter = opts.adapter;
  const idPrefix = typeof opts.idPrefix === 'string' && opts.idPrefix ? opts.idPrefix : 'rec';

  if (!adapter || typeof adapter.listRecords !== 'function' || typeof adapter.readRecord !== 'function'
    || typeof adapter.writeRecord !== 'function' || typeof adapter.deleteRecord !== 'function') {
    throw errorWith('INVALID_ADAPTER', 'adapter 必须实现 listRecords/readRecord/writeRecord/deleteRecord');
  }

  function assertSupported(record) {
    if (!record || typeof record !== 'object') return null;
    if (record.schemaVersion !== REPO_SCHEMA_VERSION) {
      throw errorWith(
        'SCHEMA_UNSUPPORTED',
        '不认识的 schemaVersion=' + String(record.schemaVersion) + '（当前 ' + REPO_SCHEMA_VERSION + '，id=' + String(record.id) + '）'
      );
    }
    return record;
  }

  function readOrThrow(id) {
    const record = adapter.readRecord(namespace, id);
    if (!record) return null;
    return assertSupported(record);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  return {
    namespace: namespace,
    idPrefix: idPrefix,

    list() {
      const ids = adapter.listRecords(namespace);
      const out = [];
      ids.forEach((id) => {
        const record = readOrThrow(id);
        if (record) out.push(record);
      });
      return out;
    },

    get(id) {
      return readOrThrow(id);
    },

    create(data) {
      const input = data || {};
      const id = typeof input.id === 'string' && input.id ? input.id : generateId(idPrefix);
      if (adapter.readRecord(namespace, id)) {
        throw errorWith('CONFLICT', '记录已存在：' + namespace + '/' + id);
      }
      const now = nowIso();
      const record = Object.assign({}, stripManaged(input), {
        schemaVersion: REPO_SCHEMA_VERSION,
        id: id,
        createdAt: now,
        updatedAt: now,
      });
      adapter.writeRecord(namespace, record);
      return record;
    },

    update(id, data) {
      const current = readOrThrow(id);
      if (!current) throw errorWith('NOT_FOUND', '记录不存在：' + namespace + '/' + id);
      const next = Object.assign({}, stripManaged(data), {
        schemaVersion: REPO_SCHEMA_VERSION,
        id: id,
        createdAt: current.createdAt,
        updatedAt: nowIso(),
      });
      adapter.writeRecord(namespace, next);
      return next;
    },

    patch(id, partial) {
      const current = readOrThrow(id);
      if (!current) throw errorWith('NOT_FOUND', '记录不存在：' + namespace + '/' + id);
      const next = Object.assign({}, current, stripManaged(partial), {
        schemaVersion: REPO_SCHEMA_VERSION,
        id: id,
        createdAt: current.createdAt,
        updatedAt: nowIso(),
      });
      adapter.writeRecord(namespace, next);
      return next;
    },

    remove(id) {
      const current = readOrThrow(id);
      if (!current) return false;
      adapter.deleteRecord(namespace, id);
      return true;
    },
  };
}
