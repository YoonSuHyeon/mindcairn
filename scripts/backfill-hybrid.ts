/**
 * Clone an existing dense collection into a new dense+sparse hybrid collection (zero re-embedding).
 *   bun run scripts/backfill-hybrid.ts [tag]
 * The existing mindcairn_<tag> collection is left untouched (safe rollback). Dense vectors are copied as-is via scroll,
 * only the sparse (bm25) part is freshly generated from the sqlite chunk source text and attached.
 */
import { Database } from 'bun:sqlite';
import { toSparse } from '../src/builder/bm25.ts';

const HOST = process.env.MINDCAIRN_QDRANT_HOST ?? 'http://localhost:6333';
const TAG = process.argv[2] ?? 'my-project';
const SRC = 'mindcairn_' + TAG.replace(/[^a-zA-Z0-9_]/g, '_');
const DST = SRC + '_hybrid';
const SQLITE = '.mindcairn/' + TAG + '/chunks.sqlite';

const db = new Database(SQLITE, { readonly: true });
const rows = db
  .query('SELECT id, embedding_text, raw_content FROM chunks')
  .all() as Array<{ id: string; embedding_text: string; raw_content: string }>;
const textById = new Map(
  rows.map((r) => [r.id, `${r.embedding_text ?? ''}\n${r.raw_content ?? ''}`]),
);
console.log(`loaded ${textById.size} sqlite chunk texts`);

// 1) Recreate DST (dense named "dense" + sparse "bm25" idf)
await fetch(`${HOST}/collections/${DST}`, { method: 'DELETE' });
const create = await fetch(`${HOST}/collections/${DST}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    vectors: { dense: { size: 1024, distance: 'Cosine' } },
    sparse_vectors: { bm25: { modifier: 'idf' } },
  }),
});
if (!create.ok) throw new Error(`DST creation failed: ${create.status} ${await create.text()}`);
console.log(`${DST} created (dense 1024 + sparse bm25/idf)`);

// 2) SRC scroll → copy dense + generate sparse → DST upsert
let offset: unknown = undefined;
let total = 0;
let missingText = 0;
do {
  const res = await fetch(`${HOST}/collections/${SRC}/points/scroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 256, with_payload: true, with_vector: true, offset }),
  });
  const j = (await res.json()).result as {
    points: Array<{ id: string | number; vector: number[]; payload: Record<string, unknown> }>;
    next_page_offset: unknown;
  };
  offset = j.next_page_offset;
  const points = j.points.map((p) => {
    const oid = (p.payload.originalId as string) ?? '';
    const text = textById.get(oid) ?? '';
    if (!text) missingText++;
    const sp = toSparse(text || (oid || ''));
    return {
      id: p.id,
      vector: {
        dense: p.vector,
        bm25: { indices: sp.indices, values: sp.values },
      },
      payload: p.payload,
    };
  });
  const up = await fetch(`${HOST}/collections/${DST}/points?wait=true`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points }),
  });
  if (!up.ok) throw new Error(`upsert failed: ${up.status} ${await up.text()}`);
  total += points.length;
  process.stdout.write(`\rcopied ${total}...`);
} while (offset);

console.log(`\ndone: ${total} points (sparse generated). chunks with no text found: ${missingText}`);
