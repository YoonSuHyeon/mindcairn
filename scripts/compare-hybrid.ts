/**
 * dense-only (existing SRC) vs hybrid (new DST) search comparison.
 *   bun run scripts/compare-hybrid.ts [tag]
 * Using identifier/abbreviation-heavy queries, see what hybrid (BM25+dense) catches better than dense alone.
 */
import { embedTexts } from '../src/builder/embedder.ts';
import { toSparse } from '../src/builder/bm25.ts';

const HOST = process.env.MINDCAIRN_QDRANT_HOST ?? 'http://localhost:6333';
const TAG = process.argv[2] ?? 'my-project';
const SRC = 'mindcairn_' + TAG.replace(/[^a-zA-Z0-9_]/g, '_');
const DST = SRC + '_hybrid';
const MODEL = process.env.MINDCAIRN_EMBED_MODEL ?? 'bge-m3';
const TOPK = 5;

// Example queries — replace with identifiers/natural language from your own codebase.
const QUERIES = [
  'cancelExpiredOrders',                  // exact function name (identifier)
  'OrderItem failure handling',           // identifier + natural language
  'OrderStatus SELECT filtering',         // enum value + natural language
  'bulk-cancel expired orders',           // pure natural language (dense's strong area)
  'redisson getMap viewCount flush',      // library identifier combination
];

function label(p: Record<string, unknown>): string {
  const f = (p.file as string) ?? (p.path as string) ?? '?';
  const l =
    (p.enrichedLabel as string) ??
    (p.enriched_label as string) ??
    (p.label as string) ??
    (p.method_name as string) ??
    (p.class_name as string) ??
    (p.type as string) ??
    '';
  const file = f.split('/').slice(-1)[0];
  return `${file}  ${l}`.trim();
}

async function denseOnly(vec: number[]) {
  const res = await fetch(`${HOST}/collections/${SRC}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector: vec, limit: TOPK, with_payload: true }),
  });
  return ((await res.json()).result as Array<{ score: number; payload: Record<string, unknown> }>);
}

async function hybrid(vec: number[], sp: { indices: number[]; values: number[] }) {
  const res = await fetch(`${HOST}/collections/${DST}/points/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prefetch: [
        { query: vec, using: 'dense', limit: 30 },
        { query: { indices: sp.indices, values: sp.values }, using: 'bm25', limit: 30 },
      ],
      query: { fusion: 'rrf' },
      limit: TOPK,
      with_payload: true,
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`hybrid query failed: ${res.status} ${JSON.stringify(j)}`);
  return (j.result.points as Array<{ score: number; payload: Record<string, unknown> }>);
}

for (const q of QUERIES) {
  const [vec] = await embedTexts({ model: MODEL, texts: [q] });
  const sp = toSparse(q);
  const [d, h] = await Promise.all([denseOnly(vec), hybrid(vec, sp)]);
  console.log(`\n══════════ "${q}" ══════════`);
  console.log('  [dense only]');
  d.forEach((r, i) => console.log(`   ${i + 1}. ${label(r.payload)}`));
  console.log('  [hybrid BM25+dense]');
  h.forEach((r, i) => console.log(`   ${i + 1}. ${label(r.payload)}`));
}
