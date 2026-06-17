/**
 * Embedding provider abstraction — ollama (default) | openai.
 *
 * Selection: EMBEDDING_PROVIDER=ollama|openai (default ollama)
 *   - ollama: MINDCAIRN_OLLAMA_HOST (default http://localhost:11434), default model bge-m3 (1024d)
 *   - openai: OPENAI_API_KEY required, default model text-embedding-3-small (1536d)
 *
 * Dimensions differ per provider, so the spec at index time is recorded in indexing-strategy.json,
 * and search (serve) uses that spec as-is. If env and strategy disagree,
 * assertSpecMatchesEnv() raises a clear error.
 */

import type { EmbeddingSpec } from '../types.ts';

const OLLAMA_HOST = process.env.MINDCAIRN_OLLAMA_HOST ?? 'http://localhost:11434';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';

const DEFAULTS: Record<'ollama' | 'openai', { model: string; dimensions: number }> = {
  ollama: { model: 'bge-m3', dimensions: 1024 },
  openai: { model: 'text-embedding-3-small', dimensions: 1536 },
};

/**
 * env → the embedding spec for the current environment.
 * modelOverride is for legacy compatibility (code/scripts that passed only a model string).
 */
export function resolveEmbeddingSpec(modelOverride?: string): EmbeddingSpec {
  const provider = (process.env.EMBEDDING_PROVIDER ?? 'ollama').toLowerCase();
  if (provider !== 'ollama' && provider !== 'openai') {
    throw new Error(
      `Unsupported EMBEDDING_PROVIDER: "${provider}" — only ollama or openai are allowed.`,
    );
  }
  const d = DEFAULTS[provider];
  const model = modelOverride ?? process.env.MINDCAIRN_EMBED_MODEL ?? d.model;
  const isDefaultModel = model === d.model || model === `${d.model}:latest`;
  let dimensions: number;
  if (process.env.MINDCAIRN_EMBED_DIM) {
    dimensions = Number(process.env.MINDCAIRN_EMBED_DIM);
  } else if (isDefaultModel) {
    dimensions = d.dimensions;
  } else {
    // A custom model whose dimensions we can't infer — refuse to guess. Silently falling back to the
    // default dimensions causes a dimension mismatch that breaks search without ever erroring.
    throw new Error(
      `Custom embedding model "${model}" requires MINDCAIRN_EMBED_DIM to be set explicitly ` +
        `(default ${d.model} is ${d.dimensions}d). Set MINDCAIRN_EMBED_DIM=<dim> and re-index.`,
    );
  }
  return { provider, model, dimensions };
}

/** Whether the provider is actually usable in the current environment (key present, etc.). If not, a helpful error. */
export function assertSpecUsable(spec: EmbeddingSpec) {
  if (spec.provider === 'openai' && !process.env.OPENAI_API_KEY) {
    throw new Error(
      `Embedding provider is openai but OPENAI_API_KEY is not set.\n` +
        `  Set OPENAI_API_KEY=sk-... in .env, or switch to EMBEDDING_PROVIDER=ollama and re-index.`,
    );
  }
  if (spec.provider !== 'ollama' && spec.provider !== 'openai') {
    throw new Error(
      `This index was built with embedding provider "${spec.provider}", but the current build supports only ollama|openai.\n` +
        `  Set EMBEDDING_PROVIDER and re-index (mindcairn init/build).`,
    );
  }
}

/**
 * Error if EMBEDDING_PROVIDER is set in env and differs from the index's (strategy's) provider.
 * Searching with a provider other than the one used for the index gives meaningless results
 * because the dimensions/space differ.
 */
export function assertSpecMatchesEnv(spec: EmbeddingSpec, context: string) {
  const envProvider = process.env.EMBEDDING_PROVIDER?.toLowerCase();
  if (envProvider && envProvider !== spec.provider) {
    throw new Error(
      `[${context}] Embedding provider mismatch — the index was built with ${spec.provider}/${spec.model} (${spec.dimensions}d), ` +
        `but the current EMBEDDING_PROVIDER=${envProvider}.\n` +
        `  Match the provider (EMBEDDING_PROVIDER=${spec.provider}), or re-index with the new provider (mindcairn init/build).`,
    );
  }
  assertSpecUsable(spec);
}

export type EmbedOptions = {
  texts: string[];
  concurrency?: number;
  /** Recommended: pass the embedding spec from indexing-strategy as-is (ensures index/search consistency) */
  spec?: EmbeddingSpec;
  /** legacy: model string only — provider is determined by env */
  model?: string;
};

export async function embedTexts(opts: EmbedOptions): Promise<number[][]> {
  const spec = opts.spec ?? resolveEmbeddingSpec(opts.model);
  assertSpecUsable(spec);
  if (spec.provider === 'openai') {
    return embedOpenai(spec.model, opts.texts, spec.dimensions);
  }
  return embedOllama(spec.model, opts.texts, opts.concurrency ?? 4);
}

// ---------- ollama ----------

async function embedOllama(
  model: string,
  texts: string[],
  concurrency: number,
): Promise<number[][]> {
  const results: number[][] = new Array(texts.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= texts.length) return;
      results[i] = await embedOllamaOne(model, texts[i]);
    }
  }
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}

async function embedOllamaOne(model: string, text: string): Promise<number[]> {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_HOST}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
    });
  } catch (e) {
    throw new Error(
      `Failed to connect to Ollama (${OLLAMA_HOST}) — cannot embed.\n` +
        `  1) Start Ollama: ollama serve (or launch the Ollama app)\n` +
        `  2) Install the model: ollama pull ${model}\n` +
        `  For a different host, set MINDCAIRN_OLLAMA_HOST. To use OpenAI embeddings, set EMBEDDING_PROVIDER=openai.\n` +
        `  Cause: ${(e as Error).message}`,
    );
  }
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 404 || /not found/i.test(body)) {
      throw new Error(
        `Ollama does not have the model "${model}".\n  Install: ollama pull ${model}\n  (response: ${res.status} ${body.slice(0, 200)})`,
      );
    }
    throw new Error(`Ollama embed failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as { embeddings: number[][] };
  return json.embeddings[0];
}

// ---------- openai ----------

const OPENAI_BATCH = 100;

async function embedOpenai(
  model: string,
  texts: string[],
  dimensions: number,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += OPENAI_BATCH) {
    const batch = texts.slice(i, i + OPENAI_BATCH);
    let res: Response;
    try {
      res = await fetch(`${OPENAI_BASE_URL}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        // text-embedding-3-* supports the dimensions parameter — force the dimensions recorded in strategy
        body: JSON.stringify({ model, input: batch, dimensions }),
      });
    } catch (e) {
      throw new Error(
        `Failed to connect to OpenAI (${OPENAI_BASE_URL}) — check network/proxy.\n  Cause: ${(e as Error).message}`,
      );
    }
    if (!res.ok) {
      const body = await res.text();
      if (res.status === 401) {
        throw new Error(
          `OpenAI authentication failed (401) — check OPENAI_API_KEY.\n  (response: ${body.slice(0, 200)})`,
        );
      }
      throw new Error(`OpenAI embeddings failed: ${res.status} ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as {
      data: Array<{ index: number; embedding: number[] }>;
    };
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    out.push(...sorted.map((d) => d.embedding));
  }
  return out;
}
