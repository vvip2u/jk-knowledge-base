/**
 * SKILL 生命周期纯函数（P2-3）。
 *
 * - normalizeForCompare：小写、去空白/标点/符号、去『的/了/和/与』等虚词；
 * - similarity：Levenshtein 距离归一化到 0..1；
 * - decideCreate：ok / duplicate / similar 三态判定（不碰 IO，便于单测）。
 */
const STOP_CHARS = /[的了和与]/g;
const NOISE = /[\s\p{P}\p{S}]/gu;

export function normalizeForCompare(text) {
  return String(text === null || text === undefined ? '' : text)
    .toLowerCase()
    .replace(STOP_CHARS, '')
    .replace(NOISE, '');
}

/** Levenshtein 距离（两行滚动数组，O(min(m,n)) 空间）。 */
export function levenshtein(a, b) {
  const x = String(a === null || a === undefined ? '' : a);
  const y = String(b === null || b === undefined ? '' : b);
  if (x === y) return 0;
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  let prev = new Array(y.length + 1);
  let curr = new Array(y.length + 1);
  for (let j = 0; j <= y.length; j += 1) prev[j] = j;
  for (let i = 1; i <= x.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= y.length; j += 1) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[y.length];
}

/** 归一化相似度 0..1（1 表示完全相同）。 */
export function similarity(a, b) {
  const x = normalizeForCompare(a);
  const y = normalizeForCompare(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  if (x === y) return 1;
  const distance = levenshtein(x, y);
  return 1 - distance / Math.max(x.length, y.length);
}

export const SIMILAR_THRESHOLD = 0.55;

function matchesOf(existing) {
  if (!Array.isArray(existing)) return [];
  return existing.filter((item) => item && typeof item === 'object' && typeof item.id === 'string');
}

/**
 * @returns {{action:'ok'|'duplicate'|'similar', matches:Array<{id,name,version,purpose,pagePath,score}>}}
 */
export function decideCreate(args) {
  const a = args || {};
  const name = String(a.name === null || a.name === undefined ? '' : a.name).trim();
  const purpose = String(a.purpose === null || a.purpose === undefined ? '' : a.purpose).trim();
  const existing = matchesOf(a.existing);

  const exact = existing.filter((item) => normalizeForCompare(item.name) === normalizeForCompare(name));
  if (exact.length > 0) {
    return {
      action: 'duplicate',
      matches: exact.map((item) => ({
        id: item.id,
        name: item.name,
        version: item.version || '',
        purpose: item.purpose || '',
        pagePath: item.path || item.pagePath || '',
        score: 1,
      })),
    };
  }

  const scored = existing.map((item) => ({
    item: item,
    score: similarity(name + purpose, String(item.name || '') + String(item.purpose || '')),
  })).sort((left, right) => right.score - left.score);

  const similar = scored.filter((entry) => entry.score >= SIMILAR_THRESHOLD);
  if (similar.length > 0) {
    return {
      action: 'similar',
      matches: similar.map((entry) => ({
        id: entry.item.id,
        name: entry.item.name,
        version: entry.item.version || '',
        purpose: entry.item.purpose || '',
        pagePath: entry.item.path || '',
        score: Number(entry.score.toFixed(4)),
      })),
    };
  }
  return { action: 'ok', matches: [] };
}
