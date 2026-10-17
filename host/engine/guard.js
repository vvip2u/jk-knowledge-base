/**
 * 引擎侧路径守卫（S1.2 · 跨平台）。
 *
 * 两道闸：
 * 1. authorizeRoot(root)：root 必须是已存在的绝对目录，落在保留区外；返回 {root, realpath}。
 * 2. assertWritable / assertWritableSync(root, target)：每次写盘前调用，同步与异步共用同一份
 *    纯判定（judgeRootFacts / judgeWritableTarget），只有取事实的 I/O 分别用 fs 与 fs.*Sync。
 *
 * 跨平台规则：
 * - 包含判定一律 path.relative 语义（win32 比较前 toLowerCase），禁止字符串前缀比较；
 * - realpath 归一化：win32 去掉 \\?\ 前缀、统一分隔符；darwin 的 /private 前缀交给 realpath 本身；
 * - 保留区按平台展开（win32 额外覆盖系统盘根、Windows、Program Files 等）；
 * - 失败抛 EngineError(PATH_ESCAPE | PATH_DENIED)。
 */
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EngineError, CODES } from './errors.js';

export const PATH_GUARD_VERSION = 1;
export const PATH_ERROR_CODES = Object.freeze([CODES.PATH_ESCAPE, CODES.PATH_DENIED]);

/**
 * root/.jkkb 下只允许这些条目（目录按第一段判定）。
 * store 是宿主仓储层（host/store）的落点，已按契约放行；
 * 其下再按 namespace 白名单校验，见 STORE_NAMESPACES。
 */
const JKKB_ALLOWED = new Set(['runs', 'backup', 'store', 'quarantine', 'doctor', 'vault.json', 'lock.json', 'degraded.txt', 'DEGRADED.txt'].map((s) => s.toLowerCase()));

/** .jkkb/store/<namespace>/... 只接受这些 namespace（与 host/store 的仓储一一对应）。 */
const STORE_NAMESPACES = new Set(['numbering', 'skills', 'skill_calls', 'cards', 'reports', 'experts'].map((s) => s.toLowerCase()));

export function platformPath(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path;
}

/**
 * realpath 归一化：win32 去掉 \\?\ / \\?\UNC\ 前缀并统一分隔符后再 resolve；
 * darwin 的 /private 前缀由 realpath 自身解决，这里不额外拼字符串。
 */
export function normalizeRealPath(p, platform = process.platform) {
  let out = String(p == null ? '' : p);
  if (platform === 'win32') {
    out = out.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
    out = out.replace(/\//g, '\\');
  }
  return platformPath(platform).resolve(out);
}

/** 大小写归一：win32 / darwin 不区分大小写（保留区与判重用），Linux 原样。 */
export function foldPath(p, platform = process.platform) {
  const norm = normalizeRealPath(p, platform);
  return platform === 'linux' ? norm : norm.toLowerCase();
}

/**
 * 包含判定：resolve 归一后 path.relative，结果不以 .. 开头且不是绝对路径。
 * 禁止字符串前缀比较——root=/a/b 时 /a/bc 必须判为外部。
 */
export function isPathInside(parent, child, platform = process.platform) {
  const P = platformPath(platform);
  let a = normalizeRealPath(parent, platform);
  let b = normalizeRealPath(child, platform);
  if (platform === 'win32') {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  const rel = P.relative(a, b);
  return rel === '' || (!rel.startsWith('..') && !P.isAbsolute(rel));
}

/** 保留区：'/' 只做精确匹配，其余按子树判定；win32 额外覆盖系统目录。 */
export function reservedAreas(platform = process.platform) {
  const P = platformPath(platform);
  const home = normalizeRealPath(os.homedir(), platform);
  const areas = [
    { p: '/', exact: true },
    { p: '/System' },
    { p: '/Library' },
    { p: '/Applications' },
    { p: home, exact: true },
    { p: P.dirname(home), exact: true }, // /Users、C:\Users、/home 这类 home 的父目录
    { p: P.join(home, '.dsh') },
    { p: P.join(home, '.ssh') },
    { p: P.join(home, '.gnupg') },
    { p: P.join(home, 'Library', 'Keychains') },
  ];
  if (platform === 'win32') {
    const drive = P.parse(home).root || 'C:\\';
    areas.push(
      { p: process.env.SystemRoot || P.join(drive, 'Windows') },
      { p: P.join(drive, 'Program Files') },
      { p: P.join(drive, 'Program Files (x86)') },
      { p: P.join(drive, 'ProgramData') },
      { p: drive, exact: true },
    );
  }
  return areas;
}

export function isReserved(target, platform = process.platform) {
  const key = foldPath(target, platform);
  return reservedAreas(platform).some(({ p, exact }) => {
    const pk = foldPath(p, platform);
    return exact ? key === pk : key === pk || isPathInside(pk, key, platform);
  });
}

/** 判重键：win32/darwin 用 toLowerCase，Linux 原样。 */
export function pathKey(p, platform = process.platform) {
  return foldPath(p, platform);
}

// ---------------------------------------------------------------- 纯判定（无 I/O）
// 同步 / 异步入口都把 I/O 收集成下列事实，再交给同一组纯函数判定，避免逻辑分叉。

function judgeRootFacts(abs, real, platform) {
  if (isReserved(abs, platform) || isReserved(real, platform)) {
    throw new EngineError(CODES.PATH_DENIED, `拒绝把保留区当作知识库根目录：${abs}`);
  }
}

function judgeWritableTarget({ absTarget, realRoot, effective, symlinks, platform }) {
  if (isReserved(absTarget, platform)) {
    throw new EngineError(CODES.PATH_DENIED, `拒绝写入保留区：${absTarget}`);
  }
  if (!isPathInside(realRoot, effective, platform)) {
    throw new EngineError(CODES.PATH_ESCAPE, `写入目标逃逸出知识库根目录：${absTarget}`);
  }
  for (const { link, real } of symlinks) {
    if (!isPathInside(realRoot, real, platform)) {
      throw new EngineError(CODES.PATH_ESCAPE, `父链上有指向库外的符号链接：${link} -> ${real}`);
    }
  }
  const P = platformPath(platform);
  const rel = P.relative(normalizeRealPath(realRoot, platform), normalizeRealPath(effective, platform));
  const fold = (s) => (platform === 'linux' ? s : s.toLowerCase());
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (parts.length > 1 && fold(parts[0]) === '.jkkb') {
    const entry = fold(parts[1]);
    if (!JKKB_ALLOWED.has(entry)) {
      throw new EngineError(
        CODES.PATH_DENIED,
        `root/.jkkb 下只允许 runs/、backup/、store/、vault.json、lock.json、DEGRADED.txt：${rel}`,
      );
    }
    if (entry === 'store' && parts.length > 2 && !STORE_NAMESPACES.has(fold(parts[2]))) {
      throw new EngineError(
        CODES.PATH_DENIED,
        `root/.jkkb/store 下只允许 numbering / skills / skill_calls / cards / reports 这些 namespace：${rel}`,
      );
    }
  }
}

function statError(err, abs) {
  if (err && err.code === 'ENOENT') {
    return new EngineError(CODES.ROOT_NOT_FOUND, `知识库根目录不存在：${abs}`);
  }
  return new EngineError(CODES.INVALID_ROOT, `无法访问知识库根目录：${abs}`);
}

// ---------------------------------------------------------------- 事实收集：同步
function rootFactsSync(abs, platform) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch (err) {
    throw statError(err, abs);
  }
  if (!st.isDirectory()) {
    throw new EngineError(CODES.NOT_DIRECTORY, `知识库根目录不是目录：${abs}`);
  }
  return normalizeRealPath(fs.realpathSync(abs), platform);
}

function nearestExistingSync(absTarget, platform) {
  let cur = absTarget;
  const missing = [];
  for (;;) {
    try {
      fs.lstatSync(cur);
      break;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    missing.unshift(path.basename(cur));
    cur = parent;
  }
  let realBase;
  try {
    realBase = fs.realpathSync(cur);
  } catch {
    realBase = cur;
  }
  return path.resolve(normalizeRealPath(realBase, platform), ...missing);
}

function symlinksSync(realRoot, absTarget, platform) {
  const P = platformPath(platform);
  const rel = P.relative(realRoot, absTarget);
  if (rel === '' || rel.startsWith('..') || P.isAbsolute(rel)) return [];
  const out = [];
  let cur = realRoot;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    cur = P.join(cur, part);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      break; // 不存在的段跳过
    }
    if (!st.isSymbolicLink()) continue;
    let real;
    try {
      real = normalizeRealPath(fs.realpathSync(cur), platform);
    } catch {
      throw new EngineError(CODES.PATH_ESCAPE, `无法解析的符号链接：${cur}`);
    }
    out.push({ link: cur, real });
  }
  return out;
}

// ---------------------------------------------------------------- 事实收集：异步
async function rootFacts(abs, platform) {
  let st;
  try {
    st = await fsp.stat(abs);
  } catch (err) {
    throw statError(err, abs);
  }
  if (!st.isDirectory()) {
    throw new EngineError(CODES.NOT_DIRECTORY, `知识库根目录不是目录：${abs}`);
  }
  return normalizeRealPath(await fsp.realpath(abs), platform);
}

async function nearestExisting(absTarget, platform) {
  let cur = absTarget;
  const missing = [];
  for (;;) {
    try {
      await fsp.lstat(cur);
      break;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    missing.unshift(path.basename(cur));
    cur = parent;
  }
  let realBase;
  try {
    realBase = await fsp.realpath(cur);
  } catch {
    realBase = cur;
  }
  return path.resolve(normalizeRealPath(realBase, platform), ...missing);
}

async function symlinksAsync(realRoot, absTarget, platform) {
  const P = platformPath(platform);
  const rel = P.relative(realRoot, absTarget);
  if (rel === '' || rel.startsWith('..') || P.isAbsolute(rel)) return [];
  const out = [];
  let cur = realRoot;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    cur = P.join(cur, part);
    let st;
    try {
      st = await fsp.lstat(cur);
    } catch {
      break; // 不存在的段跳过
    }
    if (!st.isSymbolicLink()) continue;
    let real;
    try {
      real = normalizeRealPath(await fsp.realpath(cur), platform);
    } catch {
      throw new EngineError(CODES.PATH_ESCAPE, `无法解析的符号链接：${cur}`);
    }
    out.push({ link: cur, real });
  }
  return out;
}

// ---------------------------------------------------------------- 对外入口
function normalizeInput(root, target, platform = process.platform) {
  const P = platformPath(platform);
  if (typeof root !== 'string' || root.trim() === '') {
    throw new EngineError(CODES.INVALID_ROOT, 'root 必须是非空字符串（知识库的绝对路径）');
  }
  if (!P.isAbsolute(root)) {
    throw new EngineError(CODES.INVALID_ROOT, `root 必须是绝对路径：${root}`);
  }
  if (typeof target !== 'string' || target.trim() === '') {
    throw new EngineError(CODES.PATH_DENIED, '写入目标必须是非空字符串路径');
  }
  return { absRoot: normalizeRealPath(root, platform), absTarget: normalizeRealPath(target, platform) };
}

export function authorizeRootSync(root) {
  const platform = process.platform;
  const { absRoot } = normalizeInput(root, root, platform);
  const real = rootFactsSync(absRoot, platform);
  judgeRootFacts(absRoot, real, platform);
  return { root: absRoot, realpath: real };
}

export async function authorizeRoot(root) {
  const platform = process.platform;
  const { absRoot } = normalizeInput(root, root, platform);
  const real = await rootFacts(absRoot, platform);
  judgeRootFacts(absRoot, real, platform);
  return { root: absRoot, realpath: real };
}

export function assertWritableSync(root, target) {
  const platform = process.platform;
  const { absRoot, absTarget } = normalizeInput(root, target, platform);
  const realRoot = rootFactsSync(absRoot, platform);
  judgeRootFacts(absRoot, realRoot, platform);
  judgeWritableTarget({
    absTarget,
    realRoot,
    platform,
    effective: nearestExistingSync(absTarget, platform),
    symlinks: symlinksSync(realRoot, absTarget, platform),
  });
}

export async function assertWritable(root, target) {
  const platform = process.platform;
  const { absRoot, absTarget } = normalizeInput(root, target, platform);
  const realRoot = await rootFacts(absRoot, platform);
  judgeRootFacts(absRoot, realRoot, platform);
  judgeWritableTarget({
    absTarget,
    realRoot,
    platform,
    effective: await nearestExisting(absTarget, platform),
    symlinks: await symlinksAsync(realRoot, absTarget, platform),
  });
}
