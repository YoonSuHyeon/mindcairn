/**
 * Notion markdown → Mindcairn chunk indexing PoC.
 *
 *   bun run scripts/ingest-notion.ts [tag] [subdir]
 *
 * inputs/notion/[subdir/]**\/*.md (frontmatter + body) → section-level chunks → enrich → SQLite + Qdrant.
 * Upserted into the existing Mindcairn collection as-is (code + Notion in the same search results).
 *
 * subdir example: team-a → ingests only inputs/notion/team-a/ (prevents cross-contamination with other instances).
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import fg from 'fast-glob';
import { embedTexts, resolveEmbeddingSpec } from '../src/builder/embedder.ts';
import { enrichChunks } from '../src/builder/enricher.ts';
import { ChunkStore } from '../src/builder/sqlite-store.ts';
import { collectionName, ensureCollection, upsertPoints } from '../src/builder/qdrant.ts';
import type { Chunk } from '../src/types.ts';
import type { DocMeta } from '../src/mcp/handlers/ingest-doc.ts';

const TAG = process.argv[2] ?? 'my-project';
const SUBDIR = process.argv[3] ?? '';
const NOTION_DIR = join(process.cwd(), 'inputs', 'notion', SUBDIR);
const SQLITE_PATH = join(process.cwd(), '.mindcairn', TAG, 'chunks.sqlite');
// Same collection naming as serve(server.ts) (src/builder/qdrant.ts collectionName)
const COLLECTION = collectionName(TAG);

type SectionChunk = {
  title: string;
  content: string;
  level: number;
};

async function main() {
  console.error(`▶ Notion ingest`);
  console.error(`  notion dir: ${NOTION_DIR}`);
  console.error(`  collection: ${COLLECTION}`);

  const rules = await loadNotionRules(TAG);

  const files = await fg('**/*.md', { cwd: NOTION_DIR, absolute: true });
  console.error(`  files: ${files.length}`);
  if (files.length === 0) {
    console.error('  ! no inputs/notion/*.md found');
    process.exit(0);
  }

  // 1. Parse + split sections + classify kind (Ingestion Spec v1: source × kind × domain)
  const chunks: Chunk[] = [];
  const kindStats: Record<string, number> = {};
  for (const f of files) {
    const content = await readFile(f, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);
    const fileName = f.split('/').pop() ?? '?';
    const sections = withOverview(splitBySections(body), body, frontmatter);
    const kind = rules.classifyKind(frontmatter);
    // Canonical, source-agnostic doc metadata. The instance's notion-rules maps its own
    // (possibly non-English) column names → these fields. Default is {} when no rules exist.
    const docMeta = rules.extractDocMeta(frontmatter);

    for (const sec of sections) {
      const text = sec.content.trim();
      if (text.length < 30) continue;
      chunks.push({
        id: chunkId(kind, fileName, sec.title),
        type: kind,
        embeddingText: buildEmbeddingText(sec, frontmatter, kind, docMeta),
        rawContent: `## ${sec.title}\n${text}`,
        metadata: {
          type: kind,
          source: 'notion',
          file: fileName,
          title: sec.title,
          level: sec.level,
          pageTitle: frontmatter.title ?? '',
          pageUrl: frontmatter.url ?? '',
          pageId: frontmatter.pageId ?? '',
          externalId: frontmatter.pageId ?? '', // same key as the ingest_doc stale cleanup
          notionDb: frontmatter.notionDb ?? '',
          taskId: frontmatter.taskId ?? docMeta.taskId ?? '',
          status: docMeta.status ?? '',
          docType: docMeta.docType ?? '',
          job: docMeta.job ?? '',
          owners: docMeta.owners ?? '',
          plannedAt: docMeta.plannedAt ?? '',
          executedAt: docMeta.executedAt ?? '',
        },
      });
      kindStats[kind] = (kindStats[kind] ?? 0) + 1;
    }
  }
  console.error(`  chunks: ${chunks.length}`);
  console.error(`  by kind: ${JSON.stringify(kindStats)}`);

  if (chunks.length === 0) {
    console.error('  ! 0 chunks');
    process.exit(0);
  }

  // 2. Reuse labels already present in SQLite
  const existingLabels = new Map<string, string>();
  try {
    const probe = new ChunkStore(SQLITE_PATH);
    for (const c of probe.getMany(chunks.map((c) => c.id))) {
      if (c.enrichedLabel) existingLabels.set(c.id, c.enrichedLabel);
    }
    probe.close();
  } catch {
    /* ignore */
  }

  // 3. Enrich
  console.error(`  enriching ...`);
  const enriched = await enrichChunks({ chunks, concurrency: 6, existingLabels });
  console.error(
    `  enrich done: cost=$${enriched.totalCostUsd.toFixed(3)}  cache=${enriched.cacheHits}`,
  );

  // 4. Store in SQLite
  const store = new ChunkStore(SQLITE_PATH);
  store.upsertMany(enriched.enrichedChunks);
  store.close();
  console.error(`  sqlite stored: ${enriched.enrichedChunks.length}`);

  // 5. Embedding — label + body
  console.error(`  embedding ...`);
  const texts = enriched.enrichedChunks.map((c) => {
    const label = (c.metadata?.enrichedLabel as string) ?? '';
    const header = label ? `[${c.type}] ${label}\n` : `[${c.type}]\n`;
    return header + c.embeddingText + '\n' + c.rawContent.slice(0, 1500);
  });
  const vectors = await embedTexts({ texts, concurrency: 6 });

  // 6. Qdrant upsert
  await ensureCollection(COLLECTION, resolveEmbeddingSpec().dimensions);
  const BATCH = 200;
  for (let i = 0; i < enriched.enrichedChunks.length; i += BATCH) {
    const slice = enriched.enrichedChunks.slice(i, i + BATCH);
    await upsertPoints(
      COLLECTION,
      slice.map((c, j) => ({
        id: c.id,
        vector: vectors[i + j],
        sparseText: texts[i + j], // BM25 sparse vector for the hybrid collection
        payload: {
          chunkId: c.id,
          type: c.type,
          file: c.metadata?.file,
          label: c.metadata?.enrichedLabel,
          title: c.metadata?.title,
          pageTitle: c.metadata?.pageTitle,
          pageUrl: c.metadata?.pageUrl,
          externalId: c.metadata?.externalId ?? '',
        },
      })),
    );
  }
  console.error(`✓ ${enriched.enrichedChunks.length} notion chunks → ${COLLECTION}`);
}

function buildEmbeddingText(
  sec: SectionChunk,
  fm: Record<string, string>,
  kind: string,
  docMeta: DocMeta,
): string {
  const tags = [
    docMeta.docType ? `type:${docMeta.docType}` : '',
    docMeta.job ? `role:${docMeta.job}` : '',
    docMeta.status ? `status:${docMeta.status}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `[${kind}] ${fm.title ?? ''} > ${sec.title}\n${tags}\n${sec.content.slice(0, 2000)}`;
}

/**
 * Ingestion Spec v1 — frontmatter → mindcairn chunker kind mapping.
 *
 * Per-instance rules: dynamically loaded from `instances/<tag>/notion-rules.ts`.
 * Falls back to default (everything doc_misc) if absent.
 *
 * Spec: mindcairn/docs/ingestion-spec.md
 */
type ClassifyKind = (fm: Record<string, string>) => string;
type ExtractDocMeta = (fm: Record<string, string>) => DocMeta;
type NotionRules = { classifyKind: ClassifyKind; extractDocMeta: ExtractDocMeta };

const defaultClassifyKind: ClassifyKind = () => 'doc_misc';
const defaultExtractDocMeta: ExtractDocMeta = () => ({});

async function loadNotionRules(tag: string): Promise<NotionRules> {
  try {
    const mod = await import(`../instances/${tag}/notion-rules.ts`);
    if (typeof mod.classifyKind === 'function' || typeof mod.extractDocMeta === 'function') {
      console.error(`  instance rules: instances/${tag}/notion-rules.ts`);
      return {
        classifyKind: typeof mod.classifyKind === 'function' ? mod.classifyKind : defaultClassifyKind,
        extractDocMeta: typeof mod.extractDocMeta === 'function' ? mod.extractDocMeta : defaultExtractDocMeta,
      };
    }
  } catch {
    /* fall back to defaults if absent */
  }
  console.error(`  ! no instance rules → default (everything doc_misc, empty metadata)`);
  return { classifyKind: defaultClassifyKind, extractDocMeta: defaultExtractDocMeta };
}

function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: content };
  const fm: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const eq = line.indexOf(':');
    if (eq > 0) fm[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return { frontmatter: fm, body: m[2] };
}

function splitBySections(body: string): SectionChunk[] {
  const sections: SectionChunk[] = [];
  const lines = body.split('\n');
  let cur: SectionChunk | null = null;
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
 * Fallback for pages without H2/H3 sections — most task-DB rows are short bodies with no headings.
 * Bundles the preamble (body before the first heading) + a frontmatter property summary into a single 'Overview' section.
 */
function withOverview(
  sections: SectionChunk[],
  body: string,
  fm: Record<string, string>,
): SectionChunk[] {
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

function chunkId(type: string, file: string, title: string): string {
  return createHash('sha1').update(`${type}|${file}|${title}`).digest('hex').slice(0, 24);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
