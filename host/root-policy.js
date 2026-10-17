/**
 * 根目录校验与风险模型（host 半，纯函数 + 可注入 fs）。
 *
 * 返回 { ok, level: 'ok'|'warn'|'reject', reasons:[{code,level,message}], normalized }。
 * - reject：绝不能当知识库根目录（系统目录、home 本身、~/.dsh、敏感段、文件、不存在、相对路径）；
 * - warn：可以写但必须让用户确认风险（用户目录下的 Downloads/Desktop/Documents、外接卷、非空目录）；
 * - ok：其余已存在的普通目录。
 *
 * 依赖可注入（homedir / realpathSync / statSync / readdirSync），便于用假文件系统做单测；
 * 不传时用真实 fs。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getMode, projectDirs } from './engine/presets.js';

// vault 元数据目录名（<root>/.jkkb/vault.json 由引擎落地）。
export const VAULT_DIR_NAME = '.jkkb';

// 顶层目录的**唯一真源是引擎的目录预设**（assets/engine/directory-presets.json）。
// 本文件不复制任何目录名：需要时向 presets 投影要。
const dirsCache = new Map();

export async function getTopLevelDirs(mode) {
  const key = mode === 'topic' ? 'topic' : 'asset';
  if (dirsCache.has(key)) return dirsCache.get(key);
  const cfg = await getMode(key);
  const dirs = projectDirs(cfg.core).map((item) => item.name);
  dirsCache.set(key, dirs);
  return dirs;
}

const WARN_HOME_DIRS = [
  { name: 'Documents', code: 'warn-documents', message: '位于用户 Documents 目录：会被写入知识库结构，建议先备份' },
  { name: 'Desktop', code: 'warn-desktop', message: '位于用户桌面：桌面文件多且杂，建议换一个专用目录' },
  { name: 'Downloads', code: 'warn-downloads', message: '位于用户下载目录：清理/重装时容易误删，建议换一个专用目录' },
];

/**
 * 平台化的路径比较器：
 * - 包含判定一律 path.relative（禁止字符串前缀比较）；
 * - win32 / darwin 比较前折叠大小写（linux 不折叠）；
 * - win32 用 path.win32，其余用 path.posix，便于在 darwin 上单测 win32 分支。
 */
/**
 * win32 长路径前缀剥离（只在判定时归一，不改用户传入的原始值）：
 * `\\?\UNC\server\share` → `\\server\share`；`\\?\C:\x` → `C:\x`。
 * 归一化只在这一处，避免黑名单被 `\\?\` 绕过。
 */
export function stripWin32LongPrefix(value) {
  let text = String(value === null || value === undefined ? '' : value);
  if (/^\\\\\?\\UNC\\/i.test(text)) return '\\\\' + text.slice(8);
  if (/^\\\\\?\\/.test(text)) return text.slice(4);
  return text;
}

export function makePathCompare(platform) {
  const osName = platform || process.platform;
  const api = osName === 'win32' ? path.win32 : path.posix;
  const fold = osName !== 'linux';
  const normalize = (value) => {
    const text = osName === 'win32' ? stripWin32LongPrefix(value) : String(value === null || value === undefined ? '' : value);
    const normalized = api.normalize(text);
    return fold ? normalized.toLowerCase() : normalized;
  };
  return {
    platform: osName,
    api: api,
    normalize: normalize,
    equal(a, b) {
      return normalize(a) === normalize(b);
    },
    inside(parent, target) {
      const rel = api.relative(normalize(parent), normalize(target));
      if (rel === '') return true;
      return rel !== '..' && rel.indexOf('..' + api.sep) !== 0 && !api.isAbsolute(rel);
    },
  };
}

/** win32 的 UNC（网络共享）判定：先剥长路径前缀，再看盘符根是否以双反斜杠开头。 */
export function isUncPath(value, platform) {
  const osName = platform || process.platform;
  if (osName !== 'win32') return false;
  const stripped = stripWin32LongPrefix(value);
  return /^\\\\/.test(path.win32.parse(stripped).root);
}

/** 同一路径判定（供测试 / 上层判重用）。 */
export function samePath(a, b, platform) {
  return makePathCompare(platform).equal(a, b);
}

function envOf(options) {
  const raw = options && options.env;
  return raw && typeof raw === 'object' ? raw : process.env;
}

function envPath(env, key) {
  const value = env && env[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * 按平台构造保留区（绝对路径集合）：
 * - win32：系统盘根、SystemRoot、Program Files(x86 存在才加)、ProgramData、
 *          APPDATA\Microsoft\Crypto、用户目录本身及其上级父目录；
 * - linux：/usr /etc /bin /sbin /boot /proc /sys /dev /var/lib 等；
 * - darwin：现有 POSIX 清单（/var、/private/var 只拒绝精确值，避免误伤 os.tmpdir()）。
 */
export function reservedFor(platform, home, options) {
  const cmp = makePathCompare(platform);
  const api = cmp.api;
  const env = envOf(options);
  const items = [];

  if (cmp.platform === 'win32') {
    const driveRoot = api.parse(String(home)).root || 'C:\\';
    items.push({ p: driveRoot, exact: true });
    items.push({ p: envPath(env, 'SystemRoot') || envPath(env, 'WINDIR') || api.join(driveRoot, 'Windows') });
    items.push({ p: envPath(env, 'ProgramFiles') || api.join(driveRoot, 'Program Files') });
    const pf86 = envPath(env, 'ProgramFiles(x86)');
    if (pf86) items.push({ p: pf86 });
    items.push({ p: envPath(env, 'ProgramData') || api.join(driveRoot, 'ProgramData') });
    const appData = envPath(env, 'APPDATA') || api.join(home, 'AppData', 'Roaming');
    items.push({ p: api.join(appData, 'Microsoft', 'Crypto') });
    // home 本身由 root-is-home 专门判定；这里只补「上级父目录」。
    const parent = api.dirname(String(home));
    if (parent && parent !== home && parent !== driveRoot) items.push({ p: parent, exact: true });
    return items;
  }

  if (cmp.platform === 'linux') {
    ['/usr', '/etc', '/bin', '/sbin', '/boot', '/proc', '/sys', '/dev', '/var/lib', '/var/run', '/lib', '/lib64']
      .forEach((item) => items.push({ p: item }));
    items.push({ p: '/', exact: true });
    return items;
  }

  // darwin
  ['/System', '/Applications', '/Library', '/usr', '/etc', '/private/etc', '/bin', '/sbin', '/dev', '/cores']
    .forEach((item) => items.push({ p: item }));
  items.push({ p: '/', exact: true });
  items.push({ p: '/var', exact: true });
  items.push({ p: '/private/var', exact: true });
  return items;
}

/** 敏感段（按平台）：win32 额外把 Crypto / System32 当敏感段。 */
export function sensitiveSegmentsFor(platform) {
  const base = ['.ssh', '.gnupg', '.aws', '.netrc', '.password-store'];
  if ((platform || process.platform) === 'win32') return base.concat(['Crypto', 'System32']);
  return base;
}

function reason(code, level, message) {
  return { code: code, level: level, message: message };
}

function fail(code, message, normalized) {
  return {
    ok: false,
    level: 'reject',
    reasons: [reason(code, 'reject', message)],
    normalized: typeof normalized === 'string' ? normalized : '',
  };
}

function errText(err) {
  const code = err && err.code ? String(err.code) : '';
  const message = err && err.message ? String(err.message) : '未知错误';
  return code && message.indexOf(code) !== 0 ? code + ': ' + message : message;
}

function pick(options, key, fallback) {
  if (!options) return fallback;
  const value = options[key];
  if (typeof value === 'function') return value;
  return fallback;
}

export function evaluateRoot(input, options) {
  const opts = options || {};
  const platform = typeof opts.platform === 'string' && opts.platform ? opts.platform : process.platform;
  const cmp = makePathCompare(platform);
  const api = cmp.api;
  const env = envOf(opts);
  const homedirFn = typeof opts.homedir === 'function' ? opts.homedir : (() => os.homedir());
  const homedir = String(typeof opts.homedir === 'string' ? opts.homedir : homedirFn());
  const realpathSync = pick(opts, 'realpathSync', fs.realpathSync);
  const statSync = pick(opts, 'statSync', fs.statSync);
  const readdirSync = pick(opts, 'readdirSync', fs.readdirSync);

  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return fail('root-empty', '请填写知识库根目录的绝对路径', '');

  // ~ 展开同时接受 ~/ 与 ~\（Windows 风格）。
  let expanded = raw;
  if (raw === '~') {
    expanded = homedir;
  } else if (raw.length >= 2 && raw[0] === '~' && (raw[1] === '/' || raw[1] === '\\')) {
    const rest = raw.slice(2).replace(/[\\/]+/g, api.sep);
    expanded = api.join(homedir, rest);
  }

  if (!api.isAbsolute(expanded)) {
    return fail('root-relative', '必须是绝对路径（以 / 或盘符\ 开头，或 ~/ 与 ~\\ 开头的用户目录）', expanded);
  }

  let normalized = expanded;
  try {
    normalized = String(realpathSync(expanded));
  } catch (err) {
    if (err && err.code === 'ENOENT') return fail('root-missing', '目录不存在：' + expanded, expanded);
    return fail('root-unresolvable', '无法解析该路径（' + errText(err) + '）', expanded);
  }

  let stat = null;
  try {
    stat = statSync(normalized);
  } catch (err) {
    return fail('root-unreadable', '无法读取该路径（' + errText(err) + '）', normalized);
  }
  if (!stat || typeof stat.isDirectory !== 'function' || !stat.isDirectory()) {
    return fail('root-not-directory', '该路径不是目录（可能是一个文件）', normalized);
  }

  let home = homedir;
  try { home = String(realpathSync(homedir)); } catch (err) { /* home 解析失败就用原值 */ }

  // 保留区（按平台构造；包含判定走 path.relative）。
  const reservedHit = reservedFor(platform, home, opts).filter((item) => (
    item.exact ? cmp.equal(item.p, normalized) : cmp.inside(item.p, normalized)
  ))[0];
  if (reservedHit) {
    return fail('root-system', '不允许把系统 / 保留目录当作知识库根目录：' + normalized, normalized);
  }
  if (cmp.equal(normalized, home)) {
    return fail('root-is-home', '不允许直接用用户主目录当作知识库根目录，请在其下新建专用目录', normalized);
  }

  const dshHome = api.join(home, '.dsh');
  if (cmp.inside(dshHome, normalized)) {
    return fail('root-dsh', '不允许写入 DSH 自身的 ~/.dsh 目录（会破坏宿主数据）', normalized);
  }

  const foldSegment = (value) => (platform === 'linux' ? String(value) : String(value).toLowerCase());
  const sensitive = sensitiveSegmentsFor(platform).map(foldSegment);
  const segments = cmp.normalize(normalized).split(api.sep).filter(Boolean);
  const keychains = platform === 'darwin' && cmp.inside(api.join(home, 'Library', 'Keychains'), normalized);
  if (segments.some((segment) => sensitive.indexOf(segment) >= 0) || keychains) {
    return fail('root-sensitive', '路径包含敏感段（.ssh / .gnupg / .aws / Keychains / Crypto / System32 等），不允许写入', normalized);
  }

  // 允许但需要确认的类别。
  const reasons = [];
  WARN_HOME_DIRS.forEach((item) => {
    const dir = api.join(home, item.name);
    if (cmp.equal(normalized, dir) || cmp.inside(dir, normalized)) reasons.push(reason(item.code, 'warn', item.message));
  });
  if (isUncPath(normalized, platform)) {
    reasons.push(reason(
      'root-network-share',
      'warn',
      '位于网络共享（UNC）路径：写入走网络、延迟与断连不可控；无法校验剩余空间；请确认该共享已挂载且当前账号有写权限'
    ));
  }
  if (platform === 'darwin' && (cmp.equal(normalized, '/Volumes') || cmp.inside('/Volumes', normalized))) {
    reasons.push(reason('warn-external-volume', 'warn', '位于 /Volumes 下的外接卷：卷未挂载时数据不可见，且可能被格式化'));
  }

  let entries = null;
  try { entries = readdirSync(normalized); } catch (err) { entries = null; }
  if (Array.isArray(entries) && entries.length > 0) {
    reasons.push(reason('warn-non-empty', 'warn', '目录非空（现有 ' + entries.length + ' 项）：知识库只会新增若干顶层目录，不会删除已有内容'));
  }

  const level = reasons.some((item) => item.level === 'reject')
    ? 'reject'
    : (reasons.length > 0 ? 'warn' : 'ok');

  return { ok: level !== 'reject', level: level, reasons: reasons, normalized: normalized };
}

export function hasVault(root, options) {
  if (typeof root !== 'string' || !root) return false;
  const opts = options || {};
  const existsSync = pick(opts, 'existsSync', fs.existsSync);
  try {
    return existsSync(path.join(root, VAULT_DIR_NAME, 'vault.json')) === true;
  } catch (err) {
    return false;
  }
}
