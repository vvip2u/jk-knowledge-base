/**
 * 只读扫描：verify / reindex / inspect 共用。
 * 跳过 .jkkb、.obsidian 等隐藏目录、node_modules、以及 assets/engine（插件自身资源）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isRelPathInside } from './paths.js';

const SKIP_NAMES = new Set(['node_modules']);
const SKIP_RELS = new Set(['assets/engine']);

function shouldSkipDir(name, rel) {
  if (!name || name.startsWith('.')) return true;
  if (SKIP_NAMES.has(name)) return true;
  if (SKIP_RELS.has(rel)) return true;
  return false;
}

/**
 * @param {string} root 已解析的绝对路径
 * @param {{maxFiles?: number, maxDepth?: number}} [opts]
 */
export async function scanVault(root, opts = {}) {
  const maxFiles = opts.maxFiles || 5000;
  const maxDepth = opts.maxDepth || 12;
  const skipPrefixes = (opts.skipPrefixes || []).map((p) => String(p).replace(/\/$/, ''));
  const files = [];
  const dirs = [];
  let truncated = false;

  async function walk(abs, rel, depth) {
    if (truncated || depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    let fileCount = 0;
    let size = 0;
    let latest = 0;
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const childAbs = path.join(abs, ent.name);
      if (ent.isDirectory()) {
        if (shouldSkipDir(ent.name, childRel)) continue;
        if (skipPrefixes.some((p) => childRel === p || isRelPathInside(childRel, p))) continue;
        await walk(childAbs, childRel, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      let st;
      try {
        st = await fs.stat(childAbs);
      } catch {
        continue;
      }
      fileCount += 1;
      size += st.size;
      if (st.mtimeMs > latest) latest = st.mtimeMs;
      if (files.length >= maxFiles) {
        truncated = true;
        continue;
      }
      files.push({ rel: childRel, abs: childAbs, name: ent.name, size: st.size, mtimeMs: st.mtimeMs });
    }
    dirs.push({ rel, fileCount, size, mtimeMs: latest });
  }

  await walk(root, '', 0);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  dirs.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, dirs, truncated, notes: files.filter((f) => f.rel.endsWith('.md')) };
}

const MAX_BOM_STRIP = 3;

/**
 * 去掉开头的 UTF-8 BOM（\uFEFF）。Windows 记事本/Excel 导出的 md 常带 BOM，
 * 不剥离会让 startsWith('---') 判定为假，frontmatter 整段丢失。
 * 最多剥 3 个连续 BOM。
 */
export function stripBom(text) {
  let s = typeof text === 'string' ? text : String(text == null ? '' : text);
  for (let i = 0; i < MAX_BOM_STRIP; i += 1) {
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    else break;
  }
  return s;
}

/** 统一行切分：容忍 CRLF / LF，并吃掉切片边界残留的单个 \r。 */
export function splitLines(text) {
  return String(text == null ? '' : text)
    .split(/\r?\n/)
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/**
 * 极简 frontmatter 解析：只取单行标量，够索引与体检用。
 * BOM 剥离的唯一入口就在这里（readTags 等调用方直接传原始文本，不再各自剥离）。
 */
export function parseFrontmatter(text) {
  if (typeof text !== 'string') return {};
  const src = stripBom(text);
  if (!src.startsWith('---')) return {};
  const end = src.indexOf('\n---', 3);
  if (end < 0) return {};
  const fm = {};
  for (const line of splitLines(src.slice(3, end))) {
    if (!line || line[0] === ' ' || line[0] === '\t' || line[0] === '#' || line[0] === '-') continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }
  return fm;
}

/** 读笔记标签：l1 单值 + l2/l3 数组，拼成一行给索引表格用。 */
export async function readTags(abs) {
  let text;
  try {
    text = await fs.readFile(abs, 'utf8');
  } catch {
    return '';
  }
  const fm = parseFrontmatter(text.slice(0, 4000));
  const parts = [];
  if (fm.l1) parts.push(fm.l1);
  for (const key of ['l2', 'l3']) {
    if (!fm[key]) continue;
    const vals = fm[key]
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    parts.push(...vals);
  }
  return parts.join(' / ');
}

export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
