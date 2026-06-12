/**
 * Judge
 *
 * Input: EvalCase[] + collection (Qdrant)
 * Flow:
 *   for each case
 *     1. question → embedding
 *     2. Qdrant search topK
 *     3. retrieved chunks + expected → LLM judge (0..1 score)
 *   aggregate → EvalReport
 */

import { z } from 'zod';
import { config } from '../config.ts';
import { callModelJson } from '../llm/index.ts';
import { embedTexts } from '../builder/embedder.ts';
import { searchPoints } from '../builder/qdrant.ts';
import { ChunkStore } from '../builder/sqlite-store.ts';
import type { EvalCase, EvalReport, EvalResult, IndexingStrategy } from '../types.ts';

const JudgeSchema = z.object({
  correct: z.boolean(),
  score: z.number(),
  reasoning: z.string(),
});

const JUDGE_SYSTEM = `You are an evaluator of RAG search results.

As a backend developer working on this codebase, judge whether the question can be answered **practically** using only the retrieved chunks.

Judging principles (important):
- Evaluate mainly on **semantic sufficiency**. Do NOT require exact symbol-name matches.
- expectedReferences is a reference only. If the actual code has a same-purpose method under a different name, count it as correct.
- e.g. if the question is "look up a member's order history" with expectedReferences=findByMemberId, and the retrieved chunks contain a same-purpose method like getMyOrders(memberId), that's ✓
- For expectedAnswer free text, it's OK if the meaning can be derived from the retrieved chunks
- Credit it if the domain meaning / business rule / pattern is revealed in the retrieved chunks
- However, if a core domain model / table like "Order" is entirely absent, it's ✗

Score:
- 1.0 = can answer the question perfectly
- 0.7–0.9 = can answer (some detail missing)
- 0.4–0.6 = partial. some of the core is present
- 0.0–0.3 = lacks the core info needed to answer
- correct = true: score >= 0.5

Return:
- correct: boolean
- score: 0..1
- reasoning: short English (why that score)

Return JSON only.`;

export type JudgeOptions = {
  cases: EvalCase[];
  collection: string;
  sqlitePath: string;
  strategy: IndexingStrategy;
  topK?: number;
};

export type JudgeRun = {
  report: EvalReport;
  totalCostUsd: number;
};

export async function judgeAll(opts: JudgeOptions): Promise<JudgeRun> {
  const { cases, collection, strategy } = opts;
  const topK = opts.topK ?? 10;

  const store = new ChunkStore(opts.sqlitePath);

  // Embed all questions at once
  const queryEmbeddings = await embedTexts({
    spec: strategy.embedding,
    texts: cases.map((c) => c.question),
    concurrency: 6,
  });

  const results: EvalResult[] = [];
  let totalCost = 0;
  const byCat: Record<string, { total: number; passed: number; sumScore: number }> = {};

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const hits = await searchPoints(collection, queryEmbeddings[i], topK);
    // Qdrant payload has labels only → fetch the body from SQLite
    const chunkIds = hits.map((h) => String(h.payload.chunkId ?? ''));
    const stored = store.getMany(chunkIds);
    const storedById = new Map(stored.map((s) => [s.id, s]));
    const retrieved = hits.map((h) => {
      const id = String(h.payload.chunkId ?? '');
      const s = storedById.get(id);
      return {
        score: h.score,
        type: s?.type ?? String(h.payload.type ?? ''),
        file: s?.file ?? String(h.payload.file ?? ''),
        embeddingText: s?.embeddingText ?? '',
        rawContent: s?.rawContent ?? '',
        label: s?.enrichedLabel ?? String(h.payload.label ?? ''),
      };
    });

    const judgePrompt = buildJudgePrompt(c, retrieved);
    const resp = await callModelJson<unknown>({
      model: config.models.fast,
      systemPrompt: JUDGE_SYSTEM,
      prompt: judgePrompt,
    });
    totalCost += resp.costUsd;

    let verdict: { correct: boolean; score: number; reasoning: string };
    try {
      verdict = JudgeSchema.parse(resp.result);
    } catch {
      verdict = { correct: false, score: 0, reasoning: 'judge schema parse failed' };
    }

    results.push({
      caseId: c.id,
      retrieved: retrieved.map((r) => ({
        id: '',
        type: r.type,
        embeddingText: r.embeddingText,
        rawContent: r.rawContent,
        metadata: { label: r.label, file: r.file },
        score: r.score,
      })),
      judge: verdict,
    });

    const cat = c.category;
    if (!byCat[cat]) byCat[cat] = { total: 0, passed: 0, sumScore: 0 };
    byCat[cat].total++;
    byCat[cat].sumScore += verdict.score;
    if (verdict.correct) byCat[cat].passed++;

    // progress log
    process.stderr.write(
      `\r  judge ${i + 1}/${cases.length}  ${verdict.correct ? '✓' : '✗'} (${verdict.score.toFixed(2)})        `,
    );
  }
  process.stderr.write('\n');
  store.close();

  const passed = results.filter((r) => r.judge.correct).length;
  const avgScore =
    results.reduce((acc, r) => acc + r.judge.score, 0) / Math.max(results.length, 1);

  const report: EvalReport = {
    totalCases: results.length,
    passed,
    averageScore: avgScore,
    byCategory: Object.fromEntries(
      Object.entries(byCat).map(([k, v]) => [
        k,
        { total: v.total, passed: v.passed, avgScore: v.sumScore / v.total },
      ]),
    ),
    failedSamples: results.filter((r) => !r.judge.correct).slice(0, 10),
  };

  return { report, totalCostUsd: totalCost };
}

function buildJudgePrompt(
  c: EvalCase,
  retrieved: Array<{
    score: number;
    type: string;
    file: string;
    embeddingText: string;
    rawContent: string;
    label: string;
  }>,
): string {
  const retrievedBlocks = retrieved
    .map(
      (r, i) =>
        `### ${i + 1}. [${r.type}] score=${r.score.toFixed(3)} file=${r.file}
[label] ${r.label}
[body]
${r.rawContent.slice(0, 1500)}`,
    )
    .join('\n\n');

  return `# Evaluation target

## Question
${c.question}

## Symbols the answer should include (expectedReferences)
${c.expectedReferences.join(', ') || '(none)'}

${c.expectedAnswer ? `## Answer explanation (expectedAnswer)\n${c.expectedAnswer}\n` : ''}

## Category / difficulty
${c.category} / ${c.difficulty}

# ${retrieved.length} chunks retrieved by the search system

${retrievedBlocks}

---

Are the retrieved chunks above sufficient to answer the question? Evaluate as JSON.`;
}
