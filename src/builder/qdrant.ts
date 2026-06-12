/**
 * Qdrant HTTP client (hybrid: dense 'dense' + sparse 'bm25'/idf).
 * dense = embedding provider (ollama/openai), sparse = BM25 (code + Korean tokens; IDF is applied by Qdrant).
 */

import { createHash } from 'node:crypto';
import { toSparse } from './bm25.ts';

const QDRANT_HOST = process.env.MINDCAIRN_QDRANT_HOST ?? 'http://localhost:6333';

/** tag → Qdrant collection name. build / serve / scripts all use this function (avoids name mismatch). */
export function collectionName(tag: string): string {
  return `mindcairn_${tag.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

/** fetch wrapper — on connection failure, the error includes "how to start it" guidance. */
async function qfetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${QDRANT_HOST}${path}`, init);
  } catch (e) {
    throw new Error(
      `Failed to connect to Qdrant (${QDRANT_HOST}).\n` +
        `  Start: docker compose up -d   (docker-compose.yml at the mindcairn root — single Qdrant service)\n` +
        `  For a different host, set MINDCAIRN_QDRANT_HOST.\n` +
        `  Cause: ${(e as Error).message}`,
    );
  }
}

export async function ensureCollection(name: string, dim: number) {
  const res = await qfetch(`/collections/${name}`);
  if (res.ok) return;
  const create = await qfetch(`/collections/${name}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vectors: { dense: { size: dim, distance: 'Cosine' } },
      sparse_vectors: { bm25: { modifier: 'idf' } },
    }),
  });
  if (!create.ok) {
    throw new Error(`Qdrant create collection failed: ${create.status} ${await create.text()}`);
  }
}

export async function deleteCollection(name: string) {
  await qfetch(`/collections/${name}`, { method: 'DELETE' });
}

/** Delete all points matching the payload filter (for cleaning up stale bodies in ingest_doc). */
export async function deletePointsByFilter(
  collection: string,
  filter: Record<string, unknown>,
) {
  const res = await qfetch(`/collections/${collection}/points/delete?wait=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter }),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Qdrant delete by filter failed: ${res.status} ${await res.text()}`);
  }
}

export type UpsertPoint = {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
  /** Text for generating the BM25 sparse vector (if absent, sparse is empty — dense only). */
  sparseText?: string;
};

export async function upsertPoints(collection: string, points: UpsertPoint[]) {
  // Qdrant ids must be uint64 or UUID. Our chunk ids are arbitrary strings → UUID-like hash.
  const body = {
    points: points.map((p) => {
      const sp = toSparse(p.sparseText ?? '');
      return {
        id: idToUuid(p.id),
        vector: {
          dense: p.vector,
          bm25: { indices: sp.indices, values: sp.values },
        },
        payload: { ...p.payload, originalId: p.id },
      };
    }),
  };
  const res = await qfetch(`/collections/${collection}/points?wait=true`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Qdrant upsert failed: ${res.status} ${await res.text()}`);
  }
}

/** Dense-only search (named 'dense'). For eval/debug. Use hybridSearch for normal search. */
export async function searchPoints(
  collection: string,
  vector: number[],
  topK: number,
  filter?: Record<string, unknown>,
): Promise<Array<{ score: number; payload: Record<string, unknown> }>> {
  const res = await qfetch(`/collections/${collection}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vector: { name: 'dense', vector },
      limit: topK,
      with_payload: true,
      filter,
    }),
  });
  if (!res.ok) {
    throw new Error(`Qdrant search failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    result: Array<{ score: number; payload: Record<string, unknown> }>;
  };
  return json.result;
}

/** Hybrid search: dense + BM25 (sparse) prefetch → RRF fusion. Generates sparse from queryText. */
export async function hybridSearch(
  collection: string,
  denseVec: number[],
  queryText: string,
  topK: number,
  filter?: Record<string, unknown>,
): Promise<Array<{ score: number; payload: Record<string, unknown> }>> {
  const sp = toSparse(queryText);
  const pre = Math.max(topK * 4, 30);
  const res = await qfetch(`/collections/${collection}/points/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prefetch: [
        { query: denseVec, using: 'dense', limit: pre, filter },
        { query: { indices: sp.indices, values: sp.values }, using: 'bm25', limit: pre, filter },
      ],
      query: { fusion: 'rrf' },
      limit: topK,
      with_payload: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`Qdrant hybrid query failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    result: { points: Array<{ score: number; payload: Record<string, unknown> }> };
  };
  return json.result.points;
}

/** Arbitrary string → UUID-like (RFC format). Accepted by Qdrant. */
function idToUuid(s: string): string {
  const h = createHash('sha1').update(s).digest('hex').slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
