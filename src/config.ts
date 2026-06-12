/**
 * Mindcairn global config.
 * Environment variables + defaults.
 *
 * LLM call path (auto-detected in src/llm/index.ts):
 *   - if ANTHROPIC_API_KEY is set, call the Anthropic API directly
 *   - otherwise use the Claude Code CLI (OAuth — no API key needed)
 *   - force a choice: MINDCAIRN_LLM=claude-cli|api
 *
 * Embedding is EMBEDDING_PROVIDER=ollama|openai (src/builder/embedder.ts).
 * Chunk labeling at index time is ENRICHER=claude-cli|api|off|auto.
 */

export const config = {
  models: {
    large: process.env.MINDCAIRN_MODEL_LARGE ?? 'claude-opus-4-7',
    fast: process.env.MINDCAIRN_MODEL_FAST ?? 'claude-haiku-4-5-20251001',
  },
  output: {
    dir: process.env.MINDCAIRN_OUTPUT_DIR ?? '.mindcairn',
  },
  limits: {
    discoverySampleFiles: 50,
    maxFileBytesForSample: 8_000,
    improveMaxIterations: 3,
    evalCaseCount: 50,
  },
} as const;
