/**
 * Selects the LLM call path — claude-cli (OAuth) | api (ANTHROPIC_API_KEY).
 *
 * Auto-detection order (can be forced via MINDCAIRN_LLM):
 *   1. if ANTHROPIC_API_KEY is set → api
 *   2. if the claude CLI is on PATH → claude-cli (Claude Code Max Plan OAuth)
 *   3. if neither → null (a helpful error is raised on call)
 *
 * The enricher (chunk labeling at index time) is controlled separately via ENRICHER=claude-cli|api|off|auto.
 * If off, indexing runs without labels (0 LLM calls — search quality is somewhat lower).
 */

import {
  callClaudeJson,
  type ClaudeOptions,
  type ClaudeResponse,
} from './claude-cli.ts';
import { callAnthropicApiJson } from './anthropic-api.ts';

export type LlmMode = 'claude-cli' | 'api';

export function detectLlmMode(): LlmMode | null {
  const forced = (process.env.MINDCAIRN_LLM ?? '').toLowerCase();
  if (forced === 'claude-cli' || forced === 'api') return forced;
  if (process.env.ANTHROPIC_API_KEY) return 'api';
  if (Bun.which(process.env.MINDCAIRN_CLAUDE_BIN ?? 'claude')) return 'claude-cli';
  return null;
}

export function llmUnavailableMessage(step: string): string {
  return (
    `${step} requires an LLM, but no usable path is available. Set up one of the following:\n` +
    `  1) Install + log in to the Claude Code CLI (https://claude.com/claude-code) — no API key needed\n` +
    `  2) Set ANTHROPIC_API_KEY=sk-ant-... in .env\n` +
    `  (if the CLI path is unusual, use MINDCAIRN_CLAUDE_BIN; to force a choice, MINDCAIRN_LLM=claude-cli|api)`
  );
}

/** Single entry point used by all agents (Discovery/Strategy/Eval/Judge/Improver) and the enricher. */
export async function callModelJson<T = unknown>(
  opts: ClaudeOptions & { mode?: LlmMode },
): Promise<ClaudeResponse<T>> {
  const mode = opts.mode ?? detectLlmMode();
  if (!mode) throw new Error(llmUnavailableMessage('LLM call'));
  return mode === 'api' ? callAnthropicApiJson<T>(opts) : callClaudeJson<T>(opts);
}

export type EnricherMode = LlmMode | 'off';

/** ENRICHER=claude-cli|api|off|auto (default). auto falls back to off on detection failure. */
export function resolveEnricherMode(): EnricherMode {
  const v = (process.env.ENRICHER ?? 'auto').toLowerCase();
  if (v === 'off' || v === '0' || v === 'false' || v === 'none') return 'off';
  if (v === 'claude-cli' || v === 'api') return v;
  if (v !== 'auto') {
    process.stderr.write(`  ⚠ Unknown ENRICHER="${v}" — treating as auto (claude-cli|api|off|auto)\n`);
  }
  return detectLlmMode() ?? 'off';
}
