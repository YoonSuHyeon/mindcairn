/**
 * MCP tool: report_issue
 *
 * A tool for users (teammates, etc.) to report wrong/stale search results or misbehavior.
 * Callable by anyone regardless of the write whitelist (including read-only instances).
 *
 * Record: .mindcairn/<tag>/issues.jsonl — reviewed from the dashboard/retro.
 * reporterIp is injected by the server middleware, not client input (anti-spoofing).
 */

import { z } from 'zod';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ReportIssueArgs = z.object({
  message: z.string().min(5),                  // what is wrong
  query: z.string().optional(),                // the query that triggered the problem
  chunkId: z.string().optional(),              // problematic chunk id (chunkId from the search response)
  tool: z.string().optional(),                 // name of the tool that misbehaved
  reporter: z.string().optional(),             // name/alias
  __callerIp: z.string().optional(),           // server-injected — the middleware overwrites any client value
});

export type ReportIssueInput = z.infer<typeof ReportIssueArgs>;

export async function handleReportIssue(args: ReportIssueInput, outDir: string) {
  const record = {
    ts: new Date().toISOString(),
    message: args.message.slice(0, 2000),
    query: args.query ?? '',
    chunkId: args.chunkId ?? '',
    tool: args.tool ?? '',
    reporter: args.reporter ?? '',
    ip: args.__callerIp ?? '',
    status: 'open',
  };
  await appendFile(join(outDir, 'issues.jsonl'), JSON.stringify(record) + '\n');
  return {
    content: [
      {
        type: 'text' as const,
        text: `✓ Issue filed. An admin will review and fix the index.\n\nReceived: "${record.message.slice(0, 200)}"${record.query ? `\nquery: ${record.query}` : ''}${record.chunkId ? `\nchunk: ${record.chunkId}` : ''}`,
      },
    ],
  };
}
