/**
 * MCP tool: get_chunk
 *
 * Return a chunk's full body by chunkId (no truncation).
 * search_codebase / find_pattern responses are 2000-char slices — use this for details.
 *
 * Example uses:
 *   - inspect one chunk in detail after semantic search in a code-less environment
 *   - debug mindcairn chunk quality (check label vs body consistency)
 */

import { z } from 'zod';
import type { ChunkStore } from '../../builder/sqlite-store.ts';

export const GetChunkArgs = z.object({
  id: z.string(),
});

export type GetChunkInput = z.infer<typeof GetChunkArgs>;

export async function handleGetChunk(args: GetChunkInput, store: ChunkStore) {
  const c = store.get(args.id);
  if (!c) {
    return {
      content: [{ type: 'text' as const, text: `(no chunk found for id="${args.id}")` }],
      isError: true,
    };
  }
  const metaLines = Object.entries(c.metadata)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('\n');

  const text = `# chunk: ${c.id}

type:  ${c.type}
file:  ${c.file ?? '(n/a)'}
class: ${c.className ?? '(n/a)'}
method: ${c.methodName ?? '(n/a)'}

## Label (enriched)
${c.enrichedLabel ?? '(no label)'}

## Metadata
${metaLines}

## Embedding text (Qdrant input)
\`\`\`
${c.embeddingText}
\`\`\`

## Body (raw — no truncation, ${c.rawContent.length} chars)
\`\`\`
${c.rawContent}
\`\`\``;

  return { content: [{ type: 'text' as const, text }] };
}
