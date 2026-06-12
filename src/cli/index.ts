#!/usr/bin/env bun
/**
 * Mindcairn CLI
 *
 *   mindcairn init <path>                  — discover → strategy → build → enrich, all at once
 *   mindcairn search <tag> "<query>"       — hybrid search (BM25 + dense)
 *   mindcairn serve <tag>                  — MCP HTTP server (:8765/mcp)
 *   mindcairn discover|strategy|build|sync|eval|improve|analyze — run individual steps
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { stringify as toYaml } from 'yaml';
import fg from 'fast-glob';
import { loadCodebase } from '../loaders/code-loader.ts';
import { runDiscovery } from '../agents/discovery-agent.ts';
import { runStrategy } from '../agents/strategy-agent.ts';
import { build } from '../agents/builder.ts';
import { generateEvals } from '../agents/eval-generator.ts';
import { judgeAll } from '../agents/judge.ts';
import { runImprover } from '../agents/improver.ts';
import { runMcpServer } from '../mcp/server.ts';
import { materializeRef, changedFiles, type RefSnapshot } from '../loaders/git-source.ts';
import { runInit } from './init.ts';
import { resolveEmbeddingSpec, assertSpecMatchesEnv, embedTexts } from '../builder/embedder.ts';
import { collectionName, hybridSearch } from '../builder/qdrant.ts';
import { config } from '../config.ts';
import type { Discovery, EvalCase, EvalReport, IndexingStrategy } from '../types.ts';

type Args = {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
};

const args = parseArgs(process.argv.slice(2));

/**
 * Dynamically load an instance preset. Lookup order:
 *   1) instances/<tag>/preset.ts            — one product = one instance
 *   2) instances/<*>/presets/<tag>.ts        — one org, multiple products (e.g. my-org/presets/my-app-jp.ts)
 *
 * Add a new product: instances/<org>/presets/<tag>.ts (default export = { include, exclude })
 * Example: instances/example/
 */
type Preset = { include: string[]; exclude: string[] };

async function tryImportPreset(modPath: string): Promise<Preset | undefined> {
  try {
    const mod = await import(modPath);
    return (mod.preset ?? mod.default) as Preset | undefined;
  } catch {
    return undefined;
  }
}

async function loadPreset(name: string): Promise<Preset | undefined> {
  // 1) instances/<name>/preset.ts (single-product instance)
  const direct = await tryImportPreset(`../../instances/${name}/preset.ts`);
  if (direct) return direct;

  // 2) instances/<*>/presets/<name>.ts (one org, multiple products)
  const hits = await fg(`instances/*/presets/${name}.ts`, {
    cwd: process.cwd(),
    absolute: false,
    onlyFiles: true,
  });
  for (const rel of hits) {
    const p = await tryImportPreset(`../../${rel}`);
    if (p) return p;
  }
  return undefined;
}

/**
 * Resolve the root to index.
 * If --ref <ref> is given, check that ref out into a worktree and return the isolated path.
 * Otherwise use the working tree (targetPath) as-is — backward compatible.
 *
 * Returns: { repo (original repo), root (indexing path), snapshot (includes sha if a ref) }
 */
function resolveRoot(targetPath: string): {
  repo: string;
  root: string;
  snapshot?: RefSnapshot;
} {
  const repo = resolve(targetPath);
  const ref = args.flags.ref as string | undefined;
  if (!ref) return { repo, root: repo };
  // mindcairn does not fetch (read-only). Refreshing local refs is handled by your usual pull → no auth needed.
  // To force a fetch, use the --fetch flag.
  const snapshot = materializeRef(repo, ref, { fetch: !!args.flags.fetch });
  console.error(`  ref: ${ref} @ ${snapshot.sha.slice(0, 8)} → ${snapshot.root}`);
  return { repo, root: snapshot.root, snapshot };
}

async function main() {
  switch (args.command) {
    case 'init':
      await runInit(args.flags);
      break;
    case 'discover':
      await cmdDiscover();
      break;
    case 'strategy':
      await cmdStrategy();
      break;
    case 'build':
      await cmdBuild();
      break;
    case 'sync':
      await cmdSync();
      break;
    case 'eval':
      await cmdEval();
      break;
    case 'search':
      await cmdSearch();
      break;
    case 'improve':
      await cmdImprove();
      break;
    case 'serve':
      await cmdServe();
      break;
    case 'analyze':
      await cmdAnalyze();
      break;
    default:
      printHelp();
      process.exit(args.command ? 1 : 0);
  }
}

async function cmdDiscover() {
  const targetPath = args.positional[0];
  if (!targetPath) {
    console.error('Usage: mindcairn discover <path> [--preset <name>]');
    process.exit(1);
  }

  const presetName = (args.flags.preset as string | undefined) ?? undefined;
  const preset = presetName ? await loadPreset(presetName) : undefined;
  if (presetName && !preset) {
    console.error(`Unknown preset: ${presetName}. Check whether instances/${presetName}/preset.ts exists.`);
    process.exit(1);
  }

  console.error(`▶ Mindcairn discover`);
  const { root } = resolveRoot(targetPath);
  console.error(`  root: ${root}`);
  if (preset) console.error(`  preset: ${presetName}`);

  console.error(`  [1/2] loading codebase ...`);
  const t0 = Date.now();
  const snapshot = await loadCodebase(root, preset);
  const loadMs = Date.now() - t0;
  console.error(
    `        ${snapshot.totalFiles} files, ${prettyBytes(snapshot.totalBytes)} (${loadMs}ms)`,
  );
  if (snapshot.totalFiles === 0) {
    console.error(`        0 files — check your include/exclude globs.`);
    process.exit(1);
  }

  console.error(`  [2/2] running Discovery Agent (${config.models.large}) via Claude CLI ...`);
  const t1 = Date.now();
  const { discovery, meta } = await runDiscovery({ snapshot });
  const discoverMs = Date.now() - t1;
  console.error(
    `        done in ${(discoverMs / 1000).toFixed(1)}s  cost=$${meta.costUsd.toFixed(3)}`,
  );

  // output
  const tag = presetName ?? root.split('/').pop() ?? 'unknown';
  const outDir = join(process.cwd(), config.output.dir, tag);
  await mkdir(outDir, { recursive: true });

  const jsonPath = join(outDir, 'discovery.json');
  await writeFile(jsonPath, JSON.stringify(discovery, null, 2), 'utf-8');

  const mdPath = join(outDir, 'discovery.md');
  await writeFile(mdPath, renderDiscoveryMarkdown(discovery, snapshot, meta), 'utf-8');

  console.error(`\n✓ Output:`);
  console.error(`  - ${jsonPath}`);
  console.error(`  - ${mdPath}`);

  // human-readable summary (stdout)
  console.log('\n# Discovery result');
  console.log(`Languages: ${discovery.language?.join(', ')}`);
  console.log(`Frameworks: ${discovery.frameworks?.join(', ')}`);
  console.log(`Build: ${discovery.buildSystem}`);
  console.log(`Architecture: ${discovery.architecturePattern}`);
  console.log(`Domain hints: ${discovery.domainHints?.join(', ')}`);
  console.log(`\n${discovery.rawSummary}`);
}

async function cmdStrategy() {
  // Option 1: --from-discovery <path>  (reuse an existing discovery.json)
  // Option 2: <target-path> [--preset]  (discover + strategy in one go)
  const fromDiscovery = args.flags['from-discovery'] as string | undefined;
  const targetPath = args.positional[0];

  let discovery: Discovery;
  let tag: string;

  if (fromDiscovery) {
    const raw = await readFile(resolve(fromDiscovery), 'utf-8');
    discovery = JSON.parse(raw) as Discovery;
    tag = resolve(fromDiscovery).split('/').slice(-2, -1)[0] ?? 'unknown';
    console.error(`▶ Mindcairn strategy (from ${fromDiscovery})`);
  } else if (targetPath) {
    const presetName = (args.flags.preset as string | undefined) ?? undefined;
    const preset = presetName ? await loadPreset(presetName) : undefined;
    if (presetName && !preset) {
      console.error(`Unknown preset: ${presetName}. Check instances/${presetName}/preset.ts.`);
      process.exit(1);
    }
    console.error(`▶ Mindcairn strategy (discover + strategy)`);
    const { root } = resolveRoot(targetPath);
    console.error(`  root: ${root}`);
    if (preset) console.error(`  preset: ${presetName}`);

    console.error(`  [1/3] loading codebase ...`);
    const snapshot = await loadCodebase(root, preset);
    console.error(`        ${snapshot.totalFiles} files`);

    console.error(`  [2/3] Discovery Agent ...`);
    const dResult = await runDiscovery({ snapshot });
    discovery = dResult.discovery;
    tag = presetName ?? root.split('/').pop() ?? 'unknown';
    console.error(`        cost=$${dResult.meta.costUsd.toFixed(3)}`);
  } else {
    console.error('Usage: mindcairn strategy <path> [--preset <name>]');
    console.error('   or: mindcairn strategy --from-discovery <path-to-discovery.json>');
    process.exit(1);
  }

  console.error(`  [→] Strategy Agent (${config.models.large}) ...`);
  const t = Date.now();
  const { strategy, meta } = await runStrategy({ discovery });
  // embedding is fixed to the current env's provider (not the LLM's suggestion) for index/search consistency
  strategy.embedding = resolveEmbeddingSpec();
  console.error(
    `        done in ${((Date.now() - t) / 1000).toFixed(1)}s  cost=$${meta.costUsd.toFixed(3)}`,
  );

  const outDir = join(process.cwd(), config.output.dir, tag);
  await mkdir(outDir, { recursive: true });

  // Also save discovery.json — serve/eval require this file.
  // (--from-discovery rewrites the original; inline discover saves a new one)
  await writeFile(join(outDir, 'discovery.json'), JSON.stringify(discovery, null, 2), 'utf-8');

  const yamlPath = join(outDir, 'indexing-strategy.yml');
  await writeFile(yamlPath, toYaml(strategy), 'utf-8');

  const jsonPath = join(outDir, 'indexing-strategy.json');
  await writeFile(jsonPath, JSON.stringify(strategy, null, 2), 'utf-8');

  const mdPath = join(outDir, 'indexing-strategy.md');
  await writeFile(mdPath, renderStrategyMarkdown(strategy, meta), 'utf-8');

  console.error(`\n✓ Output:`);
  console.error(`  - ${yamlPath}`);
  console.error(`  - ${jsonPath}`);
  console.error(`  - ${mdPath}`);

  console.log(`\n# Strategy summary`);
  console.log(`Chunkers (${strategy.chunkers.length}):`);
  for (const c of strategy.chunkers) {
    console.log(`  - ${c.name} (unit=${c.unit}, matcher=${JSON.stringify(c.matcher)})`);
  }
  console.log(`\nStorage: vector=${strategy.storage.vector}` +
    (strategy.storage.structured ? `, structured=${strategy.storage.structured}` : '') +
    (strategy.storage.graph ? `, graph=${strategy.storage.graph}` : ''));
  console.log(`Embedding: ${strategy.embedding.provider}/${strategy.embedding.model} (${strategy.embedding.dimensions}d)`);
  console.log(`Quota: ${Object.entries(strategy.retrievalQuota).map(([k, v]) => `${k}=${v}`).join(', ')}`);
}

async function cmdBuild() {
  const targetPath = args.positional[0];
  const presetName = (args.flags.preset as string | undefined) ?? undefined;
  const strategyPath = args.flags.strategy as string | undefined;
  const tag = (args.flags.tag as string | undefined) ?? presetName ?? 'unknown';

  if (!targetPath) {
    console.error('Usage: mindcairn build <path> [--preset <name>] [--strategy <path>] [--tag <name>]');
    process.exit(1);
  }

  // If --preset is given, use it. Otherwise fall back to a preset named like --tag
  // (init creates instances/<tag>/preset.ts, so this fallback usually matches).
  const preset = presetName ? await loadPreset(presetName) : await loadPreset(tag);
  if (presetName && !preset) {
    console.error(`Unknown preset: ${presetName}. Check instances/${presetName}/preset.ts.`);
    process.exit(1);
  }
  if (!presetName && preset) console.error(`  preset: ${tag} (auto-loaded instances/${tag}/preset.ts)`);
  const { repo, root, snapshot } = resolveRoot(targetPath);

  // Load strategy: explicit path or .mindcairn/<tag>/indexing-strategy.json
  const canonicalSPath = join(process.cwd(), config.output.dir, tag, 'indexing-strategy.json');
  const sPath = strategyPath ? resolve(strategyPath) : canonicalSPath;
  const strategy = JSON.parse(await readFile(sPath, 'utf-8')) as IndexingStrategy;
  assertSpecMatchesEnv(strategy.embedding, `build ${tag}`);

  // Even when building from an external --strategy, copy it to the canonical location search/serve look for
  // (supports the path of using a hand-written strategy with no LLM analysis).
  if (strategyPath && resolve(strategyPath) !== canonicalSPath) {
    const outDir = join(process.cwd(), config.output.dir, tag);
    await mkdir(outDir, { recursive: true });
    await writeFile(canonicalSPath, JSON.stringify(strategy, null, 2));
    // serve also requires discovery.json (for domainHints in tool descriptions) — create a stub if absent.
    const discoveryPath = join(outDir, 'discovery.json');
    if (!existsSync(discoveryPath)) {
      const stub: Discovery = {
        language: [], frameworks: [], buildSystem: '', architecturePattern: '',
        modules: [],
        conventions: { naming: '', codeEnumPattern: '', entityPattern: '' },
        domainHints: [],
        rawSummary: 'hand-written strategy (no-LLM mode) — discovery not run',
      };
      await writeFile(discoveryPath, JSON.stringify(stub, null, 2));
    }
  }

  const collection = collectionName(tag);
  const sqlitePath = join(process.cwd(), config.output.dir, tag, 'chunks.sqlite');
  const enrich = !!args.flags.enrich;
  console.error(`▶ Mindcairn build`);
  console.error(`  root: ${root}`);
  console.error(`  strategy: ${sPath}`);
  console.error(`  collection: ${collection}`);
  console.error(`  sqlite: ${sqlitePath}`);
  console.error(`  enrich: ${enrich}`);

  const t = Date.now();
  const run = await build({
    strategy,
    rootPath: root,
    collection,
    sqlitePath,
    enrich,
    include: preset?.include,
    exclude: preset?.exclude,
  });
  const total = Date.now() - t;

  console.log(`\n# Build result`);
  console.log(`scanned files: ${run.totalFiles}`);
  console.log(`chunks: ${run.totalChunks}`);
  console.log(`by chunker:`);
  for (const [k, v] of Object.entries(run.byChunker)) {
    console.log(`  - ${k}: ${v}`);
  }
  console.log(`embedding: ${(run.embeddingMs / 1000).toFixed(1)}s`);
  console.log(`upsert: ${(run.upsertMs / 1000).toFixed(1)}s`);
  console.log(`total: ${(total / 1000).toFixed(1)}s`);
  console.log(`collection: ${collection}`);

  // On a ref build, record the indexed sha → the baseline for the next incremental (--changed-since).
  if (snapshot) {
    const statePath = join(process.cwd(), config.output.dir, tag, 'state.json');
    await writeFile(
      statePath,
      JSON.stringify(
        { repo, ref: snapshot.ref, sha: snapshot.sha, preset: presetName, indexedAt: new Date().toISOString() },
        null,
        2,
      ),
      'utf-8',
    );
    console.log(`state: ${snapshot.ref} @ ${snapshot.sha.slice(0, 8)} → ${statePath}`);
  }
}

/**
 * Incremental sync — reindex only the .kt files changed since the last indexed sha in state.json.
 *
 *   mindcairn sync <tag> [--ref <ref>] [--repo <path>] [--fetch] [--no-enrich]
 *
 * Flow: git diff between state.sha → ref's latest sha → intersect with preset → for changed files only,
 *       delete existing chunks (stale) + re-chunk and upsert. Deleted files also get their chunks cleaned up.
 */
async function cmdSync() {
  const tag = (args.flags.tag as string | undefined) ?? args.positional[0];
  if (!tag) {
    console.error('Usage: mindcairn sync <tag> [--ref <ref>] [--repo <path>] [--fetch] [--no-enrich]');
    process.exit(1);
  }
  const outDir = join(process.cwd(), config.output.dir, tag);

  let state: { repo?: string; ref?: string; sha?: string; preset?: string } = {};
  try {
    state = JSON.parse(await readFile(join(outDir, 'state.json'), 'utf-8'));
  } catch {
    console.error(
      `No state.json — a ref full build is required first:\n  mindcairn build <repo> --preset ${tag} --ref origin/staging --enrich`,
    );
    process.exit(1);
  }

  const repo = (args.flags.repo as string | undefined) ?? state.repo;
  const ref = (args.flags.ref as string | undefined) ?? state.ref;
  const presetName = state.preset ?? tag;
  if (!repo || !ref || !state.sha) {
    console.error('state.json is missing repo/ref/sha — recommend recreating with a full build.');
    process.exit(1);
  }

  const preset = await loadPreset(presetName);
  const strategy = JSON.parse(
    await readFile(join(outDir, 'indexing-strategy.json'), 'utf-8'),
  ) as IndexingStrategy;
  assertSpecMatchesEnv(strategy.embedding, `sync ${tag}`);
  const collection = collectionName(tag);
  const sqlitePath = join(outDir, 'chunks.sqlite');

  console.error(`▶ Mindcairn sync — tag=${tag}`);
  const snap = materializeRef(repo, ref, { fetch: !!args.flags.fetch });
  console.error(`  ref: ${ref}  ${state.sha.slice(0, 8)} → ${snap.sha.slice(0, 8)}`);

  if (snap.sha === state.sha) {
    console.log(`No changes — ${snap.sha.slice(0, 8)} already indexed.`);
    return;
  }

  const changed = changedFiles(repo, state.sha, snap.sha); // repo-relative
  const changedKt = changed.filter((p) => p.endsWith('.kt'));

  // The set of files in preset scope (worktree absolute paths)
  const presetAbs = new Set(
    await fg(preset?.include ?? ['**/*.kt'], {
      cwd: snap.root,
      absolute: true,
      ignore: preset?.exclude,
      onlyFiles: true,
    }),
  );
  // Indexing targets = changed + in preset scope + still present (edited/added)
  const onlyFiles = changedKt.map((p) => join(snap.root, p)).filter((p) => presetAbs.has(p));
  // stale = reindex targets (edited) + deleted files (not in the worktree)
  const onlyRel = onlyFiles.map((p) => relative(snap.root, p));
  const deletedRel = changedKt.filter((p) => !existsSync(join(snap.root, p)));
  const staleFiles = [...new Set([...onlyRel, ...deletedRel])];

  console.error(
    `  changed: ${changed.length} (.kt ${changedKt.length}) → reindex ${onlyFiles.length}, delete-cleanup ${deletedRel.length}`,
  );

  if (onlyFiles.length === 0 && staleFiles.length === 0) {
    console.log('No indexing-relevant changes — updating sha only.');
  } else {
    const enrich = args.flags['no-enrich'] ? false : true; // incremental enriches by default
    await build({
      strategy,
      rootPath: snap.root,
      collection,
      sqlitePath,
      enrich,
      include: preset?.include,
      exclude: preset?.exclude,
      incremental: true,
      onlyFiles,
      staleFiles,
    });
  }

  await writeFile(
    join(outDir, 'state.json'),
    JSON.stringify(
      { ...state, repo, ref, sha: snap.sha, preset: presetName, indexedAt: new Date().toISOString() },
      null,
      2,
    ),
    'utf-8',
  );
  console.log(`\n# Sync result`);
  console.log(`reindexed files: ${onlyFiles.length}  /  delete-cleanup: ${deletedRel.length}`);
  console.log(`state: ${ref}  ${state.sha.slice(0, 8)} → ${snap.sha.slice(0, 8)}`);
}

async function cmdEval() {
  const tag = (args.flags.tag as string | undefined) ?? args.positional[0];
  if (!tag) {
    console.error('Usage: mindcairn eval <tag>');
    process.exit(1);
  }
  const outDir = join(process.cwd(), config.output.dir, tag);
  const discovery = JSON.parse(await readFile(join(outDir, 'discovery.json'), 'utf-8')) as Discovery;
  const strategy = JSON.parse(await readFile(join(outDir, 'indexing-strategy.json'), 'utf-8')) as IndexingStrategy;

  // 1. Generate the eval set (reuse if one already exists)
  const evalPath = join(outDir, 'eval-set.json');
  let cases: EvalCase[];
  try {
    cases = JSON.parse(await readFile(evalPath, 'utf-8')) as EvalCase[];
    console.error(`▶ Mindcairn eval (using existing eval-set, ${cases.length} cases)`);
  } catch {
    console.error(`▶ Mindcairn eval (generating new eval-set)`);
    console.error(`  [1/2] EvalGenerator (${config.models.large}) ...`);
    const t = Date.now();
    const gen = await generateEvals({ discovery, strategy, count: 30 });
    console.error(
      `        ${gen.cases.length} cases in ${((Date.now() - t) / 1000).toFixed(1)}s  cost=$${gen.meta.costUsd.toFixed(3)}`,
    );
    cases = gen.cases;
    await writeFile(evalPath, JSON.stringify(cases, null, 2), 'utf-8');
  }

  // 2. judge
  console.error(`  [2/2] Judge (${config.models.fast}) — ${cases.length} cases ...`);
  const collection = collectionName(tag);
  const sqlitePath = join(process.cwd(), config.output.dir, tag, 'chunks.sqlite');
  const t1 = Date.now();
  const { report, totalCostUsd } = await judgeAll({ cases, collection, sqlitePath, strategy });
  const elapsed = (Date.now() - t1) / 1000;
  console.error(
    `        done in ${elapsed.toFixed(1)}s  judge cost=$${totalCostUsd.toFixed(3)}`,
  );

  const reportPath = join(outDir, 'eval-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log(`\n# Eval Report — ${tag}`);
  console.log(`Total: ${report.totalCases}`);
  console.log(`Passed: ${report.passed}/${report.totalCases} (${((report.passed / report.totalCases) * 100).toFixed(1)}%)`);
  console.log(`Average score: ${report.averageScore.toFixed(3)}`);
  console.log(`\nBy category:`);
  for (const [cat, v] of Object.entries(report.byCategory)) {
    console.log(`  ${cat}: ${v.passed}/${v.total}  avg=${v.avgScore.toFixed(3)}`);
  }
  if (report.failedSamples.length > 0) {
    console.log(`\nFailed (top 5):`);
    for (const f of report.failedSamples.slice(0, 5)) {
      console.log(`  - ${f.caseId}: ${f.judge.reasoning}`);
    }
  }
  console.log(`\n${reportPath}`);
}

/** Hybrid search straight from the terminal — for demo/debug (no MCP server needed, just an index) */
async function cmdSearch() {
  const tag = (args.flags.tag as string | undefined) ?? args.positional[0];
  const query = args.positional.slice(1).join(' ');
  if (!tag || !query) {
    console.error('Usage: mindcairn search <tag> "<query>" [--topK <n>]');
    process.exit(1);
  }
  const outDir = join(process.cwd(), config.output.dir, tag);
  const strategy = JSON.parse(
    await readFile(join(outDir, 'indexing-strategy.json'), 'utf-8'),
  ) as IndexingStrategy;
  const topK = Number(args.flags.topK ?? 5);
  const t = Date.now();
  const [vec] = await embedTexts({ spec: strategy.embedding, texts: [query] });
  const hits = await hybridSearch(collectionName(tag), vec, query, topK);
  const ms = Date.now() - t;
  console.log(`"${query}"  —  hybrid (BM25 + dense, RRF)  top-${topK}  ${ms}ms\n`);
  if (hits.length === 0) {
    console.log('(no results)');
    return;
  }
  hits.forEach((h, i) => {
    const p = h.payload;
    console.log(`  ${i + 1}. ${String(p.file ?? '')}   [${String(p.type ?? '')}]  score ${h.score.toFixed(3)}`);
    const label = String(p.label ?? '').trim().split('\n')[0];
    if (label) console.log(`     ${label}`);
  });
}

async function cmdImprove() {
  const tag = (args.flags.tag as string | undefined) ?? args.positional[0];
  if (!tag) {
    console.error('Usage: mindcairn improve <tag>');
    process.exit(1);
  }
  const outDir = join(process.cwd(), config.output.dir, tag);
  const strategy = JSON.parse(await readFile(join(outDir, 'indexing-strategy.json'), 'utf-8')) as IndexingStrategy;
  const report = JSON.parse(await readFile(join(outDir, 'eval-report.json'), 'utf-8')) as EvalReport;

  console.error(`▶ Mindcairn improve (${config.models.large}) ...`);
  const t = Date.now();
  const run = await runImprover({ report, strategy });
  console.error(
    `        done in ${((Date.now() - t) / 1000).toFixed(1)}s  cost=$${run.meta.costUsd.toFixed(3)}`,
  );

  const path = join(outDir, 'improve-suggestions.json');
  await writeFile(path, JSON.stringify(run, null, 2), 'utf-8');

  console.log(`\n# Improver diagnosis`);
  console.log(`\n## Diagnosis\n${run.diagnosis}`);
  console.log(`\n## Root causes`);
  for (const c of run.rootCauses) console.log(`- ${c}`);
  console.log(`\n## Suggested changes (${run.suggestedChanges.length})`);
  for (const s of run.suggestedChanges) {
    console.log(`- [${s.kind}] ${s.target}\n  ${s.rationale}`);
  }
  console.log(`\n## Expected impact\n${run.expectedImpact}`);
  console.log(`\n${path}`);
}

async function cmdServe() {
  const tag = (args.flags.tag as string | undefined) ?? args.positional[0];
  if (!tag) {
    console.error('Usage: mindcairn serve <tag>');
    process.exit(1);
  }
  // MCP HTTP server (:8765/mcp, StreamableHTTP)
  console.error(`▶ Mindcairn MCP server — tag=${tag}`);
  await runMcpServer(tag);
}

async function cmdAnalyze() {
  // discover + strategy in one go. (build / eval are wired in from W3+)
  const targetPath = args.positional[0];
  if (!targetPath) {
    console.error('Usage: mindcairn analyze <path> [--preset <name>]');
    process.exit(1);
  }
  // delegate to strategy (currently only goes up to strategy)
  await cmdStrategy();
}

function renderStrategyMarkdown(s: any, meta: any): string {
  return `# Indexing Strategy

> Autonomously designed by the Mindcairn Strategy Agent
> LLM: ${meta.modelUsed}  cost: $${meta.costUsd.toFixed(3)}  time: ${(meta.durationMs / 1000).toFixed(1)}s

## Storage
- **vector**: ${s.storage.vector}
${s.storage.structured ? `- **structured**: ${s.storage.structured}\n` : ''}${s.storage.graph ? `- **graph**: ${s.storage.graph}\n` : ''}
## Embedding
- ${s.embedding.provider} / ${s.embedding.model} (${s.embedding.dimensions}d)

## Chunkers (${s.chunkers.length})

${s.chunkers.map((c: any) => `### \`${c.name}\` — unit: ${c.unit}

**Matcher**
\`\`\`json
${JSON.stringify(c.matcher, null, 2)}
\`\`\`

**embeddingText template**
\`\`\`
${c.embeddingTextTemplate}
\`\`\`

**metadata keys**: ${c.metadataKeys.join(', ')}
`).join('\n')}

## Retrieval Quota
${Object.entries(s.retrievalQuota).map(([k, v]) => `- ${k}: ${v}`).join('\n')}
`;
}

function renderDiscoveryMarkdown(d: any, snap: any, meta: any): string {
  return `# Discovery — ${snap.rootPath.split('/').pop()}

> Autonomous analysis result from the Mindcairn Discovery Agent
> generated: ${snap.takenAt}
> files analyzed: ${snap.totalFiles} (${prettyBytes(snap.totalBytes)})
> LLM: ${meta.modelUsed}  cost: $${meta.costUsd.toFixed(3)}  time: ${(meta.durationMs / 1000).toFixed(1)}s

## Languages
${(d.language ?? []).map((l: string) => `- ${l}`).join('\n')}

## Frameworks
${(d.frameworks ?? []).map((f: string) => `- ${f}`).join('\n')}

## Build system
${d.buildSystem ?? '?'}

## Architecture pattern
${d.architecturePattern ?? '?'}

## Modules
${(d.modules ?? []).map((m: any) => `- **${m.name}** (\`${m.path}\`) — ${m.purpose}`).join('\n')}

## Conventions
${Object.entries(d.conventions ?? {}).map(([k, v]) => `- **${k}**: ${v}`).join('\n')}

## Domain hints
${(d.domainHints ?? []).join(', ')}

## Natural-language summary
${d.rawSummary ?? ''}
`;
}

function prettyBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let i = 0;
  const command = argv[i++] ?? '';
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positional.push(a);
      i += 1;
    }
  }
  return { command, positional, flags };
}

function printHelp() {
  console.log(`Mindcairn — autonomous codebase analysis agent

Usage:
  mindcairn init [--repo <path>] [--tag <name>] [--yes]   setup wizard — create preset → analyze → index → MCP guide (start here if new)
  mindcairn discover <path> [--preset <name>]
  mindcairn strategy <path> [--preset <name>]
  mindcairn strategy --from-discovery <path>        reuse Discovery
  mindcairn build <path> [--preset <name>] [--tag <name>] [--ref <ref>]  index per Strategy
  mindcairn sync <tag> [--ref <ref>] [--fetch] [--no-enrich]  incrementally reindex only .kt files changed since state.sha
  mindcairn search <tag> "<query>" [--topK <n>]     hybrid search from the terminal (check directly without MCP)
  mindcairn eval <tag>                              generate eval set + judge
  mindcairn improve <tag>                           diagnose eval results + suggest fixes (Loop 1)
  mindcairn serve <tag>                             MCP HTTP server (:8765/mcp)
  mindcairn analyze <path> [--preset <name>]        discover + strategy

Presets:
  defined in instances/<tag>/preset.ts (example: instances/example/preset.ts) — created automatically by init

ENV:
  EMBEDDING_PROVIDER  ollama(default) | openai — embedding provider
  MINDCAIRN_EMBED_MODEL   default: bge-m3(ollama) / text-embedding-3-small(openai)
  OPENAI_API_KEY      required when EMBEDDING_PROVIDER=openai
  ENRICHER            claude-cli | api | off | auto(default) — LLM chunk labeling at index time
  MINDCAIRN_LLM           claude-cli | api — force the agent LLM path (default: auto-detect)
  ANTHROPIC_API_KEY   for the api path (if absent, uses the Claude Code CLI OAuth)
  MINDCAIRN_MODEL_LARGE   default claude-opus-4-7
  MINDCAIRN_MODEL_FAST    default claude-haiku-4-5-20251001
  MINDCAIRN_CLAUDE_BIN    default 'claude' (override CLI location)
  MINDCAIRN_QDRANT_HOST   default http://localhost:6333
  MINDCAIRN_OLLAMA_HOST   default http://localhost:11434
  MINDCAIRN_MCP_PORT      default 8765
  MINDCAIRN_OUTPUT_DIR    default '.mindcairn'

LLM calls: API if ANTHROPIC_API_KEY is set, otherwise the Claude Code CLI (OAuth).
`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
