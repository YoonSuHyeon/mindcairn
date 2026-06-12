/**
 * Claude CLI subprocess wrapper.
 *
 * All of Mindcairn's LLM calls go through this module.
 * Works via the Claude Code Max Plan (OAuth) without an API key.
 *
 *   claude -p --output-format json --model <m> --max-turns 1
 *     [--system-prompt <sys>] [--append-system-prompt <sys>]
 *
 * Response: { result: string, total_cost_usd, duration_ms, ... }
 */

import { spawn } from 'bun';

export type ClaudeOptions = {
  model: string;
  systemPrompt?: string;
  prompt: string;
  maxTurns?: number;
  /** Force JSON extraction from the response. Appends an instruction to the end of the prompt. */
  expectJson?: boolean;
  /** Extra CLI args (for debug/experiments) */
  extraArgs?: string[];
};

export type ClaudeResponse<T = string> = {
  result: T;
  raw: string;
  costUsd: number;
  durationMs: number;
  modelUsed: string;
};

const CLI_BIN = process.env.MINDCAIRN_CLAUDE_BIN ?? 'claude';

export async function callClaude(opts: ClaudeOptions): Promise<ClaudeResponse<string>> {
  const args = [
    '-p',
    '--output-format', 'json',
    '--max-turns', String(opts.maxTurns ?? 1),
    '--model', opts.model,
  ];
  if (opts.systemPrompt) {
    args.push('--system-prompt', opts.systemPrompt);
  }
  if (opts.extraArgs) {
    args.push(...opts.extraArgs);
  }

  const proc = spawn([CLI_BIN, ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const promptText = opts.expectJson
    ? `${opts.prompt}\n\nRespond with valid JSON only. No other explanation/comments — wrap it in a \`\`\`json ... \`\`\` block.`
    : opts.prompt;

  proc.stdin.write(promptText);
  proc.stdin.end();

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`claude CLI failed (exit ${exitCode}):\n${stderr || stdout}`);
  }

  const parsed = JSON.parse(stdout) as {
    type: string;
    is_error: boolean;
    result: string;
    total_cost_usd: number;
    duration_ms: number;
    modelUsage?: Record<string, unknown>;
  };

  if (parsed.is_error) {
    throw new Error(`claude returned error: ${parsed.result}`);
  }

  return {
    result: parsed.result,
    raw: stdout,
    costUsd: parsed.total_cost_usd ?? 0,
    durationMs: parsed.duration_ms ?? 0,
    modelUsed: Object.keys(parsed.modelUsage ?? {})[0] ?? opts.model,
  };
}

/**
 * Receive a JSON response and parse it. zod validation is done by the caller.
 */
export async function callClaudeJson<T = unknown>(opts: ClaudeOptions): Promise<ClaudeResponse<T>> {
  const resp = await callClaude({ ...opts, expectJson: true });
  const json = extractJson(resp.result);
  return { ...resp, result: json as T };
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (fenced) return JSON.parse(fenced[1]);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(text.slice(start, end + 1));
  }
  throw new Error(`Failed to extract JSON. raw:\n${text}`);
}
