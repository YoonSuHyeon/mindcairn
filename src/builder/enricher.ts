/**
 * LLM Enricher v2 — Type-Aware Structured Label.
 *
 * Attach an LLM semantic label + structured identifiers to each chunk.
 * Embedding input = label + identifiers (not the body) → less noise, higher search quality.
 *
 *   Input:  Chunk (a different prompt per type)
 *   Output:
 *     - code chunk     → Structured Label (className/methods/columns/enums/tables/keywords)
 *     - doc chunk      → Rich Label (3–5 lines of natural language + key keywords)
 *     - captured chunk → short label (already human-written)
 *
 * Model: a fast model (e.g. Haiku — cheap/fast)
 * Batch: 15 chunks/request
 */

import { z } from 'zod';
import { config } from '../config.ts';
import { callModelJson, resolveEnricherMode, type LlmMode } from '../llm/index.ts';
import type { Chunk } from '../types.ts';

const NullishString = z.preprocess(
  (v) => (v == null ? undefined : v),
  z.string().optional(),
);

const NullishArr = z.preprocess(
  (v) => (v == null ? [] : v),
  z.array(z.string()),
);

const IdentifiersSchema = z.preprocess(
  (v) => (v == null ? {} : v),
  z
    .object({
      className: NullishString,
      methods: NullishArr,
      columns: NullishArr,
      tables: NullishArr,
      enums: NullishArr,
      keywords: NullishArr,
    })
    .partial(),
);

const EnrichItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  identifiers: IdentifiersSchema,
  domain: NullishString,
});

const LabelsSchema = z.preprocess(
  (v) => (Array.isArray(v) ? { labels: v } : v),
  z.object({ labels: z.array(EnrichItemSchema) }),
);

const SYSTEM_PROMPT = `You label codebase + document chunks.

Look at each chunk's type and produce enrichment in the appropriate form.
Write labels/keywords in the same language as the chunk's content (English content → English label).

## Common output — every chunk
{
  "id": "<chunk id>",
  "label": "<semantic label>",
  "identifiers": {
    "className": "...",        // code chunk — class name
    "methods": ["..."],        // code chunk — method names
    "columns": ["..."],        // DB column names (snake_case)
    "tables": ["..."],         // table names
    "enums": ["..."],          // enum names or code values ("400=closed" form)
    "keywords": ["..."]        // search keywords (domain terms / identifiers)
  },
  "domain": "order|member|payment|..." // estimated domain
}

## Per-type guide

### Code chunks (kt_entity / repository_method / repository / domain_model / domain_mapper / api_controller_endpoint / batch_job / migration_sql_builder / shared_util / shared_util_method / shared_base / shared_exception / code_enum_value / notification_template)
- label: one line (~80 chars) — natural language for "what this code does"
- fill identifiers richly (extract className/methods/columns/enums all)
- keywords: all the identifiers + domain terms that searches should match

Example (code_enum_value):
{
  "label": "order lifecycle status enum",
  "identifiers": {
    "className": "OrderStatus",
    "enums": ["CREATED=created", "PAID=paid", "SHIPPED=shipped", "DELIVERED=delivered", "CANCELLED=cancelled"],
    "columns": ["order_status"],
    "keywords": ["order status", "shipping", "cancel", "payment"]
  },
  "domain": "order"
}

Example (repository_method):
{
  "label": "count first orders placed within 30 days of signup",
  "identifiers": {
    "className": "OrderJpaRepository",
    "methods": ["countFirstOrdersByMember"],
    "tables": ["orders"],
    "columns": ["member_id", "ordered_at", "paid_at"],
    "keywords": ["member", "first order", "payment completed", "30 days"]
  },
  "domain": "order"
}

### Document chunks (notion_section / doc_spec / doc_design / doc_qa / doc_ops / doc_data / doc_infra / doc_misc)
- label: 3–5 lines (Rich Label) — intent/target/key decisions/keywords used/metrics/purpose
- per-type emphasis:
  - doc_spec: requirements / expected results / target screens·features
  - doc_design: implementation flow / changed modules / API changes
  - doc_qa: test scenarios / verification points / issues found
  - doc_ops: deploy steps / monitoring / ops policy
  - doc_data: analysis intent / tables·columns used / formulas
  - doc_infra: system topology / network / permissions
- identifiers.tables / columns: extract every table/column referenced inside SQL
- identifiers.keywords: analysis intent + domain terms + identifiers like task IDs

Example (doc_data):
{
  "label": "Measure new members' first-order conversion within 7 days. Based on created_at at signup + ordered_at within 7 days. Computes monthly first_order / total_signup ratio.",
  "identifiers": {
    "tables": ["members", "orders"],
    "columns": ["member_id", "created_at", "ordered_at"],
    "keywords": ["new member", "7 days", "first-order conversion", "monthly aggregation", "activation analysis"]
  },
  "domain": "member"
}

Example (doc_design):
{
  "label": "Decision to remove the issue-date field from the invoice PDF parsing response. Date format varies by locale, making validation impossible. Parser for auto-registering invoices. Endpoint /api/v1/invoice/parse.",
  "identifiers": {
    "keywords": ["PDF parsing", "invoice", "validation", "TASK-1234", "invoiceDate", "locale"]
  },
  "domain": "order"
}

### Captured chunks (captured_decision)
- label: one line (reuse the user-written title)
- identifiers: extract from the body

Return strict JSON.`;

export type EnrichOptions = {
  chunks: Chunk[];
  model?: string;
  batchSize?: number;
  concurrency?: number;
  /** Don't re-call chunks that already have a label (cache keyed by idempotent chunk id) */
  existingLabels?: Map<string, string>;
};

export type EnrichRun = {
  enrichedChunks: Chunk[];
  totalCostUsd: number;
  totalDurationMs: number;
  cacheHits: number;
};

let warnedOff = false;

export async function enrichChunks(opts: EnrichOptions): Promise<EnrichRun> {
  // ENRICHER=off (or auto with no LLM path) → pass through without labels
  const mode = resolveEnricherMode();
  if (mode === 'off') {
    if (!warnedOff) {
      process.stderr.write(
        `  ⚠ enricher off — indexing without LLM labels (search quality somewhat lower). Enable: ENRICHER=claude-cli|api\n`,
      );
      warnedOff = true;
    }
    return { enrichedChunks: opts.chunks, totalCostUsd: 0, totalDurationMs: 0, cacheHits: 0 };
  }
  const llmMode: LlmMode = mode; // 'off' already returned above — preserves narrowing inside the closure

  const model = opts.model ?? config.models.fast;
  const batchSize = opts.batchSize ?? 15;
  const concurrency = opts.concurrency ?? 4;
  const cache = opts.existingLabels ?? new Map<string, string>();

  // skip chunks already in cache
  const toCall = opts.chunks.filter((c) => !cache.has(c.id));
  const cacheHits = opts.chunks.length - toCall.length;
  if (cacheHits > 0) {
    process.stderr.write(`  enrich cache hits: ${cacheHits}/${opts.chunks.length}\n`);
  }

  const batches: Chunk[][] = [];
  for (let i = 0; i < toCall.length; i += batchSize) {
    batches.push(toCall.slice(i, i + batchSize));
  }

  let totalCost = 0;
  const t0 = Date.now();
  const labelMap = new Map<string, string>(cache);
  const identifierMap = new Map<string, Record<string, unknown>>();
  let done = 0;

  let cursor = 0;
  const workers = Array.from({ length: concurrency }, () => worker());
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= batches.length) return;
      const batch = batches[idx];
      const { items, costUsd } = await labelBatch(model, batch, llmMode);
      totalCost += costUsd;
      for (const item of items) {
        labelMap.set(item.id, item.label);
        identifierMap.set(item.id, {
          identifiers: item.identifiers,
          domain: item.domain ?? '',
        });
      }
      done += batch.length;
      process.stderr.write(
        `\r  enrich ${done}/${opts.chunks.length}  $${totalCost.toFixed(3)}        `,
      );
    }
  }
  await Promise.all(workers);
  process.stderr.write('\n');

  // Labeling-failure summary — warn explicitly so we don't silently build a low-quality index
  const unlabeled = opts.chunks.filter((c) => !labelMap.has(c.id)).length;
  if (unlabeled > 0) {
    process.stderr.write(
      `  ⚠ ${unlabeled}/${opts.chunks.length} chunks failed labeling (rate limit etc.) — indexed without labels.\n` +
        `    Re-running the same command skips successful labels via cache and retries only the failures.\n`,
    );
  }

  const enrichedChunks: Chunk[] = opts.chunks.map((c) => {
    const label = labelMap.get(c.id);
    if (!label) return c;
    const extra = identifierMap.get(c.id) ?? {};
    return {
      ...c,
      embeddingText: `[label] ${label}\n${c.embeddingText}`,
      metadata: { ...c.metadata, enrichedLabel: label, ...extra },
    };
  });

  return {
    enrichedChunks,
    totalCostUsd: totalCost,
    totalDurationMs: Date.now() - t0,
    cacheHits,
  };
}

const BATCH_RETRIES = 2;
const RETRY_DELAY_MS = [3_000, 15_000]; // wait for rate-limit (e.g. 429) recovery

async function labelBatch(
  model: string,
  batch: Chunk[],
  mode: LlmMode,
): Promise<{
  items: Array<z.infer<typeof EnrichItemSchema>>;
  costUsd: number;
}> {
  const userMessage = buildBatchMessage(batch);
  let costUsd = 0;
  for (let attempt = 0; attempt <= BATCH_RETRIES; attempt++) {
    try {
      const resp = await callModelJson<unknown>({
        mode,
        model,
        systemPrompt: SYSTEM_PROMPT,
        prompt: userMessage,
      });
      costUsd += resp.costUsd;
      const parsed = LabelsSchema.parse(resp.result);
      return { items: parsed.labels, costUsd };
    } catch (e) {
      const firstLine = (e as Error).message.split('\n')[0].slice(0, 200);
      if (attempt < BATCH_RETRIES) {
        process.stderr.write(
          `\n  enrich batch fail (retry ${attempt + 1}/${BATCH_RETRIES}): ${firstLine}\n`,
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS[attempt] ?? 15_000));
      } else {
        process.stderr.write(`\n  enrich batch fail (giving up): ${firstLine}\n`);
      }
    }
  }
  return { items: [], costUsd };
}

function buildBatchMessage(batch: Chunk[]): string {
  const blocks = batch
    .map((c) => {
      const text =
        c.embeddingText.length > 1500
          ? c.embeddingText.slice(0, 1500) + '...'
          : c.embeddingText;
      const raw =
        c.rawContent.length > 1500
          ? c.rawContent.slice(0, 1500) + '...'
          : c.rawContent;
      return `### id: ${c.id}\ntype: ${c.type}\nembeddingText:\n\`\`\`\n${text}\n\`\`\`\nrawContent:\n\`\`\`\n${raw}\n\`\`\``;
    })
    .join('\n\n');
  return `# ${batch.length} chunks

${blocks}

Look at each chunk's type and produce enrichment in the appropriate form. Return JSON.`;
}
