/**
 * 恢复前的产物备份（S4）。
 *
 * 语义：restart 之前必须把 checkpoint 里**仍然存在**的产物复制到
 *   <root>/.jkkb/backup/<YYYYMMDD-HHmmss>/<相对路径>
 * 保留目录层级；每一步都过路径守卫；备份失败 → 调用方不得执行 restart。
 * resume 不调用本模块（只补缺、不覆盖）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { assertWritableSync } from './engine/guard.js';

function pad(n) {
  return String(n).padStart(2, '0');
}

/** YYYYMMDD-HHmmss（本地时间，无冒号，Windows 文件名安全）。 */
export function backupStamp(now) {
  const date = now instanceof Date ? now : new Date(typeof now === 'number' ? now : Date.now());
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate())
    + '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
}

export function backupRoot(root) {
  return path.join(String(root), '.jkkb', 'backup');
}

/**
 * 目录名：<YYYYMMDD-HHmmss>-<runId 尾部 8 位>。
 * 注意：runId 形如 `verify-20261017T084316-bbe352`，前 8 位恒为 `verify-2`，
 * 按"前 8 位"取会让同秒的两次 restart 撞名；尾部是随机段，才是真正唯一的。
 */
export function backupDirFor(root, now, runId) {
  const suffix = String(runId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(-8);
  return path.join(backupRoot(root), backupStamp(now) + (suffix ? '-' + suffix : ''));
}

/**
 * @returns {{ok:boolean, dir:string, runId:string|null, copied:Array, failed:Array}}
 *   files 中不存在的条目直接跳过（契约：只备份"仍然存在的文件"）。
 */
export function backupArtifacts(args) {
  const a = args || {};
  const root = String(a.root || '');
  const files = Array.isArray(a.files) ? a.files : [];
  const dir = backupDirFor(root, a.now, a.runId);
  const copied = [];
  const failed = [];
  const seen = new Set();

  files.forEach((file) => {
    if (typeof file !== 'string' || !file || seen.has(file)) return;
    seen.add(file);
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      return; // 文件已不存在 → 跳过（不视为备份失败）
    }
    if (!stat.isFile()) return;

    const rel = path.relative(path.resolve(root), path.resolve(file));
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      failed.push({ path: file, reason: '不在知识库根目录内' });
      return;
    }

    const dest = path.join(dir, rel);
    try {
      assertWritableSync(root, dest);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
      copied.push({ path: file, dest: dest, size: stat.size });
    } catch (err) {
      const code = err && err.code ? err.code : 'COPY_FAILED';
      failed.push({ path: file, reason: code + ': ' + (err && err.message ? err.message : String(err)) });
    }
  });

  return {
    ok: failed.length === 0,
    dir: dir,
    runId: typeof a.runId === 'string' ? a.runId : null,
    copied: copied,
    failed: failed,
  };
}
