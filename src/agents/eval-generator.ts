/**
 * EvalGenerator
 *
 * Input:  Discovery + Strategy (optional: chunk samples)
 * Output: EvalCase[]
 *
 * Core idea:
 *   Looking at the codebase, the LLM autonomously generates "N frequently-asked questions" + ground-truth answers.
 *   No human needs to hand-write the eval set.
 */

import { z } from 'zod';
import { config } from '../config.ts';
import { callModelJson } from '../llm/index.ts';
import type { Discovery, IndexingStrategy, EvalCase } from '../types.ts';

const EvalCaseSchema = z.object({
  id: z.string(),
  question: z.string(),
  expectedReferences: z.preprocess(
    (v) => (v == null ? [] : v),
    z.array(z.string()),
  ),
  expectedAnswer: z.preprocess(
    (v) => (v == null ? undefined : v),
    z.string().optional(),
  ),
  difficulty: z.string(),
  category: z.string(),
});

const EvalSchema = z.preprocess(
  (v) => (Array.isArray(v) ? { cases: v } : v),
  z.object({ cases: z.array(EvalCaseSchema) }),
);

const SYSTEM_PROMPT = `You generate the eval set for a codebase.

Given the Discovery (codebase understanding) + Strategy (chunking strategy),
generate "questions a developer on this codebase would frequently ask an LLM".

Each case has:
- id: case-001, case-002 ... format
- question: natural-language question (any language)
- expectedReferences: symbols that help answer it — **only symbols highly likely to actually exist in the codebase**
- expectedAnswer: free-text explanation of the answer's meaning (optional, key)
- difficulty: "easy" | "medium" | "hard"
- category: schema / convention / pattern / domain / api / batch / migration / etc

⚠️ Important — no unrealistic questions:
- Do NOT pin down an exact method name (like findByMemberNo). Real method names vary across codebases.
- Instead ask at the **capability level**, like "what's the pattern for looking up a member's order history?".
- expectedReferences should be **only symbols you're confident about** (e.g. table/entity/domain-model names).
- Do NOT put method/utility-function names in expectedReferences — those involve guessing.
- expectedAnswer should focus on meaning/pattern (intent over implementation detail).

Example questions (e.g. a commerce domain):
- "How are order completed/canceled status codes represented?" (convention) refs=[order_status]
- "Where is order item info stored?" (schema) refs=[OrderItem, order_item]
- "Where and how is a member's order history looked up?" (pattern) refs=[Order, memberId]
- "What's the bulk-INSERT pattern in migrations?" (migration) refs=[migration]
- "How does the Repository + Impl separation convention work?" (convention) refs=[Repository]

30 total. Diverse categories.`;

export type EvalGenOptions = {
  discovery: Discovery;
  strategy: IndexingStrategy;
  count?: number;
};

export type EvalGenRun = {
  cases: EvalCase[];
  meta: { costUsd: number; durationMs: number; modelUsed: string };
};

export async function generateEvals(opts: EvalGenOptions): Promise<EvalGenRun> {
  const count = opts.count ?? config.limits.evalCaseCount ?? 30;
  const userMessage = buildUserMessage(opts.discovery, opts.strategy, count);

  const resp = await callModelJson<unknown>({
    model: config.models.large,
    systemPrompt: SYSTEM_PROMPT,
    prompt: userMessage,
  });

  const parsed = EvalSchema.parse(resp.result);
  return {
    cases: parsed.cases as EvalCase[],
    meta: {
      costUsd: resp.costUsd,
      durationMs: resp.durationMs,
      modelUsed: resp.modelUsed,
    },
  };
}

function buildUserMessage(d: Discovery, s: IndexingStrategy, count: number): string {
  return `Request: generate the eval set for this codebase.

# Discovery
- domain: ${d.rawSummary}
- domain hints: ${d.domainHints.join(', ')}
- conventions:
${Object.entries(d.conventions).map(([k, v]) => `  - ${k}: ${v}`).join('\n')}
- frameworks: ${d.frameworks.join(', ')}
- architecture: ${d.architecturePattern}

# Chunker kinds in the Strategy
${s.chunkers.map((c) => `- ${c.name} (${c.unit}) — ${c.metadataKeys.join(', ')}`).join('\n')}

---

Generate ${count} questions a developer on this codebase would frequently ask. As JSON.`;
}
