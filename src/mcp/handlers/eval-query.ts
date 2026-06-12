/**
 * MCP tool: eval_query
 *
 * Search-quality evaluation — score a query's results against expected values.
 * A golden-set-based regression alert + self-tuning signal.
 *
 * Results are appended to `.mindcairn/<tag>/evals.jsonl`. Used in the next eval/retro cycle.
 */

import { z } from 'zod';
import { join } from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
import { embedTexts } from '../../builder/embedder.ts';
import { searchPoints } from '../../builder/qdrant.ts';
import type { ChunkStore } from '../../builder/sqlite-store.ts';
import type { IndexingStrategy } from '../../types.ts';
import { config } from '../../config.ts';

export const EvalQueryArgs = z.object({
  query: z.string(),
  expectedChunkIds: z.array(z.string()).optional(),
  expectedTypes: z.array(z.string()).optional(),
  expectedKeywords: z.array(z.string()).optional(),
  topK: z.number().optional(),
  label: z.string().optional(),
});

export type EvalQueryInput = z.infer<typeof EvalQueryArgs>;

export async function handleEvalQuery(
  args: EvalQueryInput,
  tag: string,
  strategy: IndexingStrategy,
  collection: string,
  store: ChunkStore,
) {
  const topK = args.topK ?? 10;
  const [vec] = await embedTexts({ spec: strategy.embedding, texts: [args.query] });
  const hits = await searchPoints(collection, vec, topK);
  const hitIds = hits.map((h) => String(h.payload.chunkId ?? ''));
  const stored = store.getMany(hitIds);

  // 1. recall@K — expected chunkId
  let recallChunkId = 0;
  if (args.expectedChunkIds?.length) {
    const found = hitIds.filter((id) => args.expectedChunkIds!.includes(id));
    recallChunkId = found.length / args.expectedChunkIds.length;
  }

  // 2. type-distribution match
  let typeMatchRatio = 0;
  if (args.expectedTypes?.length) {
    const hitTypes = stored.map((s) => s.type);
    const matched = hitTypes.filter((t) => args.expectedTypes!.includes(t));
    typeMatchRatio = matched.length / topK;
  }

  // 3. keyword match — whether expected keywords appear in raw_content + label
  let keywordHitRatio = 0;
  if (args.expectedKeywords?.length) {
    const haystack = stored
      .map((s) => `${s.enrichedLabel ?? ''}\n${s.rawContent}`.toLowerCase())
      .join('\n');
    const found = args.expectedKeywords.filter((k) => haystack.includes(k.toLowerCase()));
    keywordHitRatio = found.length / args.expectedKeywords.length;
  }

  // 4. MRR — rank of the first expected chunkId
  let mrr = 0;
  if (args.expectedChunkIds?.length) {
    for (let i = 0; i < hitIds.length; i++) {
      if (args.expectedChunkIds.includes(hitIds[i])) {
        mrr = 1 / (i + 1);
        break;
      }
    }
  }

  // overall score (average)
  const scoreParts: number[] = [];
  if (args.expectedChunkIds?.length) scoreParts.push(recallChunkId, mrr);
  if (args.expectedTypes?.length) scoreParts.push(typeMatchRatio);
  if (args.expectedKeywords?.length) scoreParts.push(keywordHitRatio);
  const overall = scoreParts.length
    ? scoreParts.reduce((a, b) => a + b, 0) / scoreParts.length
    : 0;

  // record the result (jsonl)
  const evalDir = join(process.cwd(), config.output.dir, tag);
  await mkdir(evalDir, { recursive: true }).catch(() => {});
  const evalPath = join(evalDir, 'evals.jsonl');
  const record = {
    at: new Date().toISOString(),
    label: args.label ?? null,
    query: args.query,
    topK,
    overall,
    recallChunkId,
    typeMatchRatio,
    keywordHitRatio,
    mrr,
    hits: hits.slice(0, 5).map((h, i) => ({
      rank: i + 1,
      score: h.score,
      chunkId: h.payload.chunkId,
      type: h.payload.type,
    })),
    expected: {
      chunkIds: args.expectedChunkIds ?? [],
      types: args.expectedTypes ?? [],
      keywords: args.expectedKeywords ?? [],
    },
  };
  await appendFile(evalPath, JSON.stringify(record) + '\n', 'utf-8');

  const summary = `# eval: "${args.query}"  (label: ${args.label ?? '-'})

overall:           ${(overall * 100).toFixed(1)}%
recall(chunkId):   ${(recallChunkId * 100).toFixed(1)}%
typeMatch:         ${(typeMatchRatio * 100).toFixed(1)}%
keywordHit:        ${(keywordHitRatio * 100).toFixed(1)}%
MRR:               ${mrr.toFixed(3)}

top hits:
${hits
  .slice(0, 5)
  .map(
    (h, i) =>
      `  ${i + 1}. [${h.payload.type}] score=${h.score.toFixed(3)}  ${h.payload.label ?? h.payload.title ?? ''}`,
  )
  .join('\n')}

→ logged to .mindcairn/${tag}/evals.jsonl`;

  return { content: [{ type: 'text' as const, text: summary }] };
}
