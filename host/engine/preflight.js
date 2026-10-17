/**
 * preflight：开跑前的只读预检。
 *
 * 返回 { ok, code, checks[], counts:{files,notes,limit,truncated}, freeBytes, elapsedMs }。
 * 唯一会落盘的检查是可写性探针（只写 <root>/.jkkb/runs/ 下的临时文件，写完即删），
 * 其余全部只读；任何失败都不会影响已有文件。
 *
 * 硬失败：ROOT_UNAVAILABLE / ROOT_NOT_WRITABLE / DISK_LOW / TOO_MANY_FILES /
 *         VAULT_INVALID / MODE_CONFLICT / PATH_DENIED。
 * 磁盘空间取不到时降级为 warn + freeBytes:null（不算失败）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EngineError } from './errors.js';
import { assertWritable, authorizeRoot } from './guard.js';

export const PREFLIGHT_DEFAULTS = Object.freeze({
  maxFiles: 5000,
  minFreeBytes: 200 * 1024 * 1024,
  timeBudgetMs: 3000,
});

const SKIP_DIR_NAMES = new Set(['node_modules']);

function shouldSkipDir(name, rel) {
  if (!name || name.startsWith('.')) return true;
  if (SKIP_DIR_NAMES.has(name)) return true;
  return rel === 'assets/engine';
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return '未知';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function makeChecks() {
  const checks = [];
  const add = (level, id, title, detail, fix) => {
    const item = { id, level, title, detail };
    if (fix) item.fix = fix;
    checks.push(item);
    return item;
  };
  return { checks, add };
}

/** 有上限 + 时间预算的只读计数；达到上限立刻短路，不扫完全库。 */
async function countFiles(root, maxFiles, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let files = 0;
  let notes = 0;
  let truncated = false;
  const stack = [''];
  while (stack.length) {
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (shouldSkipDir(ent.name, childRel)) continue;
        stack.push(childRel);
        continue;
      }
      if (!ent.isFile()) continue; // 软链不跟随，避免越界与死循环
      files += 1;
      if (ent.name.endsWith('.md')) notes += 1;
      if (files > maxFiles) {
        return { files, notes, truncated: true, exceeded: true };
      }
    }
  }
  return { files, notes, truncated, exceeded: false };
}

/**
 * @param {{root?:string, mode?:'asset'|'topic', kind?:string, limits?:object, deps?:object}} args
 * deps.statfs 仅用于测试注入（模拟 statfs 不可用），宿主不需要传。
 */
export async function preflight({ root, mode = 'asset', kind = 'bootstrap', limits = {}, deps = {} } = {}) {
  const started = Date.now();
  const opts = { ...PREFLIGHT_DEFAULTS, ...(limits || {}) };
  const { checks, add } = makeChecks();
  const finish = (code, extra = {}) => {
    const ok = code === 'OK';
    return {
      ok,
      code,
      checks,
      counts: {
        files: extra.files == null ? 0 : extra.files,
        notes: extra.notes == null ? 0 : extra.notes,
        limit: opts.maxFiles,
        truncated: extra.truncated === true,
      },
      freeBytes: extra.freeBytes === undefined ? null : extra.freeBytes,
      elapsedMs: Date.now() - started,
    };
  };

  // 1) root 可用性
  let abs = null;
  if (typeof root !== 'string' || root.trim() === '' || !path.isAbsolute(root)) {
    add('error', 'root', '根目录可用', `root 必须是非空绝对路径：${JSON.stringify(root)}`, '选择一个已存在的绝对目录');
    return finish('ROOT_UNAVAILABLE');
  }
  abs = path.resolve(root);
  let st;
  try {
    st = await fs.stat(abs);
  } catch (err) {
    add('error', 'root', '根目录可用', `路径不存在或不可访问：${abs}（errno=${(err && err.code) || 'UNKNOWN'}）`, '先创建该目录，或换一个已存在的目录');
    return finish('ROOT_UNAVAILABLE');
  }
  if (!st.isDirectory()) {
    add('error', 'root', '根目录可用', `不是目录：${abs}`, '选择一个目录作为知识库根');
    return finish('ROOT_UNAVAILABLE');
  }
  add('ok', 'root', '根目录可用', abs);

  // 2) 路径守卫（保留区 / 逃逸 / .jkkb 白名单）
  try {
    await authorizeRoot(abs);
    await assertWritable(abs, path.join(abs, '.jkkb', 'runs'));
    add('ok', 'guard', '路径守卫', '根目录与 .jkkb/runs 均在允许写入范围内');
  } catch (err) {
    const code = err instanceof EngineError ? err.code : 'PATH_DENIED';
    add('error', 'guard', '路径守卫', `${code}：${err && err.message ? err.message : err}`, '换一个普通业务目录作为根，或移除指向库外的软链');
    return finish('PATH_DENIED');
  }

  // 3) 文件数（硬上限，超限短路；绝不开始写文件）
  //    kind=curate / archive 只处理明确指定的少量文件，不需要扫全库，跳过整库计数。
  const counted = kind === 'curate' || kind === 'archive'
    ? { files: 0, notes: 0, truncated: false, exceeded: false }
    : await countFiles(abs, opts.maxFiles, opts.timeBudgetMs);
  if (kind === 'curate' || kind === 'archive') {
    add('ok', 'files', '文件数量', `${kind} 不扫描全库，跳过 5000 文件上限检查`);
  } else if (counted.exceeded) {
    add(
      'error',
      'files',
      '文件数量',
      `文件数已达到/超过上限 ${opts.maxFiles}（已计入 ${counted.files}，未扫完全库）`,
      `两条出路：① 换一个更小的子目录作为根（推荐）；② 在 settings.json 的 limits.maxFiles 提高上限（当前 ${opts.maxFiles}）`,
    );
    return finish('TOO_MANY_FILES', { files: counted.files, notes: counted.notes, truncated: true });
  } else {
    add(
      'ok',
      'files',
      '文件数量',
      `已扫描 ${counted.files} 个文件 / ${counted.notes} 篇笔记（上限 ${opts.maxFiles}${counted.truncated ? '，扫描时间预算已到，计数为下限' : ''}）`,
    );
  }

  // 4) vault.json：不存在算首次建库；损坏 → VAULT_INVALID；mode 冲突 → MODE_CONFLICT
  const vaultPath = path.join(abs, '.jkkb', 'vault.json');
  let vault = null;
  const vaultRaw = await fs.readFile(vaultPath, 'utf8').catch((err) => {
    if (err && err.code === 'ENOENT') return null;
    return { __readError: err };
  });
  if (vaultRaw && vaultRaw.__readError) {
    const err = vaultRaw.__readError;
    add('error', 'vault', '契约文件', `读取失败：errno=${(err && err.code) || 'UNKNOWN'}（${err && err.message}）`, '检查文件权限');
    return finish('VAULT_INVALID', { files: counted.files, notes: counted.notes });
  }
  if (vaultRaw === null) {
    add('ok', 'vault', '契约文件', '尚无 .jkkb/vault.json（首次建库，属正常）');
  } else {
    try {
      vault = JSON.parse(String(vaultRaw).replace(/^\uFEFF/, ''));
    } catch (err) {
      add('error', 'vault', '契约文件', `vault.json 不是合法 JSON：${err && err.message}`, '修复 JSON，或删除该文件后重新 bootstrap');
      return finish('VAULT_INVALID', { files: counted.files, notes: counted.notes });
    }
    if (!vault || typeof vault !== 'object') {
      add('error', 'vault', '契约文件', 'vault.json 结构不是对象', '删除该文件后重新 bootstrap');
      return finish('VAULT_INVALID', { files: counted.files, notes: counted.notes });
    }
    if (mode && vault.mode && vault.mode !== mode) {
      add(
        'error',
        'vault',
        '契约文件',
        `库已存在且 mode=${vault.mode}，与本次 mode=${mode} 冲突`,
        '沿用库现有 mode，或显式 force 重建（会覆盖系统文件）',
      );
      return finish('MODE_CONFLICT', { files: counted.files, notes: counted.notes });
    }
    add('ok', 'vault', '契约文件', `vault.json 可解析（mode=${vault.mode || '未记录'}，status=${vault.status || '未记录'}）`);
  }

  // 5) 磁盘空间：取不到就降级 warn + null，不算失败
  let freeBytes = null;
  try {
    const statfs = typeof deps.statfs === 'function' ? deps.statfs : fs.statfs;
    if (typeof statfs !== 'function') throw Object.assign(new Error('statfs 不可用'), { code: 'ENOSYS' });
    const stats = await statfs(abs);
    const bavail = Number(stats && stats.bavail);
    const bsize = Number(stats && stats.bsize);
    const computed = bavail * bsize;
    if (!Number.isFinite(computed) || bavail < 0) {
      throw Object.assign(new Error('statfs 返回了不可用的数值'), { code: 'EINVAL' });
    }
    freeBytes = computed;
  } catch (err) {
    freeBytes = null;
    add(
      'warn',
      'disk',
      '磁盘空间',
      `无法获取可用空间，已降级为「未知」：errno=${(err && err.code) || 'UNKNOWN'}（${err && err.message ? err.message : err}）`,
      '可忽略；如需严格判断，请在支持 statfs 的本地文件系统上使用',
    );
  }
  if (freeBytes !== null) {
    if (freeBytes < opts.minFreeBytes) {
      add(
        'error',
        'disk',
        '磁盘空间',
        `可用空间 ${humanBytes(freeBytes)} 低于下限 ${humanBytes(opts.minFreeBytes)}`,
        '清理磁盘，或在 settings.json 的 limits.minFreeBytes 调低下限',
      );
      return finish('DISK_LOW', { files: counted.files, notes: counted.notes, freeBytes });
    }
    add('ok', 'disk', '磁盘空间', `可用 ${humanBytes(freeBytes)}（下限 ${humanBytes(opts.minFreeBytes)}）`);
  }

  // 6) 可写性探针：只写 .jkkb/runs 下的临时文件，写完立刻删除
  const probeName = `.write-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const probePath = path.join(abs, '.jkkb', 'runs', probeName);
  let probeOk = true;
  try {
    await assertWritable(abs, probePath);
    await fs.mkdir(path.dirname(probePath), { recursive: true });
    await fs.writeFile(probePath, 'probe\n', 'utf8');
    await fs.unlink(probePath);
    add('ok', 'writable', '可写性', `已实测写入并删除 ${path.join('.jkkb', 'runs', probeName)}`);
  } catch (err) {
    probeOk = false;
    await fs.unlink(probePath).catch(() => {});
    add(
      'error',
      'writable',
      '可写性',
      `写入探针失败：errno=${(err && err.code) || 'UNKNOWN'}（${err && err.message ? err.message : err}）`,
      '给目录写权限，或换一个可写目录作为根',
    );
  }

  if (!probeOk) return finish('ROOT_NOT_WRITABLE', { files: counted.files, notes: counted.notes, freeBytes });
  if (kind && kind !== 'bootstrap' && kind !== 'reindex' && kind !== 'verify') {
    add('warn', 'kind', '调用参数', `未知的 kind=${kind}，按 bootstrap 预检处理`);
  }
  return finish('OK', { files: counted.files, notes: counted.notes, freeBytes });
}
