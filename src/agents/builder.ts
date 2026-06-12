/**
 * Builder — does the actual chunking/embedding/storage per the strategy.
 *
 * Flow:
 *  1. filter files by each chunker.matcher.pathGlob
 *  2. parse Kotlin
 *  3. filter symbols by matcher.annotation / matcher.superType
 *  4. extract units per unit (file/class/method/enum)
 *  5. fill embeddingTextTemplate variables to produce text
 *  6. Ollama embedding
 *  7. Qdrant upsert
 */

import fg from 'fast-glob';
import { readFile, mkdir } from 'node:fs/promises';
import { relative, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { embedTexts } from '../builder/embedder.ts';
import { enrichChunks } from '../builder/enricher.ts';
import { ensureCollection, upsertPoints, deleteCollection, deletePointsByFilter } from '../builder/qdrant.ts';
import { ChunkStore } from '../builder/sqlite-store.ts';
import { fillTemplate } from '../builder/template.ts';
import {
  parseKotlin,
  type ParsedClass,
  type ParsedFile,
  type ParsedFunction,
} from '../builder/kotlin-parser.ts';
import type { Chunk, ChunkerSpec, IndexingStrategy } from '../types.ts';

export type BuilderOptions = {
  strategy: IndexingStrategy;
  rootPath: string;
  collection: string;
  /** SQLite file path. The body store for 2-stage retrieval. */
  sqlitePath: string;
  /** include/exclude — analysis scope (per preset) */
  include?: string[];
  exclude?: string[];
  /** false → drop and recreate the collection. true → incremental. */
  incremental?: boolean;
  /** incremental: chunk only these absolute-path files (after intersecting with the preset). If absent, scan the whole preset. */
  onlyFiles?: string[];
  /** incremental: delete existing chunks of these repo-relative files first (reflect edits/deletes). */
  staleFiles?: string[];
  /** Attach a one-line LLM label per chunk (Contextual Retrieval). Only the label is embedded. */
  enrich?: boolean;
};

export type BuilderRun = {
  totalFiles: number;
  totalChunks: number;
  byChunker: Record<string, number>;
  embeddingMs: number;
  upsertMs: number;
  enrichMs?: number;
  enrichCostUsd?: number;
};

export async function build(opts: BuilderOptions): Promise<BuilderRun> {
  const { strategy, rootPath, collection } = opts;

  // 1. prepare collection (drop only on full; incremental preserves it)
  if (!opts.incremental) {
    await deleteCollection(collection);
  }
  await ensureCollection(collection, strategy.embedding.dimensions);

  // 1.5 incremental: remove existing chunks of changed/deleted files first (edit=replace, delete=cleanup).
  //     Must run before chunk extraction so the chunks.length===0 (delete-only) case is reflected too.
  if (opts.incremental && opts.staleFiles?.length) {
    const s = new ChunkStore(opts.sqlitePath);
    let removed = 0;
    for (const f of opts.staleFiles) removed += s.deleteByMetadata('file', f);
    s.close();
    for (const f of opts.staleFiles) {
      try {
        await deletePointsByFilter(collection, { must: [{ key: 'file', match: { value: f } }] });
      } catch {
        /* payload index may be missing or the collection empty — ignore */
      }
    }
    console.error(`  incremental: processed ${opts.staleFiles.length} stale files (deleted ${removed} sqlite chunks)`);
  }

  // 2. Load target files. If incremental, limit to onlyFiles (absolute paths); else scan the whole preset.
  //    Each chunker matcher intersects again.
  const allFiles = opts.onlyFiles
    ? opts.onlyFiles
    : await fg(opts.include ?? ['**/*.kt'], {
        cwd: rootPath,
        absolute: true,
        ignore: opts.exclude ?? ['**/build/**', '**/test/**', '**/.gradle/**'],
        onlyFiles: true,
      });

  console.error(`  files to scan: ${allFiles.length}${opts.onlyFiles ? ' (incremental)' : ''}`);

  if (allFiles.length === 0) {
    console.error(`  no changed files to index — skipping chunk extraction`);
    return { totalFiles: 0, totalChunks: 0, byChunker: {}, embeddingMs: 0, upsertMs: 0 };
  }

  // 3. extract chunks per chunker
  const chunks: Chunk[] = [];
  const byChunker: Record<string, number> = {};
  for (const spec of strategy.chunkers) {
    byChunker[spec.name] = 0;
  }

  // Parse each file once and cache it (with the original source too — for file-unit chunk fallback)
  const parsedCache = new Map<string, { parsed: ParsedFile; source: string }>();
  async function getParsed(path: string): Promise<{ parsed: ParsedFile; source: string } | null> {
    if (parsedCache.has(path)) return parsedCache.get(path)!;
    try {
      const source = await readFile(path, 'utf-8');
      const entry = { parsed: parseKotlin(source), source };
      parsedCache.set(path, entry);
      return entry;
    } catch {
      return null;
    }
  }

  for (const spec of strategy.chunkers) {
    // Additional filter by the chunker's pathGlob. Intersect with allFiles (enforce preset scope).
    const matchedRaw = spec.matcher.pathGlob && spec.matcher.pathGlob.length > 0
      ? await fg(spec.matcher.pathGlob, {
          cwd: rootPath,
          absolute: true,
          ignore: opts.exclude ?? ['**/build/**', '**/test/**', '**/.gradle/**'],
          onlyFiles: true,
        })
      : allFiles;
    const allFileSet = new Set(allFiles);
    const matched = matchedRaw.filter((p) => allFileSet.has(p));

    for (const filePath of matched) {
      const entry = await getParsed(filePath);
      if (!entry) continue;
      const { parsed, source } = entry;
      const rel = relative(rootPath, filePath);
      // Structural reconstruction (class/method signature summary) only for Kotlin/Java the parser can trust.
      // Other languages lose their body via partial matching (e.g. TS interface), so use the original head.
      const structuredLang = /\.(kt|kts|java)$/.test(filePath);
      const symbols = extractSymbols(parsed, spec, source, structuredLang);
      for (const sym of symbols) {
        const vars = buildVars(sym, parsed, rel, filePath, source);
        let text = fillTemplate(spec.embeddingTextTemplate, vars);
        if (!text.trim()) continue;
        // Safety net: if the LLM-designed template used only unsupported variables and even the file path is empty, fill it in
        if (sym.kind === 'file' && !text.includes(rel)) {
          text = `file: ${rel}\n${text}`;
        }
        const metadata: Record<string, unknown> = { type: spec.name, file: rel };
        for (const key of spec.metadataKeys) {
          if (vars[key] != null) metadata[key] = vars[key];
        }
        chunks.push({
          id: chunkId(spec.name, rel, sym),
          type: spec.name,
          embeddingText: text,
          rawContent: sym.rawContent,
          metadata,
        });
        byChunker[spec.name]++;
      }
    }
  }

  console.error(`  chunks: ${chunks.length} (by type: ${JSON.stringify(byChunker)})`);

  if (chunks.length === 0) {
    return { totalFiles: allFiles.length, totalChunks: 0, byChunker, embeddingMs: 0, upsertMs: 0 };
  }

  // 3.5 enrichment (optional) — attach a one-line LLM label (Contextual Retrieval)
  let enrichedChunks = chunks;
  let enrichMs: number | undefined;
  let enrichCostUsd: number | undefined;
  if (opts.enrich) {
    // Reuse an existing label from SQLite if present (keyed by idempotent chunk id)
    const existingLabels = new Map<string, string>();
    try {
      const probe = new ChunkStore(opts.sqlitePath);
      const ids = chunks.map((c) => c.id);
      for (const c of probe.getMany(ids)) {
        if (c.enrichedLabel) existingLabels.set(c.id, c.enrichedLabel);
      }
      probe.close();
    } catch {
      /* ignore */
    }

    console.error(`  enriching ${chunks.length} chunks (Haiku 4.5) ...`);
    const enriched = await enrichChunks({ chunks, concurrency: 6, existingLabels });
    enrichedChunks = enriched.enrichedChunks;
    enrichMs = enriched.totalDurationMs;
    enrichCostUsd = enriched.totalCostUsd;
    console.error(
      `  enrich done in ${(enrichMs / 1000).toFixed(1)}s  cost=$${enrichCostUsd.toFixed(3)}  cache=${enriched.cacheHits}`,
    );
  }

  // 4. SQLite store (both body + label) — the real store for 2-stage retrieval
  await mkdir(join(opts.sqlitePath, '..'), { recursive: true }).catch(() => {});
  const store = new ChunkStore(opts.sqlitePath);
  if (!opts.incremental) store.clear();
  store.upsertMany(enrichedChunks);
  console.error(`  sqlite stored ${enrichedChunks.length} chunks → ${opts.sqlitePath}`);

  // 5. embedding — embed only the Structured Label (not the body)
  //   Enricher v2 stored the label + identifiers (className/methods/columns/enums/keywords)
  //   in metadata. Embedding only those → less noise, higher search quality.
  //   The body is the single source in SQLite — decoupled from the Qdrant embedding.
  const t0 = Date.now();
  console.error(`  embedding ${enrichedChunks.length} chunks ...`);
  const embedTextsToSend = enrichedChunks.map((c) => {
    const label = (c.metadata?.enrichedLabel as string) ?? '';
    const ids = (c.metadata?.identifiers as Record<string, unknown> | undefined) ?? {};
    const domain = (c.metadata?.domain as string) ?? '';
    const parts: string[] = [`[${c.type}]`];
    if (label) parts.push(`label: ${label}`);
    if (domain) parts.push(`domain: ${domain}`);
    if (ids.className) parts.push(`class: ${ids.className}`);
    if (Array.isArray(ids.methods) && ids.methods.length) parts.push(`methods: ${ids.methods.join(' ')}`);
    if (Array.isArray(ids.columns) && ids.columns.length) parts.push(`columns: ${ids.columns.join(' ')}`);
    if (Array.isArray(ids.tables) && ids.tables.length) parts.push(`tables: ${ids.tables.join(' ')}`);
    if (Array.isArray(ids.enums) && ids.enums.length) parts.push(`enums: ${ids.enums.join(' ')}`);
    if (Array.isArray(ids.keywords) && ids.keywords.length) parts.push(`keywords: ${ids.keywords.join(' ')}`);
    // Fallback if no label (on cache hit — only a prior enrich result may exist)
    if (parts.length === 1) {
      parts.push(c.embeddingText);
    }
    return parts.join('\n');
  });
  const embeddings = await embedTexts({
    spec: strategy.embedding,
    texts: embedTextsToSend,
    concurrency: 6,
  });
  const embeddingMs = Date.now() - t0;
  console.error(`  embeddings done in ${(embeddingMs / 1000).toFixed(1)}s`);

  // 6. Qdrant upsert — minimal payload (id + type + label only; body lives in SQLite)
  const t1 = Date.now();
  const BATCH = 200;
  for (let i = 0; i < enrichedChunks.length; i += BATCH) {
    const slice = enrichedChunks.slice(i, i + BATCH);
    await upsertPoints(
      collection,
      slice.map((c, j) => ({
        id: c.id,
        vector: embeddings[i + j],
        sparseText: embedTextsToSend[i + j],
        payload: {
          chunkId: c.id,
          type: c.type,
          file: c.metadata?.file,
          label: c.metadata?.enrichedLabel,
        },
      })),
    );
  }
  const upsertMs = Date.now() - t1;
  console.error(`  upsert done in ${(upsertMs / 1000).toFixed(1)}s`);

  store.close();

  return {
    totalFiles: allFiles.length,
    totalChunks: enrichedChunks.length,
    byChunker,
    embeddingMs,
    upsertMs,
    enrichMs,
    enrichCostUsd,
  };
}

// ---------- symbol extraction ----------

/** Max length of the original head for file-unit chunks (rawContent / {{fileHead}} variable) */
const FILE_HEAD_BYTES = 4000;

type ExtractedSymbol = {
  kind: 'class' | 'method' | 'enum' | 'file';
  className?: string;
  methodName?: string;
  rawContent: string;
  parsed?: ParsedClass | ParsedFunction;
};

function extractSymbols(
  parsed: ParsedFile,
  spec: ChunkerSpec,
  source: string,
  structuredLang: boolean,
): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  const unit = (spec.unit || '').toLowerCase();

  // If the matcher requires superType / annotation, filter classes first, then extract per unit
  const targetClasses = parsed.classes.filter((c) => {
    if (spec.matcher.annotation) {
      const required = spec.matcher.annotation
        .split('|')
        .map((a) => a.trim().replace(/^@/, ''));
      const found = c.annotations.some((ann) =>
        required.some((r) => ann.name.replace(/^@/, '') === r),
      );
      if (!found) return false;
    }
    if (spec.matcher.superType) {
      const required = spec.matcher.superType
        .split('|')
        .map((s) => s.trim());
      const found = c.superTypes.some((st) =>
        required.some((r) => st.startsWith(r) || st === r),
      );
      if (!found) return false;
    }
    return true;
  });

  if (unit.includes('enum')) {
    for (const c of targetClasses) {
      if (c.kind === 'enum') {
        out.push({
          kind: 'enum',
          className: c.name,
          rawContent: buildEnumRawContent(c),
          parsed: c,
        });
      }
    }
  } else if (unit.includes('method')) {
    for (const c of targetClasses) {
      for (const fn of c.methods) {
        out.push({
          kind: 'method',
          className: c.name,
          methodName: fn.name,
          rawContent: methodRaw(fn),
          parsed: fn,
        });
      }
    }
    if (!spec.matcher.annotation && !spec.matcher.superType) {
      for (const c of parsed.classes) {
        if (targetClasses.includes(c)) continue;
        for (const fn of c.methods) {
          out.push({
            kind: 'method',
            className: c.name,
            methodName: fn.name,
            rawContent: methodRaw(fn),
            parsed: fn,
          });
        }
      }
    }
  } else if (unit.includes('class')) {
    for (const c of targetClasses) {
      out.push({
        kind: 'class',
        className: c.name,
        rawContent: buildClassRawContent(c),
        parsed: c,
      });
    }
  } else if (unit.includes('file')) {
    out.push({
      kind: 'file',
      rawContent: buildFileRawContent(parsed, source, structuredLang),
    });
  } else {
    // custom — class-unit fallback
    for (const c of targetClasses) {
      out.push({ kind: 'class', className: c.name, rawContent: c.name, parsed: c });
    }
  }

  return out;
}

function buildVars(
  sym: ExtractedSymbol,
  parsed: ParsedFile,
  relPath: string,
  absPath: string,
  source: string,
): Record<string, unknown> {
  const vars: Record<string, unknown> = {
    package: parsed.pkg,
    file: relPath,
    filePath: relPath,
    fileName: basename(absPath),
  };

  if (sym.kind === 'file') {
    // Provide the original head so languages where the parser can't extract symbols (Go/Python/TS etc.) still get meaningful text
    vars.fileHead = source.slice(0, FILE_HEAD_BYTES);
  }

  if (sym.kind === 'class' || sym.kind === 'enum') {
    const c = sym.parsed as ParsedClass | undefined;
    vars.className = c?.name ?? sym.className;
    vars.kind = c?.kind;
    vars.kdoc = c?.kdoc ?? '';
    vars.annotations = (c?.annotations ?? []).map((a) => `${a.name}${a.argsRaw}`);
    vars.superTypes = c?.superTypes ?? [];
    vars.properties = (c?.fields ?? []).map((f) => `${f.name}: ${f.type}`);

    // @Table(name = "...", schema = "...")
    const tableAnno = c?.annotations.find((a) => a.name === '@Table');
    if (tableAnno) {
      const tn = tableAnno.argsRaw.match(/(?:name\s*=\s*)?"([^"]+)"/);
      const sn = tableAnno.argsRaw.match(/schema\s*=\s*"([^"]+)"/);
      vars.tableName = sn ? `${sn[1]}.${tn?.[1]}` : tn?.[1];
    }

    // enum entries (constant names + args)
    if (c?.enumEntries) {
      vars.enumEntries = c.enumEntries.map((e) => `${e.name}(${e.argsRaw})`);
    }
  } else if (sym.kind === 'method') {
    const fn = sym.parsed as ParsedFunction | undefined;
    vars.methodName = fn?.name ?? sym.methodName;
    vars.className = sym.className;
    vars.signature = fn?.signature ?? '';
    vars.parameters = fn?.parameters ?? '';
    vars.returnType = fn?.returnType ?? '';
    vars.kdoc = fn?.kdoc ?? '';
    vars.annotations = (fn?.annotations ?? []).map((a) => `${a.name}${a.argsRaw}`);
    vars.body = fn?.bodyText ?? '';
  }

  return vars;
}

function chunkId(type: string, relPath: string, sym: ExtractedSymbol): string {
  // include a signature hash to distinguish method overloads
  let sigHash = '';
  if (sym.kind === 'method' && sym.parsed && 'parameters' in sym.parsed) {
    const sig = (sym.parsed as ParsedFunction).parameters ?? '';
    if (sig) sigHash = createHash('sha1').update(sig).digest('hex').slice(0, 8);
  }
  const key = `${type}|${relPath}|${sym.className ?? ''}|${sym.methodName ?? ''}|${sym.kind}${sigHash ? `|${sigHash}` : ''}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 24);
}

function methodRaw(fn: ParsedFunction): string {
  const parts = [fn.signature];
  if (fn.kdoc) parts.unshift(`/** ${fn.kdoc} */`);
  if (fn.bodyText) parts.push('{', fn.bodyText, '}');
  return parts.join('\n');
}

function buildEnumRawContent(c: ParsedClass): string {
  const kdoc = c.kdoc ? `/**\n${c.kdoc}\n */\n` : '';
  const superTypes = c.superTypes?.length ? ` : ${c.superTypes.join(', ')}` : '';
  const entries = (c.enumEntries ?? [])
    .map((e) => `  ${e.name}${e.argsRaw ?? ''}`)
    .join(',\n');
  const body = entries ? `{\n${entries},\n  ;\n}` : '{}';
  return `${kdoc}enum class ${c.name}${superTypes} ${body}`;
}

function buildClassRawContent(c: ParsedClass): string {
  const kdoc = c.kdoc ? `/**\n${c.kdoc}\n */\n` : '';
  const annos = c.annotations.length
    ? c.annotations.map((a) => `@${a.name}${a.argsRaw ?? ''}`).join('\n') + '\n'
    : '';
  const superTypes = c.superTypes?.length ? ` : ${c.superTypes.join(', ')}` : '';
  const fieldLines = c.fields.map((f) => `  val ${f.name}: ${f.type}`);
  const methodLines = c.methods.map((m) => `  ${m.signature}`);
  const inner = [...fieldLines, ...methodLines].join('\n');
  const body = inner ? `{\n${inner}\n}` : '{}';
  return `${kdoc}${annos}${c.kind} ${c.name}${superTypes} ${body}`;
}

/** File-unit rawContent — Kotlin/Java (structuredLang) gets the parser-reconstructed summary,
 *  other languages (Go/Python/TS etc.) get the original source head. Since the parser
 *  partially matches non-Kotlin syntax (e.g. TS interface) and loses most of the body, decide by extension. */
function buildFileRawContent(p: ParsedFile, source: string, structuredLang: boolean): string {
  const hasSymbols = p.classes.length > 0 || p.topLevelFunctions.length > 0;
  if (!structuredLang || !hasSymbols) {
    return source.length > FILE_HEAD_BYTES
      ? source.slice(0, FILE_HEAD_BYTES) + '\n/* ...truncated... */'
      : source;
  }
  const header = `package ${p.pkg}\n${p.imports.slice(0, 20).map((i) => `import ${i}`).join('\n')}\n\n`;
  const classes = p.classes.map((c) => buildClassRawContent(c)).join('\n\n');
  const topFns = p.topLevelFunctions.map((f) => f.signature).join('\n');
  return header + classes + (topFns ? `\n\n${topFns}` : '');
}
