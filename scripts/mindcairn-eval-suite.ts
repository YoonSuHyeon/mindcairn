/**
 * Golden Set automated evaluation — detects mindcairn search quality regressions.
 *
 *   bun run scripts/mindcairn-eval-suite.ts [tag]
 *
 * Input: instances/<instance>/golden-set.json (or .mindcairn/<tag>/golden-set.json)
 * Output:
 *   - per-case score + overall average
 *   - .mindcairn/<tag>/evals-suite-<date>.json
 *   - comparison against the previous run → regression alert
 *
 * Run manually once a week or after a mindcairn change. If the score drops, track down what broke.
 */

import { join } from 'node:path';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { embedTexts } from '../src/builder/embedder.ts';
import { searchPoints } from '../src/builder/qdrant.ts';
import { ChunkStore } from '../src/builder/sqlite-store.ts';
import { config } from '../src/config.ts';
import type { IndexingStrategy } from '../src/types.ts';

type GoldenCase = {
  label: string;
  query: string;
  expectedChunkIds?: string[];
  expectedTypes?: string[];
  expectedKeywords?: string[];
  topK?: number;
};

type CaseResult = {
  label: string;
  query: string;
  overall: number;
  recallChunkId: number;
  typeMatchRatio: number;
  keywordHitRatio: number;
  mrr: number;
  topHits: Array<{ rank: number; score: number; type: string; chunkId: string }>;
};

const TAG = process.argv[2] ?? 'my-project';

async function main() {
  const outDir = join(process.cwd(), config.output.dir, TAG);
  const strategy = JSON.parse(
    await readFile(join(outDir, 'indexing-strategy.json'), 'utf-8'),
  ) as IndexingStrategy;
  const collection = `mindcairn_${TAG.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  const sqlitePath = join(outDir, 'chunks.sqlite');

  // load golden set — instance folder first, otherwise .mindcairn/<tag>/
  const goldenPath = await resolveGoldenPath(TAG, outDir);
  if (!goldenPath) {
    console.error(`✗ golden-set.json not found.`);
    console.error(`  candidate locations to create it:`);
    console.error(`    instances/${TAG}/golden-set.json`);
    console.error(`    .mindcairn/${TAG}/golden-set.json`);
    process.exit(1);
  }
  const goldenSet = JSON.parse(await readFile(goldenPath, 'utf-8')) as { cases: GoldenCase[] };
  console.error(`▶ Golden set: ${goldenPath}  (${goldenSet.cases.length} cases)`);

  const store = new ChunkStore(sqlitePath);
  const results: CaseResult[] = [];

  for (const c of goldenSet.cases) {
    const topK = c.topK ?? 10;
    const [vec] = await embedTexts({ model: strategy.embedding.model, texts: [c.query] });
    const hits = await searchPoints(collection, vec, topK);
    const hitIds = hits.map((h) => String(h.payload.chunkId ?? ''));
    const stored = store.getMany(hitIds);

    let recallChunkId = 0;
    if (c.expectedChunkIds?.length) {
      const found = hitIds.filter((id) => c.expectedChunkIds!.includes(id));
      recallChunkId = found.length / c.expectedChunkIds.length;
    }
    let typeMatchRatio = 0;
    if (c.expectedTypes?.length) {
      const hitTypes = stored.map((s) => s.type);
      const matched = hitTypes.filter((t) => c.expectedTypes!.includes(t));
      typeMatchRatio = matched.length / topK;
    }
    let keywordHitRatio = 0;
    if (c.expectedKeywords?.length) {
      const haystack = stored
        .map((s) => `${s.enrichedLabel ?? ''}\n${s.rawContent}`.toLowerCase())
        .join('\n');
      const found = c.expectedKeywords.filter((k) => haystack.includes(k.toLowerCase()));
      keywordHitRatio = found.length / c.expectedKeywords.length;
    }
    let mrr = 0;
    if (c.expectedChunkIds?.length) {
      for (let i = 0; i < hitIds.length; i++) {
        if (c.expectedChunkIds.includes(hitIds[i])) {
          mrr = 1 / (i + 1);
          break;
        }
      }
    }
    const parts: number[] = [];
    if (c.expectedChunkIds?.length) parts.push(recallChunkId, mrr);
    if (c.expectedTypes?.length) parts.push(typeMatchRatio);
    if (c.expectedKeywords?.length) parts.push(keywordHitRatio);
    const overall = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;

    results.push({
      label: c.label,
      query: c.query,
      overall,
      recallChunkId,
      typeMatchRatio,
      keywordHitRatio,
      mrr,
      topHits: hits.slice(0, 3).map((h, i) => ({
        rank: i + 1,
        score: h.score,
        type: String(h.payload.type ?? ''),
        chunkId: String(h.payload.chunkId ?? ''),
      })),
    });

    process.stderr.write(
      `\r  ${results.length}/${goldenSet.cases.length}  avg=${(
        (results.reduce((s, r) => s + r.overall, 0) / results.length) *
        100
      ).toFixed(1)}%  `,
    );
  }
  process.stderr.write('\n');
  store.close();

  const today = new Date().toISOString().slice(0, 10);
  const summary = {
    at: new Date().toISOString(),
    tag: TAG,
    cases: results.length,
    avgOverall: results.reduce((s, r) => s + r.overall, 0) / results.length,
    avgRecallChunkId: results.reduce((s, r) => s + r.recallChunkId, 0) / results.length,
    avgTypeMatch: results.reduce((s, r) => s + r.typeMatchRatio, 0) / results.length,
    avgKeywordHit: results.reduce((s, r) => s + r.keywordHitRatio, 0) / results.length,
    avgMrr: results.reduce((s, r) => s + r.mrr, 0) / results.length,
    results,
  };

  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `evals-suite-${today}.json`);
  await writeFile(outPath, JSON.stringify(summary, null, 2), 'utf-8');

  // compare against the previous run (regression alert)
  const previousPath = await findPreviousRun(outDir, outPath);
  let regression = '';
  if (previousPath) {
    const prev = JSON.parse(await readFile(previousPath, 'utf-8')) as typeof summary;
    const diff = summary.avgOverall - prev.avgOverall;
    if (diff < -0.05) {
      regression = `\n⚠️ Regression detected! overall avg ${(diff * 100).toFixed(1)}% (previous=${(prev.avgOverall * 100).toFixed(1)}%, current=${(summary.avgOverall * 100).toFixed(1)}%)\n`;
      // top 3 biggest per-case drops
      const caseDeltas: Array<{ label: string; delta: number }> = [];
      for (const cur of summary.results) {
        const prv = prev.results.find((p) => p.label === cur.label);
        if (prv) caseDeltas.push({ label: cur.label, delta: cur.overall - prv.overall });
      }
      const dropped = caseDeltas.filter((c) => c.delta < -0.1).sort((a, b) => a.delta - b.delta);
      if (dropped.length > 0) {
        regression += `  dropped cases:\n`;
        for (const d of dropped.slice(0, 5)) {
          regression += `    - ${d.label}: ${(d.delta * 100).toFixed(1)}%\n`;
        }
      }
    }
  }

  console.log(`# mindcairn eval suite — ${TAG}  (${today})

cases:           ${summary.cases}
overall avg:     ${(summary.avgOverall * 100).toFixed(1)}%
recall(chunkId): ${(summary.avgRecallChunkId * 100).toFixed(1)}%
typeMatch:       ${(summary.avgTypeMatch * 100).toFixed(1)}%
keywordHit:      ${(summary.avgKeywordHit * 100).toFixed(1)}%
MRR:             ${summary.avgMrr.toFixed(3)}
${regression}
saved: ${outPath}`);
}

async function resolveGoldenPath(tag: string, outDir: string): Promise<string | null> {
  const candidates = [
    join(process.cwd(), 'instances', tag, 'golden-set.json'),
    join(outDir, 'golden-set.json'),
  ];
  for (const p of candidates) {
    try {
      await readFile(p);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

async function findPreviousRun(outDir: string, currentPath: string): Promise<string | null> {
  try {
    const files = await readdir(outDir);
    const evalFiles = files
      .filter((f) => f.startsWith('evals-suite-') && f.endsWith('.json') && join(outDir, f) !== currentPath)
      .sort()
      .reverse();
    return evalFiles[0] ? join(outDir, evalFiles[0]) : null;
  } catch {
    return null;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
