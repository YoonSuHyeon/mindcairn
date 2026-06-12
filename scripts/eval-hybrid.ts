/**
 * dense-only vs hybrid quantitative evaluation (Hit@5 + MRR).
 *   bun run scripts/eval-hybrid.ts [tag]
 * ground truth = chunks that actually contain the identifier (sqlite LIKE) → objectively measured by whether they land in the search top5.
 * CASES is an example — replace with identifier/natural-language queries from your own codebase.
 */
import { Database } from 'bun:sqlite';
import { embedTexts } from '../src/builder/embedder.ts';
import { toSparse } from '../src/builder/bm25.ts';

const HOST = process.env.MINDCAIRN_QDRANT_HOST ?? 'http://localhost:6333';
const TAG = process.argv[2] ?? 'my-project';
const SRC = 'mindcairn_' + TAG.replace(/[^a-zA-Z0-9_]/g, '_');
const DST = SRC + '_hybrid';
const MODEL = process.env.MINDCAIRN_EMBED_MODEL ?? 'bge-m3';
const K = 5;
const db = new Database(`.mindcairn/${TAG}/chunks.sqlite`, { readonly: true });

// Example cases — replace with identifiers/queries that actually exist in your own codebase.
// `kind` pairs an exact-symbol query (identifier) with a paraphrase (natural-language) for the same answer.
const CASES = [
  { q: 'cancelExpiredOrders', ans: 'cancelExpiredOrders', kind: 'identifier' },
  { q: 'bulk-cancel expired orders', ans: 'cancelExpiredOrders', kind: 'natural-language' },
  { q: 'searchOrderHistory', ans: 'searchOrderHistory', kind: 'identifier' },
  { q: 'order history filter sort paging query', ans: 'searchOrderHistory', kind: 'natural-language' },
  { q: 'forceRefund', ans: 'ForceRefund', kind: 'identifier' },
  { q: 'force-refund an order', ans: 'ForceRefund', kind: 'natural-language' },
  { q: 'ViewCount flush', ans: 'ViewCount', kind: 'identifier' },
  { q: 'view-count aggregation batch', ans: 'ViewCount', kind: 'natural-language' },
];

function answerIds(kw: string): Set<string> {
  const rows = db
    .query('SELECT id FROM chunks WHERE raw_content LIKE ? OR embedding_text LIKE ?')
    .all(`%${kw}%`, `%${kw}%`) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/** Best rank (1-based) of the correct originalId in the hits array, or 0 if absent. */
function bestRank(hits: Array<{ payload: Record<string, unknown> }>, ans: Set<string>): number {
  for (let i = 0; i < hits.length; i++) {
    if (ans.has(hits[i].payload.originalId as string)) return i + 1;
  }
  return 0;
}

async function dense(vec: number[]) {
  const r = await fetch(`${HOST}/collections/${SRC}/points/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector: vec, limit: K, with_payload: true }),
  });
  return (await r.json()).result as Array<{ payload: Record<string, unknown> }>;
}
async function hybrid(vec: number[], sp: { indices: number[]; values: number[] }) {
  const r = await fetch(`${HOST}/collections/${DST}/points/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prefetch: [
        { query: vec, using: 'dense', limit: 30 },
        { query: { indices: sp.indices, values: sp.values }, using: 'bm25', limit: 30 },
      ],
      query: { fusion: 'rrf' }, limit: K, with_payload: true,
    }),
  });
  return (await r.json()).result.points as Array<{ payload: Record<string, unknown> }>;
}

const agg = { identifier: { d: [], h: [] }, 'natural-language': { d: [], h: [] } } as Record<string, { d: number[]; h: number[] }>;
console.log(`case | dense rank | hybrid rank   (rank=correct-answer top5 rank, ·=miss)`);
console.log('─'.repeat(64));
for (const c of CASES) {
  const ans = answerIds(c.ans);
  const [vec] = await embedTexts({ model: MODEL, texts: [c.q] });
  const sp = toSparse(c.q);
  const dr = bestRank(await dense(vec), ans);
  const hr = bestRank(await hybrid(vec, sp), ans);
  agg[c.kind].d.push(dr ? 1 / dr : 0);
  agg[c.kind].h.push(hr ? 1 / hr : 0);
  const f = (n: number) => (n ? `#${n}` : '·');
  console.log(`[${c.kind}] ${c.q.slice(0, 28).padEnd(30)} ${f(dr).padStart(8)} ${f(hr).padStart(10)}  (${ans.size} correct chunks)`);
}
console.log('─'.repeat(64));
const mrr = (a: number[]) => (a.reduce((s, x) => s + x, 0) / a.length);
const hit = (a: number[]) => (a.filter((x) => x > 0).length / a.length);
for (const k of ['identifier', 'natural-language']) {
  const { d, h } = agg[k];
  console.log(`${k}: MRR dense ${mrr(d).toFixed(3)} → hybrid ${mrr(h).toFixed(3)} | Hit@5 dense ${(hit(d) * 100).toFixed(0)}% → hybrid ${(hit(h) * 100).toFixed(0)}%`);
}
const allD = [...agg.identifier.d, ...agg['natural-language'].d], allH = [...agg.identifier.h, ...agg['natural-language'].h];
console.log(`overall: MRR dense ${mrr(allD).toFixed(3)} → hybrid ${mrr(allH).toFixed(3)} | Hit@5 dense ${(hit(allD) * 100).toFixed(0)}% → hybrid ${(hit(allH) * 100).toFixed(0)}%`);
