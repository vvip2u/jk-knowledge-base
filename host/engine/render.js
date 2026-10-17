/**
 * 渲染层：把预设与规范渲染成库内可直接阅读的 markdown。
 * 只做字符串拼装，不碰文件系统（写盘在 scaffold / indexer 里）。
 */
import { ATOM_RULE, BASELINE_TAGS, SPEC_META } from './specs.js';
import { DOC_SLOTS, TEMPLATE_FILES, docId, siblingList } from './presets.js';

export const MAP_START = '<!-- jkkb:moc-map:start -->';
export const MAP_END = '<!-- jkkb:moc-map:end -->';
export const INDEX_MARKER_RE = /<!-- jkkb:index ([^>]*?)-->/;

function esc(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function wikilink(relMdPath) {
  return `[[${String(relMdPath).replace(/\\/g, '/').replace(/\.md$/, '')}]]`;
}

export function planTable(dirs) {
  const rows = ['| 目录 | 角色 | 放什么 | 不放什么 | 命名规则 | 重点 |', '| --- | --- | --- | --- | --- | --- |'];
  for (const d of dirs) {
    rows.push(`| \`${esc(d.path)}/\` | ${esc(d.role)} | ${esc(d.content)} | ${esc(d.not)} | ${esc(d.naming)} | ${d.emphasis ? '★' : ''} |`);
  }
  return rows.join('\n');
}

/** 首页目录地图：带每个目录的当前文件数（bootstrap 时还没有索引，写 —）。 */
export function mapTable(dirs, counts) {
  const rows = ['| 目录 | 角色 | 放什么 | 当前文件数 |', '| --- | --- | --- | --- |'];
  for (const d of dirs) {
    const n = counts && counts[d.path] != null ? String(counts[d.path]) : '—';
    rows.push(`| \`${esc(d.path)}/\` | ${esc(d.role)} | ${esc(d.content)} | ${n} |`);
  }
  return rows.join('\n');
}

export function childrenBlock(entry) {
  const kids = entry.children || [];
  if (!kids.length) return '- （本目录不再分子目录，文件直接放在这里）';
  const lines = [];
  for (const k of kids) {
    lines.push(`- \`${k.path}/\` —— ${k.content || ''}`);
    for (const g of k.children || []) {
      lines.push(`    - \`${g.path}/\` —— ${g.content || ''}`);
    }
  }
  return lines.join('\n');
}

export function renderDirReadme({ entry, index, date, year, core, template }) {
  const tpl = template || [
    '---',
    'id: @@ID@@',
    'title: @@DIRNAME@@ 目录说明',
    '---',
    '',
    '# @@DIRNAME@@',
    '',
    '## 这个目录放什么',
    '@@CONTENT@@',
    '',
    '## 不放什么',
    '@@NOT@@',
    '',
    '## 命名规则',
    '@@NAMING@@',
    '',
    '## 子目录',
    '@@CHILDREN@@',
    '',
  ].join('\n');
  const emphasis = entry.emphasis
    ? '> ★ **这是当前岗位/场景的重点目录**，优先维护，别让它空着。'
    : '';
  const rep = {
    '@@ID@@': docId(year, DOC_SLOTS.dirBase + index - 1),
    '@@DIRNAME@@': entry.path,
    '@@ROLE@@': entry.role || '',
    '@@EMPHASIS@@': emphasis,
    '@@OWNER@@': '待定',
    '@@DATE@@': date,
    '@@CONTENT@@': entry.content || '',
    '@@NOT@@': entry.not || '',
    '@@NAMING@@': entry.naming || '',
    '@@CHILDREN@@': childrenBlock(entry),
    '@@L1@@': entry.path,
    '@@L2@@': '待定',
    '@@L3@@': '待定',
    '@@RELATIONS@@': siblingList(core, entry.path),
  };
  let out = tpl;
  for (const [k, v] of Object.entries(rep)) out = out.split(k).join(String(v));
  return out;
}

function fieldTable() {
  const rows = ['| 维度 | 字段 | 类型 | 取值/规则 | 必填 |', '| --- | --- | --- | --- | --- |'];
  const fields = [
    ['① 身份', 'id', 'string', '全库唯一，见《编号与溯源链》', '是'],
    ['① 身份', 'title', 'string', '对象 + 动作/场景 + 结果', '是'],
    ['② 权属', 'author', 'string', '原始提供者', '是'],
    ['② 权属', 'owner', 'string', '维护责任人，未定填「待定」', '是'],
    ['③ 时效', 'created', 'date', 'YYYY-MM-DD', '是'],
    ['③ 时效', 'updated', 'date', 'YYYY-MM-DD', '是'],
    ['③ 时效', 'status', 'enum', 'draft / review / active / deprecated', '是'],
    ['③ 时效', 'review', 'string', '默认 180d，合规类 90d', '是'],
    ['④ 安全', 'confidentiality', 'enum', 'public / internal / restricted / confidential', '是'],
    ['④ 安全', 'rbac', 'string[]', '可读角色组，不区分写 []', '是'],
    ['⑤ 血缘', 'source', 'string', '原始出处或上一环编号', '是'],
    ['⑤ 血缘', 'relations', 'string[]', '关联文档', '是'],
    ['关系', 'project', 'string', '所属项目 P001，无则空', '否'],
    ['关系', 'ref_hypothesis', 'string', '关联假设编号', '否'],
    ['关系', 'ref_experiment', 'string', '关联实验编号', '否'],
    ['状态', 'version', 'string', 'v1.0', '是'],
    ['置信', 'confidence', 'enum', '高 / 中 / 低', '是'],
    ['置信', 'conf_src', 'string[]', '高、中档必填', '按档'],
    ['置信', 'conf_why', 'string', '低档必填', '按档'],
    ['标签', 'l1', 'string', '第一层，互斥单选', '是'],
    ['标签', 'l2', 'string[]', '第二层，多选', '否'],
    ['标签', 'l3', 'string[]', '第三层，多选', '否'],
  ];
  for (const f of fields) rows.push(`| ${f[0]} | \`${f[1]}\` | ${f[2]} | ${esc(f[3])} | ${f[4]} |`);
  return rows.join('\n');
}

function tagTable() {
  const lines = [];
  const desc = [
    ['l1', '第一层 · 业务分类树（互斥单选）'],
    ['l2', '第二层 · 场景与角色（多选）'],
    ['l3', '第三层 · 特征与属性（多选）'],
  ];
  for (const [layer, label] of desc) {
    const vals = BASELINE_TAGS[layer] || [];
    lines.push(`**${label}**：${vals.map((v) => `\`${v}\``).join('、') || '_（待补）_'}`);
  }
  return lines.join('\n');
}

export function renderMoc({ mode, cfg, core, root, date, status, counts }) {
  const specLinks = cfg.specNames
    .map((name) => {
      const meta = SPEC_META[name] || { title: name.replace(/\.md$/, ''), desc: '' };
      return `- ${wikilink(`${cfg.specsDir}/${name}`)} —— ${meta.desc}`;
    })
    .join('\n');
  const tplLinks = TEMPLATE_FILES
    .map((t) => `- ${wikilink(`${cfg.templatesDir}/${t.as}`)}`)
    .join('\n');
  const nextLines = [
    '1. 新东西先扔 `01_收件箱`，每周清一次，判断它属于哪个角色目录；',
    '2. 原始资料不加工，加工后的数据另开文件放「研究与洞察」；',
    '3. 你的判断不是事实——先写进「思考与假设」（编号 `H-`），验证过的才升级为「知识与模型」（`K-`）；',
    '4. 每次实验都留编号 `E-`，结论回填到对应假设，别让链条断掉；',
    '5. 半年级维护跑一次体检，看「溯源链」有没有断链。',
  ].join('\n');
  const table = `${MAP_START}\n${mapTable(core, counts)}\n${MAP_END}`;
  const rep = {
    '@@ROOT@@': root || '',
    '@@INDUSTRY@@': '通用基线（未做行业画像）',
    '@@DATE@@': date,
    '@@STATUS@@': status,
    '@@CLI_MODE@@': '引擎直写（未使用 Obsidian CLI）',
    '@@OWNER@@': '待定',
    '@@DIR_TABLE@@': table,
    '@@SPEC_LINKS@@': specLinks,
    '@@FIELD_TABLE@@': fieldTable(),
    '@@TAG_TABLE@@': tagTable(),
    '@@ATOM@@': ATOM_RULE,
    '@@TPL_LINKS@@': tplLinks,
    '@@NEXT@@': nextLines,
  };
  let out = `# 知识库首页

> 根目录：\`@@ROOT@@\` ｜ mode=${mode} ｜ 建库日期：${date} ｜ 状态：${status}

## 一、这套库按「知识资产的角色」分类

一份内容只有一个主要存放位置，但可以拥有多个标签、双向链接和索引入口。

## 二、目录地图

@@DIR_TABLE@@

## 三、先读这几份规范

@@SPEC_LINKS@@

## 四、字段清单

@@FIELD_TABLE@@

## 五、标签词表

@@TAG_TABLE@@

## 六、笔记粒度

@@ATOM@@

## 七、模板

@@TPL_LINKS@@

## 八、日常怎么用

@@NEXT@@
`;
  for (const [k, v] of Object.entries(rep)) out = out.split(k).join(String(v));
  return out;
}

/** 把首页里的目录地图段替换掉（reindex 用）。找不到标记就追加一段。 */
export function replaceMapSection(text, table) {
  const block = `${MAP_START}\n${table}\n${MAP_END}`;
  if (text.includes(MAP_START) && text.includes(MAP_END)) {
    const start = text.indexOf(MAP_START);
    const end = text.indexOf(MAP_END) + MAP_END.length;
    return text.slice(0, start) + block + text.slice(end);
  }
  return `${text.replace(/\s*$/, '')}\n\n## 目录地图\n\n${block}\n`;
}

export function renderExtraIndex(kind, { cfg, core, presets, date }) {
  const paradigm = presets.paradigm || {};
  if (kind === 'map') {
    const lines = [
      '# 全局知识地图',
      '',
      '> 同一个资产可以从多个入口到达。这张图提供**几条不同的路线**，指向同一批文件——不是几套重复目录。',
      '',
      '## 路线一：按知识生产流程走',
      '',
      '```',
      core.map((d) => d.path).join(' → '),
      '```',
      '',
      '## 路线二：按「六个问题」走',
      '',
      '| 我想回答 | 对应角色目录 |',
      '| --- | --- |',
    ];
    const qMap = ['02_原始资料库', '03_研究与洞察 / 04_思考与假设', '05_验证与证据', '06_知识与模型 / 08_作品与成果', '09_项目与运营', '10_决策与复盘'];
    (paradigm.six_questions || []).forEach((q, i) => {
      lines.push(`| ${esc(q)} | ${qMap[i] || '—'} |`);
    });
    lines.push('', '## 路线三：三个互相独立的分类维度', '');
    for (const [dim, desc] of Object.entries(paradigm.three_dimensions || {})) {
      lines.push(`- **${String(dim).replace(/_/g, ' · ')}**：${desc}`);
    }
    lines.push('', '## 全部目录', '', planTable(core));
    return `${lines.join('\n')}\n`;
  }

  if (kind === 'dirrules') {
    return `${[
      '# 目录分类规则',
      '',
      `> **原则**：${paradigm.principle || ''}`,
      '',
      `> **单一归属**：${paradigm.single_home_rule || ''}`,
      '',
      '## 为什么这样分',
      '',
      paradigm.why || '',
      '',
      '## 三个互相独立的分类维度',
      '',
      '| 维度 | 管什么 | 落在哪 |',
      '| --- | --- | --- |',
      '| 维度一 · 主目录 | 它是什么资产（唯一、互斥） | 文件夹 |',
      '| 维度二 · 主题标签 | 它涉及什么（多选） | frontmatter 的 l1 / l2 / l3 |',
      '| 维度三 · 关系与状态 | 关联什么、进展如何 | project / ref_hypothesis / ref_experiment / status / version |',
      '',
      '## 各目录规则',
      '',
      planTable(core),
    ].join('\n')}\n`;
  }

  if (kind === 'chain') {
    const specLink = wikilink(`${cfg.specsDir}/编号与溯源链.md`);
    return `${[
      '# 知识关系与引用索引',
      '',
      `> 编号前缀、七步流转主链与 \`relations\` 写法的唯一口径见 ${specLink}，本页只放**填写区**与断链清单。`,
      '',
      '## 主链',
      '',
      '```',
      paradigm.chain || '',
      '```',
      '',
      '常见路径，不是强制顺序；回退产生的是**新编号**，旧编号保留。',
      '',
      '## 溯源链总表（一条假设一行，边做边填）',
      '',
      '| 假设 H | 假设陈述 | 研究 S | 原始资料 R | 实验 E | 结论 | 知识 K | 决策 D | 复盘 RT |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| _H-2026-001_ | _例：目标客户愿每月付 499 元_ | _S-2026-006_ | _R-2026-014_ | _E-2026-003_ | _暂时获得支持_ | _K-2026-002_ | _D-2026-007_ | _RT-2026-004_ |',
      '',
      '## 断链待补',
      '',
      '- [ ] 跑一次知识库体检，把「溯源链」告警里的编号补齐或修正。',
      '',
      `> 生成日期：${date}`,
    ].join('\n')}\n`;
  }

  if (kind === 'naming') {
    const lines = ['# 命名与版本规范', '', '## 各目录命名规则', '', '| 目录 | 命名规则 |', '| --- | --- |'];
    for (const d of core) lines.push(`| \`${d.path}/\` | ${esc(d.naming)} |`);
    lines.push(
      '',
      '## 通用规则',
      '',
      '- 文件名不用空格，用 `-` 或 `_` 连接；禁用 `\\ / : * ? " < > |`；',
      '- 中文目录名跟随团队语言，不要为了「专业」用英文；',
      '- 版本号统一 `v1.0` / `v1.1`，写在文件名末尾或 frontmatter 的 `version`；',
      '- `status` 固定四值：`draft` / `review` / `active` / `deprecated`；',
      '- `confidentiality` 固定四值：`public` / `internal` / `restricted` / `confidential`；',
      '- 关联字段：`project` / `ref_hypothesis` / `ref_experiment`；',
      '- 编号前缀 `R/S/H/E/K/D/RT/P/DOC`，全库唯一、不回收。',
      '',
      '> 口径以规范目录下的规范文件为准，本页只是速查。',
    );
    return `${lines.join('\n')}\n`;
  }

  return `${[
    '# 维护及备份规则',
    '',
    '## 每周（10 分钟）',
    '',
    '- [ ] 清空收件箱：每份资料判断「它属于哪个角色」，就地归位；',
    '- [ ] 有明确执行动作的转入项目任务，值得研究的形成研究问题或假设。',
    '',
    '## 每月',
    '',
    '- [ ] 检查进行中的实验有没有结论，把结论回填到对应假设；',
    '- [ ] 把重复出现的判断提炼成知识卡（进「知识与模型」）。',
    '',
    '## 每半年（review: 180d）',
    '',
    '- [ ] 复审 `status=active` 的笔记，过期的标 `deprecated` 并移入归档目录；',
    '- [ ] 复核知识卡的适用条件与已知局限有没有变化；',
    '- [ ] 检查编号链条：`ref_hypothesis` / `ref_experiment` 指向的编号是否都存在。',
    '',
    '## 归档原则',
    '',
    '- 归档 ≠ 删除：留下原始位置、归档时间、归档原因、继任版本链接；',
    '- 仍承担历史证据作用的原始数据与决策记录，优先保持引用稳定（可只标「已归档」不移动）。',
    '',
    '## 备份',
    '',
    '- 整个库目录一起备份（含 `.jkkb/vault.json`），勿只备份笔记文件；',
    '- 涉及客户身份与交易记录的资料，单独做访问控制与脱敏。',
    '',
    `> 建库日期：${date}`,
  ].join('\n')}\n`;
}

/** 模板库里的模板若含 @@KEY@@ 占位，搬进库时改成人能直接填的中文占位（资产里的原文不动）。 */
export function humanizeTemplatePlaceholders(text) {
  return String(text).replace(/@@([A-Z0-9_]+)@@/g, '〈待填：$1〉');
}

export function renderTemplatesReadme(dirName) {
  return `# ${dirName}

模板目录。新建笔记时从这里复制一份到对应业务目录再改，不要在这里写正文。

> 复制后记得改 frontmatter：id / title / author / owner / created / updated /
> status / review / confidentiality / source / relations / l1 / l2 / l3，
> 并填好溯源字段：project / ref_hypothesis / ref_experiment。
`;
}
