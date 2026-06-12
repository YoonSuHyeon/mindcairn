/**
 * DiscoveryAgent
 *
 * Input:  CodebaseSnapshot (file metadata + samples)
 * Output: Discovery (language/frameworks/patterns/conventions/domain)
 *
 * Core idea:
 *   Hand the codebase tree + representative samples to a large model (e.g. Opus, 1M context)
 *   and let it freely infer "how this codebase works".
 *
 *   LLM calls go through the Claude Code CLI (OAuth / Max plan).
 *   No API key required.
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { config } from '../config.ts';
import { type ClaudeResponse } from '../llm/claude-cli.ts';
import { callModelJson } from '../llm/index.ts';
import type { CodebaseSnapshot, Discovery, FileRef } from '../types.ts';

const DiscoverySchema = z.object({
  language: z.array(z.string()),
  frameworks: z.array(z.string()),
  buildSystem: z.string(),
  architecturePattern: z.string(),
  modules: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      purpose: z.string(),
    }),
  ),
  conventions: z.record(z.string(), z.string()),
  domainHints: z.array(z.string()),
  rawSummary: z.string(),
});

const SYSTEM_PROMPT = `You are an autonomous codebase analyst.

Given a list of source files and representative samples from a codebase, freely infer:
1. The languages used and the main frameworks
2. The build system
3. The architecture pattern (MVC / DDD / hexagonal / Clean / other)
4. The module structure and the purpose of each module
5. The coding conventions (naming, standard patterns — e.g. code-enum style, entity mapping approach, Repository pattern)
6. Domain hints (which business domain)

Rules:
- Infer conservatively. If unsure, mark it as "estimated".
- If you see a project-wide standard, quote it verbatim.
- Infer the domain from module/package/file names.
- conventions keys are free-form, suited to the codebase (e.g. naming, codeEnumPattern, entityPattern, repositoryPattern).

Return JSON schema:
{
  "language": ["kotlin"],
  "frameworks": ["spring-boot", "jooq"],
  "buildSystem": "gradle",
  "architecturePattern": "ddd-hexagonal",
  "modules": [
    { "name": "...", "path": "...", "purpose": "..." }
  ],
  "conventions": {
    "naming": "...",
    "codeEnumPattern": "...",
    "entityPattern": "...",
    "repositoryPattern": "..."
  },
  "domainHints": ["..."],
  "rawSummary": "a 5–10 line natural-language summary"
}`;

export type DiscoveryOptions = {
  snapshot: CodebaseSnapshot;
  sampleSize?: number;
  sampleMaxBytes?: number;
};

export type DiscoveryRun = {
  discovery: Discovery;
  meta: Pick<ClaudeResponse, 'costUsd' | 'durationMs' | 'modelUsed'>;
};

export async function runDiscovery(opts: DiscoveryOptions): Promise<DiscoveryRun> {
  const { snapshot } = opts;
  const sampleSize = opts.sampleSize ?? config.limits.discoverySampleFiles;
  const sampleMaxBytes = opts.sampleMaxBytes ?? config.limits.maxFileBytesForSample;

  const samples = await pickSamples(snapshot.files, sampleSize, sampleMaxBytes);
  const userMessage = buildUserMessage(snapshot, samples);

  const resp = await callModelJson<unknown>({
    model: config.models.large,
    systemPrompt: SYSTEM_PROMPT,
    prompt: userMessage,
  });

  const discovery = DiscoverySchema.parse(resp.result) as Discovery;

  return {
    discovery,
    meta: {
      costUsd: resp.costUsd,
      durationMs: resp.durationMs,
      modelUsed: resp.modelUsed,
    },
  };
}

// ---------- helpers ----------

async function pickSamples(
  files: FileRef[],
  size: number,
  maxBytes: number,
): Promise<Array<{ ref: FileRef; content: string }>> {
  const byDir = new Map<string, FileRef[]>();
  for (const f of files) {
    const dir = f.relativePath.split('/').slice(0, 5).join('/');
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(f);
  }
  const picked: FileRef[] = [];
  const dirs = [...byDir.values()];
  let idx = 0;
  while (picked.length < size) {
    let pickedAny = false;
    for (const bucket of dirs) {
      if (picked.length >= size) break;
      if (idx < bucket.length) {
        picked.push(bucket[idx]);
        pickedAny = true;
      }
    }
    if (!pickedAny) break;
    idx++;
  }

  const out: Array<{ ref: FileRef; content: string }> = [];
  for (const f of picked) {
    try {
      const raw = await readFile(f.path, 'utf-8');
      const content =
        raw.length > maxBytes ? raw.slice(0, maxBytes) + '\n/* ...truncated... */' : raw;
      out.push({ ref: f, content });
    } catch {
      // skip
    }
  }
  return out;
}

function buildUserMessage(
  snapshot: CodebaseSnapshot,
  samples: Array<{ ref: FileRef; content: string }>,
): string {
  const tree = renderTree(snapshot.files);
  const sampleBlocks = samples
    .map(
      (s) =>
        `### ${s.ref.relativePath}\n\`\`\`${s.ref.language}\n${s.content}\n\`\`\``,
    )
    .join('\n\n');
  return `Request: analyze this codebase.

# Codebase summary
- root: ${snapshot.rootPath}
- total files: ${snapshot.totalFiles}
- total bytes: ${snapshot.totalBytes}

# Directory tree (top levels)
\`\`\`
${tree}
\`\`\`

# Representative sample files (${samples.length})
${sampleBlocks}

Using the above, autonomously infer the codebase's language/frameworks/architecture/conventions/domain and answer with structured JSON.`;
}

function renderTree(files: FileRef[]): string {
  const counter = new Map<string, number>();
  for (const f of files) {
    const parts = f.relativePath.split('/').slice(0, 6);
    let acc = '';
    for (const p of parts.slice(0, parts.length - 1)) {
      acc = acc ? `${acc}/${p}` : p;
      counter.set(acc, (counter.get(acc) ?? 0) + 1);
    }
  }
  const dirs = [...counter.entries()]
    .filter(([d]) => d.split('/').length <= 6)
    .sort(([a], [b]) => a.localeCompare(b));
  return dirs
    .map(
      ([d, n]) =>
        `${'  '.repeat(d.split('/').length - 1)}${d.split('/').pop()}/  (${n} files)`,
    )
    .join('\n');
}
