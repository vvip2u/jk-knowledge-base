/**
 * 隔离助手：损坏/过期产物一律 move 到 <root>/.jkkb/quarantine/<YYYYMMDD-HHmmss>/<原相对路径>，
 * 绝不删除。写入前过路径守卫（.jkkb/quarantine 已在白名单内）。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { assertWritable } from '../engine/guard.js';
import { safeJoin } from '../engine/paths.js';
import { exists, relOf, stamp } from './util.js';

export const QUARANTINE_REL = path.join('.jkkb', 'quarantine');

export function quarantineRoot(root) {
  return safeJoin(path.resolve(String(root)), QUARANTINE_REL);
}

/** 递归复制（rename 不可用时兜底，保留层级）。 */
async function copyTree(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.copyFile(src, dst);
}

/**
 * 把 absPath 移到隔离区，返回隔离后的绝对路径。
 * 已存在同名文件时追加 `-2`、`-3` 避免覆盖。
 */
export async function quarantineFile({ root, absPath, now }) {
  const rootAbs = path.resolve(String(root));
  const rel = relOf(rootAbs, absPath);
  if (!rel || rel.startsWith('..')) throw new Error('隔离目标不在 root 内：' + absPath);
  const dir = path.join(quarantineRoot(rootAbs), stamp(now));
  let target = path.join(dir, rel);
  let n = 2;
  while (await exists(target)) {
    target = path.join(dir, `${rel}.${n}`);
    n += 1;
  }
  await assertWritable(rootAbs, target);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.rename(absPath, target);
  } catch {
    await copyTree(absPath, target);
    await fsp.unlink(absPath);
  }
  return target;
}

/** 隔离区最近条目（供 QUAR-01 展示）。 */
export async function listQuarantine(root) {
  const base = quarantineRoot(root);
  const out = [];
  async function walk(dir, depth) {
    if (depth > 4) return;
    for (const ent of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(abs, depth + 1);
      else out.push({ abs, rel: relOf(root, abs), mtimeMs: (await fsp.stat(abs)).mtimeMs });
    }
  }
  await walk(base, 0);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
