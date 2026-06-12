/**
 * Improver
 *
 * Input:  EvalReport + the current Strategy
 * Output: diagnosis + strategy improvement suggestions (free text + optionally a patched strategy)
 *
 * Core idea (Loop 1):
 *   When eval accuracy is low, autonomously diagnose "why?" → suggest strategy changes.
 *   Minimal version — outputs diagnosis only. Automatic re-build is a follow-up.
 */

import { z } from 'zod';
import { config } from '../config.ts';
import { callModelJson } from '../llm/index.ts';
import type { EvalReport, IndexingStrategy } from '../types.ts';

const AsString = z.preprocess(
  (v) => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    return JSON.stringify(v, null, 2);
  },
  z.string(),
);

const AsStringArray = z.preprocess(
  (v) => {
    if (v == null) return [];
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
    if (typeof v === 'string') return [v];
    return [JSON.stringify(v)];
  },
  z.array(z.string()),
);

const ImproveSchema = z.object({
  diagnosis: AsString,
  rootCauses: AsStringArray,
  suggestedChanges: z.preprocess(
    (v) => (v == null ? [] : v),
    z.array(
      z.object({
        target: AsString,
        kind: AsString,
        rationale: AsString,
        patch: AsString,
      }),
    ),
  ),
  expectedImpact: AsString,
});

const SYSTEM_PROMPT = `You are a RAG system tuning expert.

Given the eval-report and strategy:
1. Autonomously diagnose why accuracy is low
2. Extract root causes (missing chunker / wrong matcher / insufficient quota / weak embeddingText / etc.)
3. Suggest fixes (add/modify chunkers, adjust matchers, change quota, strengthen embeddingText)
4. Expected impact

Diagnosis principles:
- Closely compare the retrieved chunks in failedSamples against expectedReferences
- Reason like "this category scores low → probably this chunker's matcher is the issue"
- A patch should be a concrete, directly-implementable change

Return JSON only.`;

export type ImproveOptions = {
  report: EvalReport;
  strategy: IndexingStrategy;
};

export type ImproveRun = {
  diagnosis: string;
  rootCauses: string[];
  suggestedChanges: Array<{ target: string; kind: string; rationale: string; patch: string }>;
  expectedImpact: string;
  meta: { costUsd: number; durationMs: number; modelUsed: string };
};

export async function runImprover(opts: ImproveOptions): Promise<ImproveRun> {
  const userMessage = buildUserMessage(opts.report, opts.strategy);
  const resp = await callModelJson<unknown>({
    model: config.models.large,
    systemPrompt: SYSTEM_PROMPT,
    prompt: userMessage,
  });
  const parsed = ImproveSchema.parse(resp.result);
  return {
    diagnosis: parsed.diagnosis,
    rootCauses: parsed.rootCauses,
    suggestedChanges: parsed.suggestedChanges,
    expectedImpact: parsed.expectedImpact,
    meta: {
      costUsd: resp.costUsd,
      durationMs: resp.durationMs,
      modelUsed: resp.modelUsed,
    },
  };
}

function buildUserMessage(report: EvalReport, strategy: IndexingStrategy): string {
  const failedBlocks = report.failedSamples
    .slice(0, 8)
    .map((f, i) => {
      const retrievedSummary = f.retrieved
        .slice(0, 3)
        .map((r) => `    - [${r.type}] ${r.embeddingText.split('\n')[0]?.slice(0, 80)}`)
        .join('\n');
      return `### Failed #${i + 1} — ${f.caseId}\nscore=${f.judge.score.toFixed(2)}\njudge: ${f.judge.reasoning}\nretrieved top3:\n${retrievedSummary}`;
    })
    .join('\n\n');

  return `# Current Strategy summary

## Chunkers (${strategy.chunkers.length})
${strategy.chunkers.map((c) => `- ${c.name} (unit=${c.unit}) matcher=${JSON.stringify(c.matcher)}`).join('\n')}

## Quota
${Object.entries(strategy.retrievalQuota).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

# Eval Report
- Total: ${report.totalCases}
- Passed: ${report.passed} (${((report.passed / report.totalCases) * 100).toFixed(1)}%)
- AvgScore: ${report.averageScore.toFixed(3)}

## By category
${Object.entries(report.byCategory)
  .map(([cat, v]) => `- ${cat}: ${v.passed}/${v.total}  avg=${v.avgScore.toFixed(3)}`)
  .join('\n')}

## Failed samples (top 8)
${failedBlocks}

---

Return the diagnosis + improvement suggestions as JSON.`;
}
