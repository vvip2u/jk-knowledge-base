/**
 * doctor 共用小工具：只做读与路径计算，不在这里写盘。
 */
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';

export function readJsonRaw(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')), error: null };
  } catch (err) {
    return { ok: false, value: null, error: err };
  }
}

export function readTextRaw(file) {
  try {
    return { ok: true, text: fs.readFileSync(file, 'utf8'), error: null };
  } catch (err) {
    return { ok: false, text: null, error: err };
  }
}

export function existsSync(file) {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

export async function exists(file) {
  try {
    await fsp.stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function isDir(file) {
  try {
    return (await fsp.stat(file)).isDirectory();
  } catch {
    return false;
  }
}

export async function readdirSafe(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function toDate(now) {
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now;
  if (typeof now === 'string' && now.trim()) {
    const d = new Date(now);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export function pad(n) {
  return String(n).padStart(2, '0');
}

export function stamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function relOf(root, abs) {
  return path.relative(String(root), String(abs)).split(path.sep).join('/');
}

export function isBackupOrTmp(name) {
  return name.endsWith('.bak') || name.endsWith('.tmp') || name.startsWith('.');
}

/** 归纳 checks 计数（含 blocked / repairable）。 */
export function summarize(checks) {
  const base = { total: checks.length, ok: 0, warn: 0, error: 0, blocked: 0, repairable: 0 };
  for (const c of checks) {
    base[c.level] = (base[c.level] || 0) + 1;
    if (c.level === 'error' && c.repairable) base.repairable += 1;
  }
  return base;
}
