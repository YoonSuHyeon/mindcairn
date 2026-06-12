/**
 * StrategyAgent
 *
 * Input:  Discovery (produced by W1)
 * Output: IndexingStrategy (executed by the W3 Builder)
 *
 * Core idea:
 *   Take the codebase patterns Discovery found (CodeValueEnum / @Table / Repository / Aggregate ...)
 *   and autonomously design "how to chunk this codebase and where to store it".
 *
 *   No human hand-writes chunkers. The LLM looks at each codebase's patterns and decides.
 */

import { z } from 'zod';
import { config } from '../config.ts';
import { type ClaudeResponse } from '../llm/claude-cli.ts';
import { callModelJson } from '../llm/index.ts';
import type { Discovery, IndexingStrategy } from '../types.ts';

// Absorb LLM non-determinism.
const ArrayOrString = z.preprocess(
  (v) => {
    if (v == null) return undefined;
    return typeof v === 'string' ? [v] : v;
  },
  z.array(z.string()).optional(),
);

const NullishString = z.preprocess(
  (v) => (v == null ? undefined : v),
  z.string().optional(),
);

// matcher.annotation / superType: the LLM may return an array → normalize by joining with '|'.
// The builder does `.split('|')` for OR matching, so the meaning is preserved.
const MatcherString = z.preprocess(
  (v) => {
    if (v == null) return undefined;
    return Array.isArray(v) ? v.filter(Boolean).join('|') : v;
  },
  z.string().optional(),
);

const ChunkerSpecSchema = z.object({
  name: z.string(),
  matcher: z.object({
    pathGlob: ArrayOrString,
    annotation: MatcherString,
    superType: MatcherString,
  }),
  unit: z.string(),
  embeddingTextTemplate: z.string(),
  metadataKeys: z.preprocess(
    (v) => (v == null ? [] : v),
    z.array(z.string()),
  ),
});

const IndexingStrategySchema = z.object({
  // The LLM may omit version, so force it to 1.
  version: z.preprocess(() => 1, z.literal(1)),
  chunkers: z.array(ChunkerSpecSchema),
  storage: z.object({
    vector: z.string(),
    structured: NullishString,
    graph: NullishString,
  }),
  embedding: z.object({
    provider: z.string(),
    model: z.string(),
    dimensions: z.number(),
  }),
  retrievalQuota: z.preprocess(
    (v) => {
      if (!v || typeof v !== 'object') return v;
      const filtered: Record<string, number> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === 'number') filtered[k] = val;
      }
      return filtered;
    },
    z.record(z.string(), z.number()),
  ),
});

const SYSTEM_PROMPT = `You are a designer of RAG/search indexing strategies.

Given the Discovery result for a codebase (language/frameworks/architecture/conventions/domain),
autonomously design "how to chunk this codebase and where to store it".

Items to design:

1) chunkers — chunk kinds that reflect the codebase's patterns. Each chunker has:
   - name: chunk type name (e.g. code_value, kt_entity, kt_method, domain_model, aggregate)
   - matcher: which files/symbols it applies to
       pathGlob: path pattern (optional)
       annotation: Kotlin/Java annotation (e.g. "@Table", "@Repository")
       superType: implemented interface / superclass (e.g. "CodeValueEnum")
   - unit: 'file' | 'class' | 'method' | 'enum' | 'custom'
   - embeddingTextTemplate: chunk text template. Only the "supported variables" below may be used — any other variable is replaced with an empty string, so never use one.
       common: {{file}}, {{filePath}}, {{fileName}}, {{package}}
       unit=file: {{fileHead}} (the head of the original source)
       unit=class/enum: {{className}}, {{kind}}, {{kdoc}}, {{annotations}}, {{superTypes}}, {{properties}}, {{tableName}}, {{enumEntries}}
       unit=method: {{methodName}}, {{className}}, {{signature}}, {{parameters}}, {{returnType}}, {{kdoc}}, {{annotations}}, {{body}}
   - metadataKeys: metadata keys to attach to the chunk — only from the supported variable names above (e.g. ["className", "tableName", "package"])

2) storage — which combination of stores
   - vector: 'sqlite-vec' | 'qdrant' | 'pgvector'  (semantic search)
   - structured: 'sqlite' | 'es'  (optional, structured search — exact match / aggregation)
   - graph: 'sqlite-graph' | 'neo4j'  (optional, references between domain models)

3) embedding — embedding model (bge-m3 recommended if there's a lot of non-English/multilingual content)
   - provider: 'ollama' | 'voyage' | 'openai'
   - model: model name
   - dimensions: vector dimensions

4) retrievalQuota — per-type result quota at search time (to avoid bias)
   - a shape like { "ddl_column": 3, "code_value": 2, "kt_entity": 2, ... }
   - tuned to the codebase's characteristics (more quota if there are many structured code values, etc.)

Design principles:
- Actively reflect Discovery's conventions into chunker matchers
  (e.g. if conventions.codeEnumPattern is "enums implementing CodeValueEnum", use a superType="CodeValueEnum" matcher)
- A separate chunker per standard pattern — into a uniform chunk shape
- Prefer a domain_model chunker if domainHints are rich
- Make embeddingTextTemplate search-friendly. Combine natural language + metadata + KDoc.
- 5–10 chunkers is about right. Too many adds noise.
- The symbol parser (class/method/enum extraction) currently assumes Kotlin/Java-family syntax.
  If the main language is not Kotlin/Java (Go/Python/TypeScript etc.), class/method units produce almost no chunks,
  so you MUST include a unit=file + {{fileHead}} template chunker as the main one and give it a large retrievalQuota.

Return strictly valid JSON.`;

export type StrategyOptions = {
  discovery: Discovery;
};

export type StrategyRun = {
  strategy: IndexingStrategy;
  meta: Pick<ClaudeResponse, 'costUsd' | 'durationMs' | 'modelUsed'>;
};

export async function runStrategy(opts: StrategyOptions): Promise<StrategyRun> {
  const userMessage = buildUserMessage(opts.discovery);

  const resp = await callModelJson<unknown>({
    model: config.models.large,
    systemPrompt: SYSTEM_PROMPT,
    prompt: userMessage,
  });

  const strategy = IndexingStrategySchema.parse(resp.result) as IndexingStrategy;

  return {
    strategy,
    meta: {
      costUsd: resp.costUsd,
      durationMs: resp.durationMs,
      modelUsed: resp.modelUsed,
    },
  };
}

function buildUserMessage(d: Discovery): string {
  return `Request: design a RAG/search system for this codebase.

# Discovery result (how this codebase works)

## Languages
${d.language.join(', ')}

## Frameworks
${d.frameworks.join(', ')}

## Build
${d.buildSystem}

## Architecture
${d.architecturePattern}

## Modules
${d.modules.map((m) => `- ${m.name} (${m.path}) — ${m.purpose}`).join('\n')}

## Conventions (← reflect actively into chunker matchers)
${Object.entries(d.conventions).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

## Domain hints
${d.domainHints.join(', ')}

## Natural-language summary
${d.rawSummary}

---

Based on the above, autonomously design a RAG/search indexing strategy for this codebase.

In particular, add a separate chunker for each standard pattern listed in conventions.
(e.g. if codeEnumPattern is specified, a code_value chunker that takes it as a matcher)

Return JSON.`;
}
