/**
 * MCP tool: ingest_doc
 *
 * Instantly index an external doc (e.g. a Notion body) into mindcairn.
 * Can be called automatically right after a doc update via a Claude Code PostToolUse hook, etc.
 *
 * Flow:
 *   1) split the body into H2/H3 sections (skip those under 30 chars)
 *   2) frontmatter → classifyKind (instance rule) → decide chunker type
 *   3) delete existing chunks with the same externalId (remove stale body)
 *   4) attach a Rich Label + identifiers via the enricher
 *   5) SQLite upsert + Qdrant upsert
 *
 * Result: reflected in search within ~5s.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { embedTexts } from '../../builder/embedder.ts';
import { enrichChunks } from '../../builder/enricher.ts';
import { ensureCollection, deletePointsByFilter, upsertPoints } from '../../builder/qdrant.ts';
import type { ChunkStore } from '../../builder/sqlite-store.ts';
import type { Chunk, IndexingStrategy } from '../../types.ts';

export const IngestDocArgs = z.object({
  source: z.string(),                          // 'notion' | 'meeting' | 'wiki' | ...
  externalId: z.string(),                      // notion pageId
  title: z.string(),
  body: z.string(),                            // markdown
  frontmatter: z.record(z.string()).optional(),
  taskId: z.string().optional(),
  url: z.string().optional(),
});

export type IngestDocInput = z.infer<typeof IngestDocArgs>;

/**
 * Canonical doc metadata, decoupled from any single source's (e.g. Notion) column names.
 * Each instance maps its own frontmatter keys to these fields in notion-rules.ts.
 */
export type DocMeta = {
  docType?: string;    // e.g. spec / design / qa / ops
  job?: string;        // e.g. backend / frontend / data
  status?: string;     // e.g. done / in-progress
  owners?: string;
  plannedAt?: string;
  executedAt?: string;
  taskId?: string;
};

type ClassifyKind = (fm: Record<string, string>) => string;
type ExtractDocMeta = (fm: Record<string, string>) => DocMeta;
type NotionRules = { classifyKind: ClassifyKind; extractDocMeta: ExtractDocMeta };

const defaultClassifyKind: ClassifyKind = () => 'doc_misc';
const defaultExtractDocMeta: ExtractDocMeta = () => ({});

/**
 * Dynamically load per-instance notion-rules (defaults if absent or undefined).
 * notion-rules.ts may export `classifyKind` and/or `extractDocMeta` — the core stays
 * source-agnostic, and each instance maps its own (possibly non-English) column names.
 */
async function loadNotionRules(tag: string): Promise<NotionRules> {
  try {
    const mod = await import(`../../../instances/${tag}/notion-rules.ts`);
    return {
      classifyKind: typeof mod.classifyKind === 'function' ? mod.classifyKind : defaultClassifyKind,
      extractDocMeta: typeof mod.extractDocMeta === 'function' ? mod.extractDocMeta : defaultExtractDocMeta,
    };
  } catch {
    return { classifyKind: defaultClassifyKind, extractDocMeta: defaultExtractDocMeta };
  }
}

type Section = { title: string; content: string; level: number };

function splitBySections(body: string): Section[] {
  const sections: Section[] = [];
  const lines = body.split('\n');
  let cur: Section | null = null;
  for (const line of lines) {
    const h = line.match(/^(#{2,3})\s+(.+)$/);
    if (h) {
      if (cur) sections.push(cur);
      cur = { title: h[2].trim(), content: '', level: h[1].length };
    } else if (cur) {
      cur.content += line + '\n';
    }
  }
  if (cur) sections.push(cur);
  return sections;
}

/**
 * Fallback for pages with no H2/H3 sections — most task-DB rows are short bodies without headings.
 * Bundle the preamble (body before the first heading) + a frontmatter property summary into a single 'Overview' section.
 */
function withOverview(
  sections: Section[],
  body: string,
  fm: Record<string, string>,
): Section[] {
  if (sections.length > 0) return sections;
  const preamble = (body.split(/^#{2,3}\s+/m)[0] ?? '').trim();
  const SKIP_KEYS = new Set(['title', 'url', 'pageId', 'taskId', 'notionDb']);
  const props = Object.entries(fm)
    .filter(([k, v]) => v && !SKIP_KEYS.has(k))
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const content = [preamble, props].filter(Boolean).join('\n\n');
  if (content.trim().length < 30) return sections;
  return [{ title: 'Overview', content, level: 2 }];
}

function chunkId(externalId: string, sectionTitle: string): string {
  return createHash('sha1').update(`${externalId}|${sectionTitle}`).digest('hex').slice(0, 24);
}

export async function handleIngestDoc(
  args: IngestDocInput,
  tag: string,
  strategy: IndexingStrategy,
  collection: string,
  store: ChunkStore,
) {
  const rules = await loadNotionRules(tag);
  const fm = args.frontmatter ?? {};
  const kind = rules.classifyKind(fm);
  const docMeta = rules.extractDocMeta(fm);
  const sections = withOverview(splitBySections(args.body), args.body, fm);

  if (sections.length === 0) {
    return {
      content: [
        { type: 'text' as const, text: `(skipped) "${args.title}" — no H2/H3 sections and body/properties under 30 chars` },
      ],
    };
  }

  // 1) delete existing chunks with the same externalId (remove stale)
  const removedFromSqlite = store.deleteByMetadata('externalId', args.externalId);
  try {
    await deletePointsByFilter(collection, {
      must: [{ key: 'externalId', match: { value: args.externalId } }],
    });
  } catch {
    /* Qdrant collection may be empty or have no payload index. Ignore. */
  }

  // 2) create new chunks
  const chunks: Chunk[] = [];
  for (const sec of sections) {
    const text = sec.content.trim();
    if (text.length < 30) continue;
    const id = chunkId(args.externalId, sec.title);
    // docMeta is canonical (source-agnostic); the instance's notion-rules maps its own column names.
    const tags = [
      docMeta.docType ? `type:${docMeta.docType}` : '',
      docMeta.job ? `role:${docMeta.job}` : '',
      docMeta.status ? `status:${docMeta.status}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    chunks.push({
      id,
      type: kind,
      embeddingText: `[${kind}] ${args.title} > ${sec.title}\n${tags}\n${text.slice(0, 2000)}`,
      rawContent: `## ${sec.title}\n${text}`,
      metadata: {
        type: kind,
        source: args.source,
        externalId: args.externalId,
        url: args.url ?? '',
        pageTitle: args.title,
        title: sec.title,
        level: sec.level,
        taskId: args.taskId ?? docMeta.taskId ?? '',
        status: docMeta.status ?? '',
        docType: docMeta.docType ?? '',
        job: docMeta.job ?? '',
        owners: docMeta.owners ?? '',
        plannedAt: docMeta.plannedAt ?? '',
        executedAt: docMeta.executedAt ?? '',
        ingestedAt: new Date().toISOString(),
        file: `(ingest:${args.source})`,
      },
    });
  }

  if (chunks.length === 0) {
    return {
      content: [
        { type: 'text' as const, text: `(skipped) "${args.title}" — only sections with bodies under 30 chars` },
      ],
    };
  }

  // 3) Enrich (Haiku)
  const enriched = await enrichChunks({ chunks, concurrency: 4 });

  // 4) SQLite store
  store.upsertMany(enriched.enrichedChunks);

  // 5) embedding — label + identifiers only (follows the builder.ts pattern)
  const embedTextsToSend = enriched.enrichedChunks.map((c) => {
    const label = (c.metadata?.enrichedLabel as string) ?? '';
    const ids = (c.metadata?.identifiers as Record<string, unknown> | undefined) ?? {};
    const parts: string[] = [`[${c.type}]`];
    if (label) parts.push(`label: ${label}`);
    if (ids.className) parts.push(`class: ${ids.className}`);
    if (Array.isArray(ids.methods) && ids.methods.length) parts.push(`methods: ${ids.methods.join(' ')}`);
    if (Array.isArray(ids.columns) && ids.columns.length) parts.push(`columns: ${ids.columns.join(' ')}`);
    if (Array.isArray(ids.tables) && ids.tables.length) parts.push(`tables: ${ids.tables.join(' ')}`);
    if (Array.isArray(ids.keywords) && ids.keywords.length) parts.push(`keywords: ${ids.keywords.join(' ')}`);
    if (parts.length === 1) parts.push(c.embeddingText);
    return parts.join('\n');
  });
  const vectors = await embedTexts({
    spec: strategy.embedding,
    texts: embedTextsToSend,
    concurrency: 4,
  });

  // 6) Qdrant upsert
  await ensureCollection(collection, strategy.embedding.dimensions);
  await upsertPoints(
    collection,
    enriched.enrichedChunks.map((c, i) => ({
      id: c.id,
      vector: vectors[i],
      sparseText: embedTextsToSend[i],
      payload: {
        chunkId: c.id,
        type: c.type,
        source: args.source,
        externalId: args.externalId,
        taskId: args.taskId ?? '',
        label: c.metadata?.enrichedLabel,
        pageTitle: args.title,
        title: c.metadata?.title,
      },
    })),
  );

  const kindDist: Record<string, number> = {};
  for (const c of enriched.enrichedChunks) {
    kindDist[c.type] = (kindDist[c.type] ?? 0) + 1;
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: `✓ ingested "${args.title}"

source: ${args.source}  externalId: ${args.externalId}  ${args.taskId ? `taskId: ${args.taskId}` : ''}
classified kind: ${kind}
removed (stale): ${removedFromSqlite} chunks (SQLite)
new chunks: ${enriched.enrichedChunks.length}
kind dist: ${JSON.stringify(kindDist)}
enrich cost: $${enriched.totalCostUsd.toFixed(4)}

→ Reflected in the next mindcairn search immediately.`,
      },
    ],
  };
}
