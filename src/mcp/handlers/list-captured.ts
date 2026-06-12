/**
 * MCP tool: list_captured
 *
 * Return captured_decision chunks filtered by period/kind/domain.
 * Used for the /mindcairn-start mode ⑤ (retro) and for reviewing design-decision promotion candidates in task-review.
 */

import { z } from 'zod';
import type { ChunkStore, StoredChunk } from '../../builder/sqlite-store.ts';

export const ListCapturedArgs = z.object({
  since: z.string().optional(),    // ISO date
  until: z.string().optional(),
  kind: z.string().optional(),     // decision / fact / intent / incident / spec / preference
  domain: z.string().optional(),
  limit: z.number().optional(),
});

export type ListCapturedInput = z.infer<typeof ListCapturedArgs>;

export async function handleListCaptured(args: ListCapturedInput, store: ChunkStore) {
  const items = store.listCaptured({
    since: args.since,
    until: args.until,
    kind: args.kind,
    domain: args.domain,
    limit: args.limit,
  });
  if (items.length === 0) {
    return {
      content: [{ type: 'text' as const, text: '(no captured results)' }],
    };
  }
  return { content: [{ type: 'text' as const, text: renderCaptured(args, items) }] };
}

function renderCaptured(args: ListCapturedInput, items: StoredChunk[]): string {
  const filter = [
    args.since ? `since=${args.since}` : '',
    args.until ? `until=${args.until}` : '',
    args.kind ? `kind=${args.kind}` : '',
    args.domain ? `domain=${args.domain}` : '',
  ]
    .filter(Boolean)
    .join('  ');

  // group by domain × kind
  const byDomain: Record<string, StoredChunk[]> = {};
  for (const c of items) {
    const d = (c.metadata.domain as string) || '(no-domain)';
    (byDomain[d] ??= []).push(c);
  }

  const sections: string[] = [];
  for (const [domain, list] of Object.entries(byDomain)) {
    const lines = list.map((c) => {
      const title = (c.metadata.title as string) || '?';
      const kind = (c.metadata.kind as string) || 'decision';
      const at = (c.metadata.capturedAt as string) || '';
      const label = c.enrichedLabel ?? '';
      return `- [${kind}] **${title}**  (${at.slice(0, 10)})${label ? `\n    ${label}` : ''}`;
    });
    sections.push(`## domain: ${domain}\n${lines.join('\n')}`);
  }

  return `# captured results (${items.length})  ${filter ? `[${filter}]` : ''}

${sections.join('\n\n')}`;
}
