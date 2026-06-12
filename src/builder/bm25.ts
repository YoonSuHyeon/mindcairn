/**
 * BM25 sparse vector — term-frequency sparse after tokenizing code identifiers + Korean.
 * Qdrant sparse (modifier: 'idf') multiplies in the IDF, so here we emit raw TF only.
 * token → index via a hashing trick (FNV-1a 32bit) without a vocabulary. (low collision rate, acceptable for BM25)
 */

const STOP = new Set([
  'the', 'a', 'an', 'is', 'to', 'of', 'in', 'and', 'or', 'for', 'on', 'as',
  'val', 'var', 'fun', 'return', 'this', 'it', 'by', 'with', 'at', 'be',
]);

/** Tokenize code + Korean. Splits camelCase/snake_case + keeps the original identifier + Korean chunks. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const raw = text.match(/[A-Za-z0-9_]+|[가-힣]+/g) ?? [];
  for (const tok of raw) {
    if (/[가-힣]/.test(tok)) {
      if (tok.length >= 2) out.push(tok);
      continue;
    }
    // split on camelCase / ACRONYMWord / snake_case / digit boundaries
    const parts = tok
      .replace(/_/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/\s+/);
    for (const p of parts) {
      const low = p.toLowerCase();
      if (low.length >= 2 && !STOP.has(low)) out.push(low);
    }
    // also keep the original identifier (for exact matching: a whole token like cancelExpiredOrders)
    const full = tok.toLowerCase();
    if (full.length >= 3 && full !== (out[out.length - 1] ?? '')) out.push(full);
  }
  return out;
}

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0; // positive 32bit
}

/** Text → Qdrant sparse vector { indices, values=TF }. */
export function toSparse(text: string): { indices: number[]; values: number[] } {
  const tf = new Map<number, number>();
  for (const t of tokenize(text)) {
    const idx = fnv1a(t);
    tf.set(idx, (tf.get(idx) ?? 0) + 1);
  }
  const indices = [...tf.keys()];
  const values = indices.map((i) => tf.get(i)!);
  return { indices, values };
}
