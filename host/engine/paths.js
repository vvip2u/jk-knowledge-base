/**
 * 路径安全与原子写。
 *
 * 三条硬规则：
 * 1. root 必须已存在、绝对、是目录，且不能是系统目录或用户 home 本身；
 * 2. 任何拼出来的路径都必须先 path.resolve，再校验仍在 root 之内（防 .. 逃逸、防绝对路径注入）；
 * 3. 所有文件写入先写同目录 tmp 再 rename，避免半截文件。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EngineError, CODES } from './errors.js';
import { assertWritable, isPathInside, isReserved, platformPath } from './guard.js';

function norm(p) {
  return path.resolve(p);
}

/** 包含判定委托给 guard（path.relative 语义，无字符串前缀比较）。 */
export function isInside(parent, child) {
  return isPathInside(parent, child);
}

/** 保留区判定集中在 guard.reservedAreas（按平台展开，不硬编码平台根）。 */
function assertAllowedRoot(resolved) {
  if (isReserved(resolved)) {
    throw new EngineError(CODES.FORBIDDEN_ROOT, `禁止把系统目录或保留区当作知识库根目录：${resolved}`);
  }
}

/**
 * 校验并返回规范化的绝对 root。
 * @param {string} input
 * @param {{mustExist?: boolean}} [opts]
 */
export async function resolveRoot(input, opts = {}) {
  const mustExist = opts.mustExist !== false;
  if (typeof input !== 'string' || input.trim() === '') {
    throw new EngineError(CODES.INVALID_ROOT, 'root 必须是非空字符串（知识库的绝对路径）');
  }
  if (input.includes('\0')) {
    throw new EngineError(CODES.INVALID_ROOT, 'root 含非法字符');
  }
  if (!path.isAbsolute(input)) {
    throw new EngineError(CODES.INVALID_ROOT, `root 必须是绝对路径：${input}`);
  }
  const resolved = norm(input);
  assertAllowedRoot(resolved);
  if (!mustExist) return resolved;

  let st;
  try {
    st = await fs.stat(resolved);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new EngineError(CODES.ROOT_NOT_FOUND, `知识库根目录不存在：${resolved}`);
    }
    throw new EngineError(CODES.INVALID_ROOT, `无法访问知识库根目录：${resolved}`);
  }
  if (!st.isDirectory()) {
    throw new EngineError(CODES.NOT_DIRECTORY, `知识库根目录不是目录：${resolved}`);
  }
  return resolved;
}

/** 把一个相对路径拆成安全分段；出现 .. 、绝对路径、空段之外的怪字符就拒绝。 */
export function safeSegments(rel) {
  if (typeof rel !== 'string') {
    throw new EngineError(CODES.PATH_ESCAPE, '内部路径必须是字符串');
  }
  const raw = rel.replace(/\\/g, '/');
  if (platformPath(process.platform).isAbsolute(raw)) {
    throw new EngineError(CODES.PATH_ESCAPE, `拒绝写入绝对路径：${rel}`);
  }
  const parts = raw.split('/').filter((p) => p !== '' && p !== '.');
  for (const p of parts) {
    if (p === '..') {
      throw new EngineError(CODES.PATH_ESCAPE, `拒绝含 .. 的路径逃逸：${rel}`);
    }
    if (p.includes('\0')) {
      throw new EngineError(CODES.PATH_ESCAPE, `路径含非法字符：${rel}`);
    }
  }
  return parts;
}

/** root + 相对路径 → 绝对路径，并强制校验落地位置仍在 root 之内。 */
export function safeJoin(root, rel) {
  const parts = safeSegments(rel);
  const target = path.resolve(root, ...parts);
  if (!isInside(root, target)) {
    throw new EngineError(CODES.PATH_ESCAPE, `路径逃逸出知识库根目录：${rel}`);
  }
  return target;
}

export async function exists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 建目录（先过守卫，再 mkdir recursive）。
 * 目标已存在但不是目录时明确报 NOT_DIRECTORY，而不是裸抛 EEXIST/ENOTDIR。
 */
export async function ensureDir(root, target) {
  if (root) await assertWritable(root, target);
  try {
    await fs.mkdir(target, { recursive: true });
  } catch (err) {
    if (err && (err.code === 'EEXIST' || err.code === 'ENOTDIR')) {
      throw new EngineError(CODES.NOT_DIRECTORY, `目标已存在且不是目录：${target}`, String(err.message));
    }
    throw new EngineError(CODES.WRITE_FAILED, `创建目录失败：${target}`, String(err && err.message));
  }
}

// ---------------------------------------------------------------- 跨平台：命名 / 长度 / 原子替换

const ILLEGAL_SEGMENT_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 路径段消毒：去掉 <>:"/\|?* 与控制字符、去掉首尾空格与结尾点、
 * 避开 Windows 保留名（加 _ 后缀）、按 UTF-8 字节与 UTF-16 单元双限截断（默认 200）。
 */
export function sanitizeSegment(name, maxBytes = 200) {
  let s = String(name == null ? '' : name).replace(ILLEGAL_SEGMENT_CHARS, '');
  s = s.replace(/^[ \t]+/g, '').replace(/[ \t.]+$/g, '');
  if (!s || s === '.' || s === '..') return '_';
  const dot = s.indexOf('.');
  const stem = dot > 0 ? s.slice(0, dot) : s;
  if (WINDOWS_RESERVED.test(stem)) {
    s = dot > 0 ? `${stem}_${s.slice(dot)}` : `${s}_`;
  }
  if (Buffer.byteLength(s, 'utf8') > maxBytes || s.length > maxBytes) {
    let out = '';
    for (const ch of s) {
      const next = out + ch;
      if (Buffer.byteLength(next, 'utf8') > maxBytes || next.length > maxBytes) break;
      out = next;
    }
    s = out || '_';
  }
  return s;
}

/** 相对路径包含判定：path.relative 语义（win32 下大小写不敏感），禁止字符串前缀比较。 */
export function isRelPathInside(rel, base, platform = process.platform) {
  const P = platformPath(platform);
  const norm = (v) => String(v).replace(/[\\/]+/g, P.sep);
  let a = norm(base);
  let b = norm(rel);
  if (platform === 'win32') {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  const r = P.relative(a, b);
  return r === '' || (!r.startsWith('..') && !P.isAbsolute(r));
}

/** 相对路径逐段消毒（分隔符按当前平台归一）。 */
export function sanitizeRelPath(rel) {
  return String(rel)
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((seg) => sanitizeSegment(seg))
    .join(path.sep);
}

/**
 * 路径总长预判：win32 下 root + 相对路径 > limit（默认 240）提前抛 PATH_TOO_LONG。
 * 其他平台不限制（函数保留，便于测试与上层复用）。
 */
export function assertPathLength(root, relPath, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'win32') return;
  const limit = Number.isFinite(opts.limit) ? opts.limit : 240;
  const P = platformPath(platform);
  const rootPart = P.resolve(String(root)).replace(/\\+$/, '');
  const relPart = String(relPath).replace(/[\\/]+/g, '\\').replace(/^\\+/, '');
  const total = rootPart.length + 1 + relPart.length;
  if (total > limit) {
    throw new EngineError(
      CODES.PATH_TOO_LONG,
      `路径总长 ${total} 超过 Windows 上限 ${limit}：${rootPart}\\${relPart}`,
    );
  }
}

const WIN_RETRY_CODES = new Set(['EEXIST', 'EPERM', 'EBUSY', 'EACCES']);

/**
 * 原子替换：POSIX 直接 rename；win32 先 unlink 目标再 rename，
 * 遇到 EEXIST/EPERM/EBUSY/EACCES 做 3 次指数退避重试，仍失败抛 FILE_BUSY。
 */
export async function replaceFile(tmp, dest, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'win32') {
    await fs.rename(tmp, dest);
    return 'renamed';
  }
  const retries = opts.retries == null ? 3 : opts.retries;
  const baseDelay = opts.baseDelayMs == null ? 20 : opts.baseDelayMs;
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      try {
        await fs.unlink(dest);
      } catch (err) {
        if (!err || err.code !== 'ENOENT') throw err;
      }
      await fs.rename(tmp, dest);
      return 'replaced';
    } catch (err) {
      last = err;
      if (!WIN_RETRY_CODES.has(err && err.code)) break;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, baseDelay * 2 ** attempt));
      }
    }
  }
  throw new EngineError(
    CODES.FILE_BUSY,
    `替换文件失败（目标可能被占用）：${dest}`,
    String(last && last.message),
  );
}

/**
 * tmp 文件放在哪：.jkkb 下的目标改放 .jkkb/runs/（.jkkb 只允许白名单条目），
 * 其它目标与最终文件同目录，保证 rename 是同一文件系统内的原子操作。
 */
function tmpTargetFor(target, root) {
  let dir = path.dirname(target);
  if (root) {
    const rel = path.relative(path.resolve(root), path.resolve(target));
    const parts = rel.split(path.sep).filter(Boolean);
    if (parts[0] === '.jkkb' && !rel.startsWith(`..${path.sep}`)) {
      dir = path.join(path.resolve(root), '.jkkb', 'runs');
    }
  }
  return path.join(dir, `.jkkb-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
}

/**
 * 原子写：默认不覆盖已存在的文件。
 * 传 opts.root 时，最终目标、tmp、父目录三处都先过 assertWritable（S1 路径守卫）。
 * @returns {Promise<'created'|'overwritten'|'skipped'>}
 */
export async function writeAtomic(target, content, opts = {}) {
  const force = opts.force === true;
  const root = opts.root || null;
  if (root) {
    assertPathLength(root, path.relative(path.resolve(root), path.resolve(target)));
    await assertWritable(root, target);
  }
  const existed = await exists(target);
  if (existed && !force) return 'skipped';
  const dir = path.dirname(target);
  const tmp = tmpTargetFor(target, root);
  const tmpDir = path.dirname(tmp);
  try {
    if (root) {
      await assertWritable(root, dir);
      await assertWritable(root, tmpDir);
      await assertWritable(root, tmp);
    }
    await fs.mkdir(tmpDir, { recursive: true });
    if (dir !== tmpDir) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, content, 'utf8');
    if (root) await assertWritable(root, target); // rename 前再校验一次
    await replaceFile(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    if (err instanceof EngineError) throw err;
    throw new EngineError(CODES.WRITE_FAILED, `写入失败：${target}`, String(err && err.message));
  }
  return existed ? 'overwritten' : 'created';
}

/**
 * 产物指纹：[{ path: 绝对路径, size, mtimeMs }]。
 * 文件不存在（或 stat 失败）时 size/mtimeMs 写 null，表示"记录过但已不存在"，绝不抛错。
 */
export async function fingerprintArtifacts(paths = []) {
  const list = Array.isArray(paths) ? paths : [];
  const out = [];
  for (const p of list) {
    if (typeof p !== 'string' || p.trim() === '') continue;
    const abs = path.resolve(p);
    try {
      const st = await fs.stat(abs);
      out.push({ path: abs, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      out.push({ path: abs, size: null, mtimeMs: null });
    }
  }
  return out;
}

/** 读文本文件，不存在返回 null。 */
export async function readTextOrNull(target) {
  try {
    return await fs.readFile(target, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw new EngineError(CODES.WRITE_FAILED, `读取失败：${target}`, String(err && err.message));
  }
}

export function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function nowIso(now = new Date()) {
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  return `${local}${sign}${pad(off / 60)}:${pad(off % 60)}`;
}
