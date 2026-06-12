/**
 * MCP tool: learn_preference
 *
 * Store a workflow learning signal. Plays the same role as a `preferences.jsonl`.
 * Stored in mindcairn SQLite as a type='learned_preference' chunk → searchable.
 *
 * Example triggers:
 *   - when a doc-tracing skill missed a page ("in cases like this, also fetch ~")
 *   - when an impact-analysis agent misses a pattern
 *   - when search quality is low ("for queries like this, looking only at type=doc_design gives the answer")
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { embedTexts } from '../../builder/embedder.ts';
import { ensureCollection, upsertPoints } from '../../builder/qdrant.ts';
import type { ChunkStore } from '../../builder/sqlite-store.ts';
import type { Chunk, IndexingStrategy } from '../../types.ts';

export const LearnPreferenceArgs = z.object({
  context: z.string(),    // doc-tracing / impact-analysis / search-quality / ...
  lesson: z.string(),     // one-line rule
  example: z.string().optional(),
  appliesWhen: z.string().optional(),  // when-condition (optional)
});

export type LearnPreferenceInput = z.infer<typeof LearnPreferenceArgs>;

export async function handleLearnPreference(
  args: LearnPreferenceInput,
  strategy: IndexingStrategy,
  collection: string,
  store: ChunkStore,
) {
  const now = new Date().toISOString();
  const id = createHash('sha1')
    .update(`pref|${args.context}|${args.lesson}|${now}`)
    .digest('hex')
    .slice(0, 24);

  const exampleStr = args.example ? `\nexample: ${args.example}` : '';
  const whenStr = args.appliesWhen ? `\nappliesWhen: ${args.appliesWhen}` : '';

  const chunk: Chunk = {
    id,
    type: 'learned_preference',
    embeddingText: `[preference] ${args.context}\n${args.lesson}${exampleStr}${whenStr}`,
    rawContent: `# preference: ${args.context}\n\n${args.lesson}${exampleStr}${whenStr}\n\nlearnedAt: ${now}`,
    metadata: {
      type: 'learned_preference',
      context: args.context,
      lesson: args.lesson,
      example: args.example ?? '',
      appliesWhen: args.appliesWhen ?? '',
      learnedAt: now,
      file: '(learned)',
    },
  };

  store.upsertMany([chunk]);

  // Qdrant embedding
  const [vector] = await embedTexts({
    spec: strategy.embedding,
    texts: [chunk.embeddingText],
  });
  await ensureCollection(collection, strategy.embedding.dimensions);
  await upsertPoints(collection, [
    {
      id: chunk.id,
      vector,
      sparseText: chunk.embeddingText,
      payload: {
        chunkId: chunk.id,
        type: chunk.type,
        context: args.context,
        lesson: args.lesson,
        learnedAt: now,
      },
    },
  ]);

  return {
    content: [
      {
        type: 'text' as const,
        text: `✓ preference saved

id: ${id}
context: ${args.context}
lesson: ${args.lesson}${args.example ? `\nexample: ${args.example}` : ''}${args.appliesWhen ? `\nappliesWhen: ${args.appliesWhen}` : ''}

→ Reflected in search immediately. Accumulates per context and can later be a candidate for auto rule promotion.`,
      },
    ],
  };
}
