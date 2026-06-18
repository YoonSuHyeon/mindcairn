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
import { scoreEvalResult } from './eval-score.ts';

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

  const { recallChunkId, typeMatchRatio, keywordHitRatio, mrr, overall } = scoreEvalResult(
    hitIds,
    stored,
    topK,
    {
      expectedChunkIds: args.expectedChunkIds,
      expectedTypes: args.expectedTypes,
      expectedKeywords: args.expectedKeywords,
    },
  );

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
