/**
 * Direct call to the Anthropic Messages API (ANTHROPIC_API_KEY).
 *
 * Implements the same interface (ClaudeOptions/ClaudeResponse) as claude-cli.ts —
 * the path that works via an API key in environments without the Claude Code CLI (OAuth).
 */

import { extractJson, type ClaudeOptions, type ClaudeResponse } from './claude-cli.ts';

const API_BASE = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
const MAX_TOKENS = Number(process.env.MINDCAIRN_API_MAX_TOKENS ?? 8192);
const TIMEOUT_MS = Number(process.env.MINDCAIRN_LLM_TIMEOUT_MS ?? 120_000);

export async function callAnthropicApi(opts: ClaudeOptions): Promise<ClaudeResponse<string>> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set — cannot call the LLM in API mode.\n' +
        '  Set ANTHROPIC_API_KEY=sk-ant-... in .env, or if the Claude Code CLI is installed, use ENRICHER=claude-cli (or auto).',
    );
  }

  const promptText = opts.expectJson
    ? `${opts.prompt}\n\nRespond with valid JSON only. No other explanation/comments — wrap it in a \`\`\`json ... \`\`\` block.`
    : opts.prompt;

  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: MAX_TOKENS,
        ...(opts.systemPrompt ? { system: opts.systemPrompt } : {}),
        messages: [{ role: 'user', content: promptText }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') {
      throw new Error(`Anthropic API timed out after ${TIMEOUT_MS}ms (MINDCAIRN_LLM_TIMEOUT_MS).`);
    }
    throw new Error(`Failed to connect to the Anthropic API (${API_BASE}): ${(e as Error).message}`);
  }

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401) {
      throw new Error(`Anthropic API authentication failed (401) — check ANTHROPIC_API_KEY.\n${body.slice(0, 300)}`);
    }
    throw new Error(`Anthropic API failed: ${res.status} ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    model: string;
    content: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string;
  };

  // A truncated response yields invalid/partial JSON downstream — fail loudly so the retry layer
  // can react (or the operator can raise the cap), rather than silently degrading quality.
  if (json.stop_reason === 'max_tokens') {
    throw new Error(
      `Anthropic API response truncated (stop_reason=max_tokens, max_tokens=${MAX_TOKENS}). ` +
        `Reduce batch size or raise MINDCAIRN_API_MAX_TOKENS.`,
    );
  }

  const text = json.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');

  return {
    result: text,
    raw: JSON.stringify(json),
    costUsd: 0, // the API does not return cost — usage tokens are included in raw
    durationMs: Date.now() - t0,
    modelUsed: json.model ?? opts.model,
  };
}

export async function callAnthropicApiJson<T = unknown>(
  opts: ClaudeOptions,
): Promise<ClaudeResponse<T>> {
  const resp = await callAnthropicApi({ ...opts, expectJson: true });
  const json = extractJson(resp.result);
  return { ...resp, result: json as T };
}
