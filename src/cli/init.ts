/**
 * mindcairn init — the "30-minute setup" interactive wizard.
 *
 *   bun run src/cli/index.ts init                               # interactive
 *   bun run src/cli/index.ts init --repo <path> --tag <tag> --yes  # non-interactive
 *
 * Flow:
 *   [0] preflight — check Qdrant / embedding provider / LLM path (guide a fix if anything fails)
 *   [1] preset    — scan the repo, detect languages → create instances/<tag>/preset.ts
 *   [2] discovery — the LLM autonomously analyzes repo structure/conventions
 *   [3] strategy  — autonomously design the chunking strategy (embedding fixed to the current env's provider)
 *   [4] build     — chunk + embed + load into Qdrant/SQLite (fall back to a generic strategy if coverage is low)
 *   [5] done      — print the serve command + MCP connection URL
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stringify as toYaml } from 'yaml';
import fg from 'fast-glob';
import { loadCodebase } from '../loaders/code-loader.ts';
import { runDiscovery } from '../agents/discovery-agent.ts';
import { runStrategy } from '../agents/strategy-agent.ts';
import { build } from '../agents/builder.ts';
import {
  assertSpecUsable,
  resolveEmbeddingSpec,
} from '../builder/embedder.ts';
import { collectionName, deleteCollection } from '../builder/qdrant.ts';
import { detectLlmMode, llmUnavailableMessage, resolveEnricherMode } from '../llm/index.ts';
import { config } from '../config.ts';
import type { EmbeddingSpec, IndexingStrategy } from '../types.ts';

const QDRANT_HOST = process.env.MINDCAIRN_QDRANT_HOST ?? 'http://localhost:6333';
const OLLAMA_HOST = process.env.MINDCAIRN_OLLAMA_HOST ?? 'http://localhost:11434';

const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/build/**',
  '**/.gradle/**',
  '**/.git/**',
  '**/dist/**',
  '**/target/**',
  '**/.next/**',
  '**/test/**',
  '**/tests/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*Test.kt',
  '**/*Test.java',
  // Go / Python test conventions
  '**/*_test.go',
  '**/testdata/**',
  '**/test_*.py',
  '**/*_test.py',
  '**/conftest.py',
  '**/__tests__/**',
  '**/__pycache__/**',
];

const CODE_EXTS = ['kt', 'java', 'ts', 'tsx', 'js', 'py', 'go', 'rs', 'sql'];

export async function runInit(flags: Record<string, string | boolean>) {
  const yes = !!flags.yes;
  const rl = yes
    ? null
    : createInterface({ input: process.stdin, output: process.stderr });
  const ask = async (q: string): Promise<string> => {
    if (!rl) return '';
    return (await rl.question(q)).trim();
  };

  try {
    console.error(`▶ Mindcairn init — set up a new instance`);

    // ── input: repo / tag ──
    let repo = typeof flags.repo === 'string' ? flags.repo : '';
    if (!repo) {
      if (yes) {
        console.error('✗ --yes mode requires --repo <path>.');
        process.exit(1);
      }
      repo = await ask('Path of the repo to index: ');
    }
    repo = resolve(repo.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
    if (!existsSync(repo) || !statSync(repo).isDirectory()) {
      console.error(`✗ Directory does not exist: ${repo}`);
      process.exit(1);
    }

    const suggested = sanitizeTag(basename(repo));
    let tag = typeof flags.tag === 'string' ? sanitizeTag(flags.tag) : '';
    if (!tag) {
      tag = yes ? suggested : sanitizeTag((await ask(`Instance tag [${suggested}]: `)) || suggested);
    }
    console.error(`  repo: ${repo}`);
    console.error(`  tag:  ${tag}`);

    // ── [0/5] preflight ──
    console.error(`\n[0/5] environment check`);
    await preflight();

    // ── [1/5] preset ──
    console.error(`\n[1/5] create preset`);
    const presetPath = join(process.cwd(), 'instances', tag, 'preset.ts');
    let include: string[];
    let exclude: string[] = DEFAULT_EXCLUDE;

    if (existsSync(presetPath)) {
      console.error(`  using existing preset: ${presetPath}`);
      const mod = await import(presetPath);
      const p = (mod.preset ?? mod.default) as { include: string[]; exclude: string[] };
      include = p.include;
      exclude = p.exclude;
    } else {
      include = await detectIncludeGlobs(repo);
      if (include.length === 0) {
        console.error(
          `✗ Found no supported-language files (.${CODE_EXTS.join('/.')}) — check the path: ${repo}`,
        );
        process.exit(1);
      }
      console.error(`  detected include: ${include.join(', ')}`);
      if (!yes) {
        const ok = (await ask('  Proceed with this scope? [Y/n]: ')).toLowerCase();
        if (ok === 'n' || ok === 'no') {
          console.error(
            `  Aborted — write instances/${tag}/preset.ts yourself, then run init again (example: instances/example/preset.ts).`,
          );
          process.exit(0);
        }
      }
      await mkdir(join(process.cwd(), 'instances', tag), { recursive: true });
      await writeFile(presetPath, renderPreset(tag, repo, include, exclude), 'utf-8');
      console.error(`  created: ${presetPath}`);
    }

    const outDir = join(process.cwd(), config.output.dir, tag);
    await mkdir(outDir, { recursive: true });

    // ── [2/5] discovery ──
    console.error(`\n[2/5] Discovery — autonomous analysis of repo structure/conventions (${config.models.large}, takes a few minutes)`);
    const t0 = Date.now();
    const snapshot = await loadCodebase(repo, { include, exclude });
    console.error(`  scanned ${snapshot.totalFiles} files`);
    if (snapshot.totalFiles === 0) {
      console.error(`✗ 0 files in the include scope — check the globs in instances/${tag}/preset.ts.`);
      process.exit(1);
    }
    const { discovery, meta: dMeta } = await runDiscovery({ snapshot });
    await writeFile(join(outDir, 'discovery.json'), JSON.stringify(discovery, null, 2), 'utf-8');
    console.error(
      `  done ${((Date.now() - t0) / 1000).toFixed(1)}s  cost=$${dMeta.costUsd.toFixed(3)}  (languages: ${discovery.language?.join(', ')} / build: ${discovery.buildSystem})`,
    );

    // ── [3/5] strategy ──
    console.error(`\n[3/5] Strategy — autonomously design the chunking strategy`);
    const t1 = Date.now();
    const { strategy } = await runStrategy({ discovery });
    // embedding is fixed to the current env's provider (not the LLM's suggestion) — the single source of truth for index/search consistency
    const embedSpec = resolveEmbeddingSpec();
    strategy.embedding = embedSpec;
    await persistStrategy(outDir, strategy);
    console.error(
      `  done ${((Date.now() - t1) / 1000).toFixed(1)}s  chunkers=${strategy.chunkers.length}  embedding=${embedSpec.provider}/${embedSpec.model}(${embedSpec.dimensions}d)`,
    );

    // ── [4/5] build ──
    const enricherMode = resolveEnricherMode();
    console.error(`\n[4/5] Build — chunk + embed + load (enricher: ${enricherMode})`);
    const collection = collectionName(tag);
    const sqlitePath = join(outDir, 'chunks.sqlite');
    const t2 = Date.now();
    let run = await build({
      strategy,
      rootPath: repo,
      collection,
      sqlitePath,
      enrich: enricherMode !== 'off',
      include,
      exclude,
    });

    // Coverage check — if the LLM strategy captures almost none of this repo's files (parser mismatch),
    // fall back to a generic class/file strategy. Catches not just 0 but also "too few relative to file count".
    const minChunks = Math.max(5, Math.ceil(snapshot.totalFiles * 0.3));
    if (run.totalChunks < minChunks) {
      console.error(
        `  ⚠ LLM-designed strategy has low coverage (${run.totalChunks} chunks < threshold ${minChunks} / ${snapshot.totalFiles} files) — falling back to a generic strategy (class/file units).`,
      );
      const fallback = genericStrategy(include, embedSpec);
      await persistStrategy(outDir, fallback);
      // Remove the previous build's leftovers before rebuilding (avoid stale chunks)
      await rm(sqlitePath, { force: true });
      await deleteCollection(collection).catch(() => {});
      run = await build({
        strategy: fallback,
        rootPath: repo,
        collection,
        sqlitePath,
        enrich: enricherMode !== 'off',
        include,
        exclude,
      });
      if (run.totalChunks === 0) {
        console.error(
          `✗ 0 chunks even with the generic strategy — the parser may not support this language yet (class parsing currently focuses on the Kotlin/Java family).`,
        );
        process.exit(1);
      }
    }
    console.error(
      `  done ${((Date.now() - t2) / 1000).toFixed(1)}s  chunks=${run.totalChunks}  (${Object.entries(run.byChunker).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(', ')})`,
    );

    // ── [5/5] done ──
    const port = Number(process.env.MINDCAIRN_MCP_PORT ?? 8765);
    console.error(`\n[5/5] done ✓`);
    console.log(`
# Mindcairn instance "${tag}" is ready

chunks: ${run.totalChunks}  /  collection: ${collection}  /  meta: ${outDir}/

Start the MCP server:
  bun run src/cli/index.ts serve ${tag}

MCP connection: http://localhost:${port}/mcp
  (register with Claude Code: claude mcp add --transport http mindcairn-${tag} http://localhost:${port}/mcp)
  (check status:              curl http://localhost:${port}/health)
`);
  } finally {
    rl?.close();
  }
}

// ---------- helpers ----------

function sanitizeTag(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'my-repo';
}

async function preflight() {
  // 1) Qdrant
  try {
    const res = await fetch(`${QDRANT_HOST}/collections`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    console.error(`  ✓ Qdrant (${QDRANT_HOST})`);
  } catch (e) {
    console.error(
      `  ✗ Failed to connect to Qdrant (${QDRANT_HOST}) — start it: docker compose up -d\n` +
        `    (if docker compose says "Cannot connect to the Docker daemon", launch Docker Desktop first)\n` +
        `    cause: ${(e as Error).message}`,
    );
    process.exit(1);
  }

  // 2) embedding provider
  const spec = resolveEmbeddingSpec();
  try {
    assertSpecUsable(spec);
  } catch (e) {
    console.error(`  ✗ ${(e as Error).message}`);
    process.exit(1);
  }
  if (spec.provider === 'ollama') {
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
      const json = (await res.json()) as { models?: Array<{ name: string }> };
      const found = (json.models ?? []).some(
        (m) => m.name === spec.model || m.name === `${spec.model}:latest` || m.name.startsWith(`${spec.model}:`),
      );
      if (!found) {
        console.error(
          `  ✗ Model "${spec.model}" not found in Ollama — install it: ollama pull ${spec.model}`,
        );
        process.exit(1);
      }
      console.error(`  ✓ Ollama (${OLLAMA_HOST}, model=${spec.model})`);
    } catch (e) {
      if ((e as Error).message.includes('ollama pull')) throw e;
      console.error(
        `  ✗ Failed to connect to Ollama (${OLLAMA_HOST}) — start: ollama serve, model: ollama pull ${spec.model}\n` +
          `    (to use OpenAI embeddings instead: EMBEDDING_PROVIDER=openai + OPENAI_API_KEY)\n` +
          `    cause: ${(e as Error).message}`,
      );
      process.exit(1);
    }
  } else {
    console.error(`  ✓ OpenAI embeddings (${spec.model}, ${spec.dimensions}d)`);
  }

  // 3) LLM (required for discovery/strategy)
  const llm = detectLlmMode();
  if (!llm) {
    console.error(`  ✗ ${llmUnavailableMessage('Discovery/Strategy')}`);
    process.exit(1);
  }
  console.error(`  ✓ LLM path: ${llm}`);

  // 4) enricher (optional — can proceed even if off)
  const enricher = resolveEnricherMode();
  if (enricher === 'off') {
    console.error(`  ⚠ enricher off — indexing without labels (search quality somewhat lower; enable with ENRICHER=claude-cli|api)`);
  } else {
    console.error(`  ✓ enricher: ${enricher}`);
  }
}

/** Scan the distribution of code-file extensions in the repo → suggest include globs. */
async function detectIncludeGlobs(repo: string): Promise<string[]> {
  const counts = new Map<string, number>();
  const files = await fg(CODE_EXTS.map((e) => `**/*.${e}`), {
    cwd: repo,
    ignore: DEFAULT_EXCLUDE,
    onlyFiles: true,
    suppressErrors: true,
  });
  for (const f of files) {
    const ext = f.split('.').pop() ?? '';
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  // Only extensions with 3+ occurrences (avoid noisy globs from one or two scripts)
  return CODE_EXTS.filter((e) => (counts.get(e) ?? 0) >= 3).map((e) => `**/*.${e}`);
}

function renderPreset(tag: string, repo: string, include: string[], exclude: string[]): string {
  const arr = (xs: string[]) => xs.map((x) => `    '${x}',`).join('\n');
  return `/**
 * ${tag} — preset auto-generated by mindcairn init (${new Date().toISOString().slice(0, 10)}).
 * Target repo: ${repo}
 * include/exclude are globs relative to the repo root — edit as needed and reindex (init/build).
 */

export type Preset = {
  include: string[];
  exclude: string[];
};

export const preset: Preset = {
  include: [
${arr(include)}
  ],
  exclude: [
${arr(exclude)}
  ],
};

export default preset;
`;
}

async function persistStrategy(outDir: string, strategy: IndexingStrategy) {
  await writeFile(join(outDir, 'indexing-strategy.json'), JSON.stringify(strategy, null, 2), 'utf-8');
  await writeFile(join(outDir, 'indexing-strategy.yml'), toYaml(strategy), 'utf-8');
}

/** Safety net for when the LLM strategy produces 0 chunks — generic class/file-unit chunks. */
function genericStrategy(include: string[], embedding: EmbeddingSpec): IndexingStrategy {
  return {
    version: 1,
    chunkers: [
      {
        name: 'code_class',
        matcher: { pathGlob: include },
        unit: 'class',
        embeddingTextTemplate:
          '{{className}} ({{kind}})\npackage: {{package}}\nfile: {{file}}\n{{kdoc}}\nproperties: {{properties}}\nsuperTypes: {{superTypes}}',
        metadataKeys: ['className', 'package', 'file'],
      },
      {
        name: 'code_file',
        matcher: { pathGlob: include },
        unit: 'file',
        embeddingTextTemplate: 'file: {{file}}\npackage: {{package}}',
        metadataKeys: ['file', 'package'],
      },
    ],
    storage: { vector: 'qdrant' },
    embedding,
    retrievalQuota: { code_class: 8, code_file: 2 },
  };
}
