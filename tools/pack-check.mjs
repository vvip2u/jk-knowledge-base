#!/usr/bin/env node
/**
 * 打包白名单自检：证明 npm 包是「独立干净」的。
 *
 * 这不是风格检查——assets/maintenance-rules.json 曾经漏在 files 白名单外，
 * 结果 npm 装出来的插件一跑「整理」就 ASSETS_MISSING。这个脚本把「运行时真读的文件」
 * 与「files 白名单真正选中的文件」做集合比对，漏一个就红。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; return; }
  fails.push(detail ? name + ' → ' + detail : name);
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected));

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const files = Array.isArray(pkg.files) ? pkg.files : [];

// ── 1. files 模式展开（只支持本仓库用到的两种：字面量、dir/**、**/*.x）
function listAll(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.jkkb') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) listAll(abs, out);
    else out.push(path.relative(ROOT, abs).split(path.sep).join('/'));
  }
  return out;
}
const allFiles = listAll(ROOT);

const selected = new Set();
for (const pattern of files) {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3) + '/';
    allFiles.filter((f) => f.startsWith(prefix)).forEach((f) => selected.add(f));
  } else if (pattern.includes('*')) {
    const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
    allFiles.filter((f) => re.test(f)).forEach((f) => selected.add(f));
  } else if (allFiles.includes(pattern)) {
    selected.add(pattern);
  } else {
    ok('files 里的字面量都真实存在：' + pattern, false, '文件不存在');
  }
}

// ── 2. 运行时真读的资源（源码里的 assets/ 引用）
const REQUIRED_ASSETS = new Set();
const SRC = ['host', 'index.js'];
function scanSources(dirOrFile) {
  const abs = path.join(ROOT, dirOrFile);
  if (statSync(abs).isDirectory()) {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      scanSources(path.join(dirOrFile, entry.name));
    }
    return;
  }
  if (!/\.(js|mjs)$/.test(dirOrFile)) return;
  const text = readFileSync(abs, 'utf8');
  for (const m of text.matchAll(/assets\/[A-Za-z0-9_\-./]+/g)) {
    REQUIRED_ASSETS.add(m[0].replace(/[.,;:'"]+$/, ''));
  }
}
SRC.forEach(scanSources);

// 源码注释里会引用外部 SKILL 的 assets 路径（本仓库并无此文件），只校验磁盘上真实存在的资源。
const existing = new Set(allFiles);
const requiredLocal = [...REQUIRED_ASSETS].filter((rel) => existing.has(rel));
const missing = requiredLocal.filter((rel) => ![...selected].some((f) => f === rel || f.startsWith(rel)));
ok('运行时读取的 assets 全在白名单内', missing.length === 0, '缺：' + missing.join('、'));

// ── 3. 干净性：不得进包的东西
for (const forbidden of ['node_modules/', '.jkkb/', '.DS_Store', 'pnpm-lock.yaml']) {
  ok('白名单不含 ' + forbidden, !files.some((f) => f.includes(forbidden)), files.filter((f) => f.includes(forbidden)).join(','));
}

// ── 4. 仓库内不得有个人绝对路径与运行时数据
const leaks = [];
for (const file of allFiles) {
  if (!/\.(js|mjs|json|md|yml)$/.test(file)) continue;
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  const homeRefs = [...text.matchAll(/\/Users\/([A-Za-z0-9_.\-]+)\/|C:\\\\Users\\\\([A-Za-z0-9_.\-]+)\\\\/g)];
  const FIXTURES = new Set(['tester', 'runner', 'user', 'username', 'example', 'you', 'admin', 'me', 'someone']);
  const real = homeRefs
    .map((m) => m[1] || m[2])
    .filter((name) => name && !FIXTURES.has(name.toLowerCase()) && !name.includes('<'));
  if (real.length) leaks.push(file + '（' + [...new Set(real)].join(',') + '）');
}
ok('无个人绝对路径泄漏', leaks.length === 0, leaks.join('、'));

// ── 5. 清单一致性
eq('无运行时依赖', pkg.dependencies, undefined);
ok('exports 指向真实文件', [pkg.exports['.'], pkg.exports['./client']].every((p) => allFiles.includes(String(p).replace('./', ''))));
// 目录级资源（specs/ 与 templates/ 是整目录读取，正则抓不到具体文件）：必须整目录进包且非空
const assetFiles = allFiles.filter((f) => f.startsWith('assets/') && f !== 'assets/skills/README.md');
const assetMissing = assetFiles.filter((f) => !selected.has(f));
ok('assets/ 下所有运行时资源都在包内', assetMissing.length === 0, '缺：' + assetMissing.join('、'));
ok('assets/ 资源非空（specs / templates 至少各 5 个）',
  assetFiles.filter((f) => f.startsWith('assets/engine/specs/')).length >= 5
  && assetFiles.filter((f) => f.startsWith('assets/engine/templates/')).length >= 5,
  assetFiles.length + ' 个');

ok('dsh 清单存在', !!(pkg.dsh && pkg.dsh.client && pkg.dsh.engines && pkg.dsh.bundle), JSON.stringify(Object.keys(pkg.dsh || {})));
ok('cordis.patch.yml 在包内', selected.has('cordis.patch.yml'));
ok('LICENSE / README / CHANGELOG 在包内', ['LICENSE', 'README.md', 'CHANGELOG.md'].every((f) => selected.has(f)));
// 根目录 = 动作指南（能照着执行），必须随包分发；docs/ = 设计图纸，刻意不进包
const ROOT_GUIDES = ['README.md', 'DOCTOR.md', 'PUBLISHING.md', 'VERIFY-WINDOWS.md', 'CHANGELOG.md', 'LICENSE'];
ok('根级动作指南齐全且在包内', ROOT_GUIDES.every((f) => selected.has(f)), ROOT_GUIDES.filter((f) => !selected.has(f)).join('、'));
ok('docs/ 设计图纸不进包（运行时不需要）', ![...selected].some((f) => f.startsWith('docs/')), [...selected].filter((f) => f.startsWith('docs/')).join('、'));
// docs/ 若存在必须有索引，且每份文档都被索引登记（防止新增文档漏登记）
const docFiles = allFiles.filter((f) => f.startsWith('docs/') && f.endsWith('.md') && f !== 'docs/README.md');
if (docFiles.length) {
  const index = readFileSync(path.join(ROOT, 'docs/README.md'), 'utf8');
  const unindexed = docFiles.filter((f) => !index.includes(f.split('/').pop()));
  ok('docs/ 每份文档都在索引里登记', unindexed.length === 0, unindexed.join('、'));
  ok('docs/ 内部链接不指向不存在的文件', (() => {
    const links = [...index.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => m[1]);
    const missingLinks = links.filter((rel) => !allFiles.includes('docs/' + rel.replace(/^\.\//, '')));
    return missingLinks.length === 0;
  })());
}
ok('入口文件在包内', selected.has('index.js') && selected.has('client.js'));

// ── 6. 体积上限（防止误把测试产物或数据带进包）
const bytes = [...selected].reduce((sum, f) => sum + statSync(path.join(ROOT, f)).size, 0);
ok('入包体积 < 3 MB', bytes < 3 * 1024 * 1024, (bytes / 1024 / 1024).toFixed(2) + ' MB');

console.log('[pack-check] 入包 ' + selected.size + ' 个文件 / ' + (bytes / 1024 / 1024).toFixed(2) + ' MB');
console.log('[pack-check] 运行时资源 ' + REQUIRED_ASSETS.size + ' 个，全部命中白名单');
if (fails.length) {
  console.error('[pack-check] 失败 ' + fails.length + ' 条：');
  fails.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log('PACK CHECK OK: ' + pass + '/' + pass);
