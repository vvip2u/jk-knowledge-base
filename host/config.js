/**
 * 插件级设置（host 半）—— 落在 ~/.dsh/plugin-data/jk-knowledge-base/settings.json。
 *
 * 只用 node 标准库；任何读失败 / 坏 JSON 一律回落默认值，绝不把坏数据抛给调用方。
 * 写盘是原子的：先写同目录 tmp 文件，再 rename 覆盖，避免半截文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const PLUGIN_ID = 'jk-knowledge-base';
export const PLUGIN_VERSION = '1.0.0';
export const SETTINGS_FILE_NAME = 'settings.json';

// 风险确认记录：版本号 + 确认文本哈希，二者一起证明"用户确实看过这一版提示"。
export const RISK_ACK_VERSION = 1;
export const RISK_ACK_TEXT = '我已了解风险并授权写入该目录';

export function pluginDataDir(home) {
  return path.join(home || os.homedir(), '.dsh', 'plugin-data', PLUGIN_ID);
}

export function settingsPath(home) {
  return path.join(pluginDataDir(home), SETTINGS_FILE_NAME);
}

export function defaultSettings() {
  return { root: null, rootConfirmedAt: null, rootRiskAck: null, updatedAt: null };
}

export function hashAckText(text) {
  return crypto.createHash('sha256').update(String(text == null ? RISK_ACK_TEXT : text)).digest('hex');
}

function isIsoString(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const at = Date.parse(value);
  return Number.isFinite(at);
}

/**
 * 归一化设置。root 与风险确认记录必须成对存在：只有 root 而没有任何确认记录时视为
 * "未配置"，防止手改 settings.json 绕过风险确认。
 */
export function normalizeSettings(raw) {
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;

  const updatedAt = isIsoString(raw.updatedAt) ? raw.updatedAt : null;
  const root = typeof raw.root === 'string' && raw.root.trim().length > 0 ? raw.root.trim() : null;
  const rootConfirmedAt = isIsoString(raw.rootConfirmedAt) ? raw.rootConfirmedAt : null;
  const ack = raw.rootRiskAck && typeof raw.rootRiskAck === 'object' && !Array.isArray(raw.rootRiskAck) ? raw.rootRiskAck : null;
  const ackAt = ack && isIsoString(ack.at) ? ack.at : null;
  const rootRiskAck = ack && ackAt
    ? {
        at: ackAt,
        version: typeof ack.version === 'number' && Number.isFinite(ack.version) ? ack.version : RISK_ACK_VERSION,
        textHash: typeof ack.textHash === 'string' && ack.textHash.length > 0 ? ack.textHash : hashAckText(RISK_ACK_TEXT),
      }
    : null;

  if (!root || !rootConfirmedAt || !rootRiskAck) return Object.assign({}, base, { updatedAt });
  return { root, rootConfirmedAt, rootRiskAck, updatedAt };
}

export function readSettings(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return normalizeSettings(JSON.parse(text));
  } catch (err) {
    // ENOENT / 坏 JSON / 权限问题都走同一条降级路径。
    return defaultSettings();
  }
}

/** 把 errno 变成可读文案：EACCES: permission denied，等。 */
export function describeErrno(err) {
  const code = err && err.code ? String(err.code) : '';
  const raw = err && err.message ? String(err.message) : '未知错误';
  if (!code) return raw;
  if (raw.indexOf(code) === 0) return raw;
  return code + ': ' + raw;
}

export function writeSettingsAtomic(file, settings, io) {
  const fsi = io || fs;
  const next = normalizeSettings(settings);
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.' + SETTINGS_FILE_NAME + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp');
  try {
    fsi.mkdirSync(dir, { recursive: true });
    fsi.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fsi.renameSync(tmp, file);
    return { ok: true, settings: next, error: null };
  } catch (err) {
    try { fsi.unlinkSync(tmp); } catch (cleanupErr) { /* tmp 可能根本没建出来 */ }
    return { ok: false, settings: null, error: { code: (err && err.code) || 'write-failed', message: describeErrno(err) } };
  }
}

export function createSettingsStore(options) {
  const opts = options || {};
  const file = opts.file || settingsPath(opts.home);
  let cache = null;
  return {
    file,
    get() {
      if (!cache) cache = readSettings(file);
      return cache;
    },
    reload() {
      cache = readSettings(file);
      return cache;
    },
    save(next) {
      const result = writeSettingsAtomic(file, next, opts.io);
      if (result.ok) cache = result.settings;
      return result;
    },
  };
}
