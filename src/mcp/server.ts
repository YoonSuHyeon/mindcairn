/**
 * Mindcairn MCP Server — exposes the generated intelligence layer as standard MCP tools.
 *
 *   mindcairn serve <tag>
 *
 * Tools (search):
 *   - search_codebase(query, topK?)   — semantic search
 *   - find_pattern(query, type?)      — type-filtered search
 *   - explain_module(name)            — gather chunks of a given chunker type/module and explain
 *
 * Tools (write / learning):
 *   - capture_decision(...)           — store a decision/fact/incident
 *   - ingest_doc(...)                 — instantly index an external doc (e.g. Notion body)
 *   - list_captured(since, kind?)     — period filter for retros/reviews
 *   - eval_query(query, expected*)    — evaluate search quality + log
 *   - learn_preference(context, ...)  — store a workflow learning signal
 *
 * Called by Claude Code / Cursor over MCP HTTP.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { embedTexts, assertSpecMatchesEnv } from '../builder/embedder.ts';
import { enrichChunks } from '../builder/enricher.ts';
import { collectionName, ensureCollection, hybridSearch, upsertPoints } from '../builder/qdrant.ts';
import { ChunkStore, type StoredChunk } from '../builder/sqlite-store.ts';
import { config } from '../config.ts';
import type { Chunk, Discovery, IndexingStrategy } from '../types.ts';
import { IngestDocArgs, handleIngestDoc } from './handlers/ingest-doc.ts';
import { ReportIssueArgs, handleReportIssue } from './handlers/report-issue.ts';
import { ListCapturedArgs, handleListCaptured } from './handlers/list-captured.ts';
import { EvalQueryArgs, handleEvalQuery } from './handlers/eval-query.ts';
import { LearnPreferenceArgs, handleLearnPreference } from './handlers/learn-preference.ts';
import { GetChunkArgs, handleGetChunk } from './handlers/get-chunk.ts';

const SearchArgs = z.object({
  query: z.string(),
  topK: z.number().optional(),
});

const FindPatternArgs = z.object({
  query: z.string(),
  type: z.string().optional(),
  topK: z.number().optional(),
});

const ExplainModuleArgs = z.object({
  name: z.string(),
});

const CaptureDecisionArgs = z.object({
  title: z.string(),
  content: z.string(),
  kind: z.string().optional(),       // decision / fact / intent / incident / spec
  links: z.array(z.string()).optional(),
  status: z.string().optional(),     // active / draft / superseded
  domain: z.string().optional(),
});

export async function runMcpServer(tag: string) {
  const outDir = join(process.cwd(), config.output.dir, tag);

  // If index metadata is missing, guide "what to run first" instead of a raw ENOENT
  const required = ['discovery.json', 'indexing-strategy.json'];
  const missing = required.filter((f) => !existsSync(join(outDir, f)));
  if (missing.length > 0) {
    console.error(
      `✗ No index found for instance "${tag}" (missing ${outDir}/${missing.join(', ')}).\n` +
        `  Build the index with init first:\n` +
        `    bun run src/cli/index.ts init --repo <repo-path> --tag ${tag} --yes\n` +
        `  (interactive: bun run src/cli/index.ts init)`,
    );
    process.exit(1);
  }

  const discovery = JSON.parse(await readFile(join(outDir, 'discovery.json'), 'utf-8')) as Discovery;
  const strategy = JSON.parse(
    await readFile(join(outDir, 'indexing-strategy.json'), 'utf-8'),
  ) as IndexingStrategy;

  // If the embedding provider that built the index disagrees with the current env, fail fast with a clear error
  assertSpecMatchesEnv(strategy.embedding, `serve ${tag}`);

  const collection = collectionName(tag);
  const sqlitePath = join(outDir, 'chunks.sqlite');
  const store = new ChunkStore(sqlitePath);

  // READONLY mode — for a team-shared read-only instance.
  // Exposes search tools only; write tools / hook endpoints are blocked from non-localhost.
  const readonly = process.env.MINDCAIRN_READONLY === '1';
  const READONLY_TOOLS = new Set(['search_codebase', 'find_pattern', 'explain_module', 'get_chunk', 'report_issue']);

  // Write IP whitelist — MINDCAIRN_WRITE_IPS="<ip1>,<ip2>" (e.g. comma-separated VPN/Tailscale IPs)
  // If unset, keep prior behavior (allow all unless readonly). localhost is always allowed.
  const writeIps = new Set(
    (process.env.MINDCAIRN_WRITE_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  const WRITE_TOOLS = new Set(['ingest_doc', 'capture_decision', 'learn_preference', 'eval_query']);
  const normIp = (ip: string | undefined) => (ip ?? '').replace(/^::ffff:/, '');
  function canWrite(ip: string | undefined): boolean {
    const n = normIp(ip);
    if (n === '127.0.0.1' || n === '::1') return true;
    if (readonly) return false;
    if (writeIps.size === 0) return true;
    return writeIps.has(n);
  }

  // A fresh Server instance per session — the MCP SDK errors when one Server connects to multiple transports
  function createMcpServer(): Server {
    const server = new Server(
      {
        name: `mindcairn-${tag}`,
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );
    attachHandlers(server, tag, discovery, strategy, collection, store);
    return server;
  }

  // Validate handlers with the first server instance
  function attachHandlers(
    server: Server,
    tag: string,
    discovery: Discovery,
    strategy: IndexingStrategy,
    collection: string,
    store: ChunkStore,
  ) {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const allTools = [
      {
        name: 'search_codebase',
        description: `Semantic search. Returns top-K chunks of the codebase (${tag}, domains=${discovery.domainHints?.join('/')}). type/quota applied automatically. If a result is wrong or stale, report it via report_issue.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural-language query (any language)' },
            topK: { type: 'number', description: 'default 10' },
          },
          required: ['query'],
        },
      },
      {
        name: 'find_pattern',
        description: `Filtered search by a specific chunker type. Available types: ${strategy.chunkers.map((c) => c.name).join(', ')}. If a result is wrong or stale, report it via report_issue.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            type: { type: 'string', description: 'chunker type' },
            topK: { type: 'number' },
          },
          required: ['query'],
        },
      },
      {
        name: 'explain_module',
        description: 'Gather the main chunks of a module or chunker type and explain it.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
      {
        name: 'capture_decision',
        description:
          'Instantly store a decision/fact/intent surfaced during work into mindcairn. A lightweight alternative to a wiki/Notion. Reflected in the next search within ~5s.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Decision title (short and clear)' },
            content: { type: 'string', description: 'Decision body — include rationale/context' },
            kind: {
              type: 'string',
              description: 'decision / fact / intent / incident / spec (default decision)',
            },
            links: {
              type: 'array',
              items: { type: 'string' },
              description: 'Related symbols/files/prior decision ids (optional)',
            },
            status: { type: 'string', description: 'active / draft / superseded (default active)' },
            domain: { type: 'string', description: 'order / member / payment ... (optional)' },
          },
          required: ['title', 'content'],
        },
      },
      {
        name: 'ingest_doc',
        description:
          'Instantly index an external doc (e.g. Notion body) into mindcairn. Call automatically from a workflow hook so a doc update is reflected in search immediately. Existing chunks with the same externalId are auto-deleted.',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'notion / meeting / wiki / slack ...' },
            externalId: { type: 'string', description: 'ID in the source system (e.g. Notion pageId)' },
            title: { type: 'string', description: 'Document title' },
            body: { type: 'string', description: 'markdown body' },
            frontmatter: {
              type: 'object',
              description: 'Metadata (type/role/status/task id/planned date, etc.). Feeds the instance rule\'s classifyKind.',
              additionalProperties: { type: 'string' },
            },
            taskId: { type: 'string', description: 'TASK-XXXX (optional)' },
            url: { type: 'string', description: 'Document URL (optional)' },
          },
          required: ['source', 'externalId', 'title', 'body'],
        },
      },
      {
        name: 'list_captured',
        description:
          'List stored captured_decision chunks filtered by period/kind/domain. Use for retros or to review candidates for promotion into design-decision docs.',
        inputSchema: {
          type: 'object',
          properties: {
            since: { type: 'string', description: 'ISO date (e.g. 2026-05-17)' },
            until: { type: 'string', description: 'ISO date' },
            kind: { type: 'string', description: 'decision / fact / incident / spec / preference' },
            domain: { type: 'string', description: 'order / member / payment ...' },
            limit: { type: 'number', description: 'default 100' },
          },
        },
      },
      {
        name: 'eval_query',
        description:
          'Score a query\'s search results against expected values. A golden-set-based regression guard + self-tuning signal. Results are appended to .mindcairn/<tag>/evals.jsonl.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            expectedChunkIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Expected chunk IDs (for recall@K, MRR)',
            },
            expectedTypes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Chunker types that should appear in the response',
            },
            expectedKeywords: {
              type: 'array',
              items: { type: 'string' },
              description: 'Keywords that should appear in the body/label',
            },
            topK: { type: 'number', description: 'default 10' },
            label: { type: 'string', description: 'Identifier label for a golden case (optional)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'learn_preference',
        description:
          'Store a workflow learning signal. Plays the same role as a team-standard preferences.jsonl. Accumulates per context and becomes a candidate for auto rule promotion later.',
        inputSchema: {
          type: 'object',
          properties: {
            context: {
              type: 'string',
              description: 'doc-tracing / impact-analysis / search-quality / ...',
            },
            lesson: { type: 'string', description: 'One-line rule' },
            example: { type: 'string', description: 'Example (optional)' },
            appliesWhen: { type: 'string', description: 'When it applies (optional)' },
          },
          required: ['context', 'lesson'],
        },
      },
      {
        name: 'report_issue',
        description:
          'Tool to file an issue when a search result is wrong (stale content, wrong code, missing file, odd behavior) or mindcairn misbehaves. An admin reviews periodically and fixes the index. Anyone can use it.',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'What is wrong and how (required)' },
            query: { type: 'string', description: 'The query that triggered the problem (optional)' },
            chunkId: { type: 'string', description: 'The problematic chunk id — chunkId from the search response (optional)' },
            tool: { type: 'string', description: 'Name of the tool that misbehaved (optional)' },
            reporter: { type: 'string', description: 'Reporter name/alias (optional)' },
          },
          required: ['message'],
        },
      },
      {
        name: 'get_chunk',
        description:
          'Return the full body of a chunk by id (no truncation). search_codebase/find_pattern responses are 2000-char slices, so use this to see details. For inspecting large-chunk detail in code-less environments / debugging mindcairn chunk quality.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Chunk id (chunkId from the search response)' },
          },
          required: ['id'],
        },
      },
      ];
      return {
        tools: readonly ? allTools.filter((t) => READONLY_TOOLS.has(t.name)) : allTools,
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: rawArgs } = req.params;
      if (readonly && !READONLY_TOOLS.has(name)) {
        return {
          content: [
            { type: 'text', text: `(read-only) The "${name}" tool is disabled on this instance. Search tools only: ${[...READONLY_TOOLS].join(', ')}` },
          ],
          isError: true,
        };
      }
      // Write-tool IP whitelist — __callerIp is always overwritten by the express middleware with the real req.ip (no spoofing)
      const callerIp =
        typeof (rawArgs as Record<string, unknown> | undefined)?.__callerIp === 'string'
          ? ((rawArgs as Record<string, unknown>).__callerIp as string)
          : '';
      if (WRITE_TOOLS.has(name) && !canWrite(callerIp)) {
        return {
          content: [
            {
              type: 'text',
              text: `(blocked) The "${name}" write tool is only available from allowed devices (from ${callerIp || 'unknown'}). If you found something wrong, please report it via the report_issue tool — an admin will review and apply it.`,
            },
          ],
          isError: true,
        };
      }
      try {
        if (name === 'search_codebase') {
          const args = SearchArgs.parse(rawArgs);
          return await handleSearch(args, strategy, collection, store);
        }
        if (name === 'find_pattern') {
          const args = FindPatternArgs.parse(rawArgs);
          return await handleFind(args, strategy, collection, store);
        }
        if (name === 'explain_module') {
          const args = ExplainModuleArgs.parse(rawArgs);
          return await handleExplain(args, strategy, collection, store);
        }
        if (name === 'capture_decision') {
          const args = CaptureDecisionArgs.parse(rawArgs);
          return await handleCapture(args, strategy, collection, store);
        }
        if (name === 'ingest_doc') {
          const args = IngestDocArgs.parse(rawArgs);
          return await handleIngestDoc(args, tag, strategy, collection, store);
        }
        if (name === 'list_captured') {
          const args = ListCapturedArgs.parse(rawArgs);
          return await handleListCaptured(args, store);
        }
        if (name === 'report_issue') {
          const args = ReportIssueArgs.parse(rawArgs);
          return await handleReportIssue(args, outDir);
        }
        if (name === 'eval_query') {
          const args = EvalQueryArgs.parse(rawArgs);
          return await handleEvalQuery(args, tag, strategy, collection, store);
        }
        if (name === 'learn_preference') {
          const args = LearnPreferenceArgs.parse(rawArgs);
          return await handleLearnPreference(args, strategy, collection, store);
        }
        if (name === 'get_chunk') {
          const args = GetChunkArgs.parse(rawArgs);
          return await handleGetChunk(args, store);
        }
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
      } catch (e) {
        return {
          content: [{ type: 'text', text: `Error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    });
  }

  // HTTP transport — a remote machine (e.g. a teammate's laptop) can reach it by URL
  const port = Number(process.env.MINDCAIRN_MCP_PORT ?? 8765);
  const host = process.env.MINDCAIRN_MCP_HOST ?? '0.0.0.0';

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Access log — records every HTTP call. Read calls are traceable too (for verification/debugging)
  // tools/call is also structured-logged to .mindcairn/<tag>/usage.jsonl (the dashboard data source)
  const usagePath = join(outDir, 'usage.jsonl');
  app.use((req: Request, res: Response, next) => {
    const start = Date.now();
    const ua = (req.headers['user-agent'] ?? '').toString().slice(0, 50);
    res.on('finish', () => {
      // MCP calls carry the tool name in the body
      let toolHint = '';
      if (req.path === '/mcp' && req.method === 'POST') {
        const b = req.body as
          | { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }
          | undefined;
        if (b?.method === 'tools/call' && b.params?.name) {
          toolHint = ` tool=${b.params.name}`;
          const a = b.params.arguments ?? {};
          // For searches it's query, for explain it's name, for get_chunk it's id — i.e. "what was looked up"
          const q = a.query ?? a.name ?? a.id ?? '';
          const line = JSON.stringify({
            ts: new Date().toISOString(),
            tool: b.params.name,
            query: String(q).slice(0, 300),
            ip: req.ip ?? '',
            ua,
            durationMs: Date.now() - start,
            status: res.statusCode,
          });
          appendFile(usagePath, line + '\n').catch(() => {});
        } else if (b?.method) toolHint = ` jsonrpc=${b.method}`;
      }
      console.error(
        `[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms${toolHint}  ua="${ua}"`,
      );
    });
    next();
  });

  // Always inject the real caller IP into tools/call args — handlers use it for the write whitelist + report_issue record.
  // Even if the client sends __callerIp, we unconditionally overwrite it here, so it cannot be spoofed.
  app.use('/mcp', (req: Request, _res: Response, next) => {
    if (req.method === 'POST') {
      const b = req.body as
        | { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }
        | undefined;
      if (b?.method === 'tools/call' && b.params) {
        b.params.arguments = { ...(b.params.arguments ?? {}), __callerIp: normIp(req.ip) };
      }
    }
    next();
  });

  // Per-session transport storage (MCP multi-session support)
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.all('/mcp', async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        // New session (an initialize request, or the first call)
        const isInit = req.method === 'POST' && isInitializeRequest(req.body);
        if (!isInit && req.method === 'POST') {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Missing or invalid session id' },
            id: null,
          });
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport!);
          },
        });
        transport.onclose = () => {
          if (transport!.sessionId) transports.delete(transport!.sessionId);
        };
        // A fresh Server instance per session — avoids 'Already connected'
        const sessionServer = createMcpServer();
        await sessionServer.connect(transport);
      }
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp] error:', (e as Error).message);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: (e as Error).message },
          id: null,
        });
      }
    }
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, tag, collection, chunks: store.countByType() });
  });

  // hook POST write guard — same policy as canWrite (localhost always allowed, readonly blocked, whitelist checked).
  // A sync process running on the same machine passes via localhost.
  function guardWrite(req: Request, res: Response): boolean {
    if (canWrite(req.ip)) return true;
    res.status(403).json({
      ok: false,
      error: `write endpoints are restricted (from ${normIp(req.ip)}) — ${readonly ? 'read-only instance' : 'IP not in MINDCAIRN_WRITE_IPS'}`,
    });
    return false;
  }

  // Called directly from a (shell) hook — auto-ingest without Claude's MCP tool call
  app.post('/ingest-doc', async (req: Request, res: Response) => {
    if (!guardWrite(req, res)) return;
    try {
      const args = IngestDocArgs.parse(req.body);
      const result = await handleIngestDoc(args, tag, strategy, collection, store);
      res.json({ ok: true, message: result.content[0]?.text ?? '' });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  app.post('/capture-decision', async (req: Request, res: Response) => {
    if (!guardWrite(req, res)) return;
    try {
      const args = CaptureDecisionArgs.parse(req.body);
      const result = await handleCapture(args, strategy, collection, store);
      res.json({ ok: true, message: result.content[0]?.text ?? '' });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  app.post('/learn-preference', async (req: Request, res: Response) => {
    if (!guardWrite(req, res)) return;
    try {
      const args = LearnPreferenceArgs.parse(req.body);
      const result = await handleLearnPreference(args, strategy, collection, store);
      res.json({ ok: true, message: result.content[0]?.text ?? '' });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  // Port-claim check — Bun with SO_REUSEPORT will silently listen on an already-used port,
  // causing requests to leak to the existing server. If another process responds, fail clearly.
  try {
    const probe = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (probe.ok || probe.status > 0) {
      console.error(`✗ Port ${port} is already in use by another server.`);
      console.error(`  Set MINDCAIRN_MCP_PORT=<another port> and run again.`);
      process.exit(1);
    }
  } catch {
    // No response = port free → proceed normally
  }

  app.listen(port, host, () => {
    console.error(`▶ Mindcairn MCP HTTP server listening on http://${host}:${port}/mcp`);
    console.error(`  health:     http://${host}:${port}/health`);
    console.error(`  hook POST:  /ingest-doc /capture-decision /learn-preference`);
    console.error(`  tag=${tag}  collection=${collection}${readonly ? '  [READ-ONLY: search tools only, hook POST localhost-only]' : ''}`);
    if (writeIps.size > 0) console.error(`  write whitelist: localhost + ${[...writeIps].join(', ')}`);
  });
}

async function handleSearch(
  args: z.infer<typeof SearchArgs>,
  strategy: IndexingStrategy,
  collection: string,
  store: ChunkStore,
) {
  const topK = args.topK ?? 10;
  const fetchK = topK * 3;
  const [vec] = await embedTexts({ spec: strategy.embedding, texts: [args.query] });
  const hits = await hybridSearch(collection, vec, args.query, fetchK);
  const quoted = applyQuota(hits, topK, strategy.retrievalQuota);
  const enriched = enrichWithStore(quoted, store);
  return { content: [{ type: 'text' as const, text: renderHits(args.query, enriched) }] };
}

async function handleFind(
  args: z.infer<typeof FindPatternArgs>,
  strategy: IndexingStrategy,
  collection: string,
  store: ChunkStore,
) {
  const topK = args.topK ?? 10;
  const [vec] = await embedTexts({ spec: strategy.embedding, texts: [args.query] });
  const filter = args.type
    ? { must: [{ key: 'type', match: { value: args.type } }] }
    : undefined;
  const hits = await hybridSearch(collection, vec, args.query, topK, filter);
  const enriched = enrichWithStore(hits, store);
  return {
    content: [
      {
        type: 'text' as const,
        text: renderHits(`${args.query} (type=${args.type ?? 'any'})`, enriched),
      },
    ],
  };
}

async function handleExplain(
  args: z.infer<typeof ExplainModuleArgs>,
  strategy: IndexingStrategy,
  collection: string,
  store: ChunkStore,
) {
  const [vec] = await embedTexts({ spec: strategy.embedding, texts: [args.name] });
  const hits = await hybridSearch(collection, vec, args.name, 15);
  const enriched = enrichWithStore(hits, store);
  return {
    content: [
      { type: 'text' as const, text: renderHits(`explain: ${args.name}`, enriched) },
    ],
  };
}

type EnrichedHit = {
  score: number;
  type: string;
  file: string;
  label: string;
  rawContent: string;
};

async function handleCapture(
  args: z.infer<typeof CaptureDecisionArgs>,
  strategy: IndexingStrategy,
  collection: string,
  store: ChunkStore,
) {
  const kind = args.kind ?? 'decision';
  const status = args.status ?? 'active';
  const now = new Date().toISOString();
  // id is a hash of title(+kind+domain) — re-saving the same decision overwrites (idempotent).
  // Mixing in `now` would change the id on every call (retry), piling up duplicate records, so we exclude it.
  const id = createHash('sha1')
    .update(`captured|${kind}|${args.domain ?? ''}|${args.title}`)
    .digest('hex')
    .slice(0, 24);

  const linksStr = args.links?.length ? `\nlinks: ${args.links.join(', ')}` : '';
  const domainStr = args.domain ? `\ndomain: ${args.domain}` : '';

  const chunk: Chunk = {
    id,
    type: 'captured_decision',
    embeddingText: `[${kind}] ${args.title}\n${args.content}${linksStr}${domainStr}`,
    rawContent: `# ${args.title}\n\n${args.content}${linksStr}${domainStr}\n\nkind: ${kind}\nstatus: ${status}\ncapturedAt: ${now}`,
    metadata: {
      type: 'captured_decision',
      title: args.title,
      kind,
      status,
      capturedAt: now,
      domain: args.domain ?? '',
      links: args.links ?? [],
      file: '(captured)',
    },
  };

  // Haiku labeling
  const enriched = await enrichChunks({ chunks: [chunk], concurrency: 1 });
  const finalChunk = enriched.enrichedChunks[0] ?? chunk;
  const label = (finalChunk.metadata?.enrichedLabel as string) ?? args.title;

  // SQLite store
  store.upsertMany([finalChunk]);

  // Qdrant embed + store
  const embedText = `[${finalChunk.type}] ${label}\n${finalChunk.embeddingText}`;
  const [vector] = await embedTexts({
    spec: strategy.embedding,
    texts: [embedText],
  });
  await ensureCollection(collection, strategy.embedding.dimensions);
  await upsertPoints(collection, [
    {
      id: finalChunk.id,
      vector,
      sparseText: embedText,
      payload: {
        chunkId: finalChunk.id,
        type: finalChunk.type,
        title: args.title,
        kind,
        status,
        domain: args.domain ?? '',
        label,
        capturedAt: now,
      },
    },
  ]);

  return {
    content: [
      {
        type: 'text' as const,
        text: `✓ Saved

id: ${finalChunk.id}
title: ${args.title}
kind: ${kind}  status: ${status}${args.domain ? `  domain: ${args.domain}` : ''}
label (Haiku auto): ${label}
saved at: ${now}

→ Reflected in search immediately. enrich cost ~$${enriched.totalCostUsd.toFixed(4)}.`,
      },
    ],
  };
}

function enrichWithStore(
  hits: Array<{ score: number; payload: Record<string, unknown> }>,
  store: ChunkStore,
): EnrichedHit[] {
  const ids = hits.map((h) => String(h.payload.chunkId ?? ''));
  const stored = store.getMany(ids);
  const map = new Map(stored.map((s) => [s.id, s]));
  return hits.map((h) => {
    const id = String(h.payload.chunkId ?? '');
    const s = map.get(id);
    return {
      score: h.score,
      type: s?.type ?? String(h.payload.type ?? ''),
      file: s?.file ?? String(h.payload.file ?? ''),
      label: s?.enrichedLabel ?? String(h.payload.label ?? ''),
      rawContent: s?.rawContent ?? '',
    };
  });
}

function applyQuota(
  hits: Array<{ score: number; payload: Record<string, unknown> }>,
  topK: number,
  quota: Record<string, number>,
): Array<{ score: number; payload: Record<string, unknown> }> {
  const counts: Record<string, number> = {};
  const out: typeof hits = [];
  for (const h of hits) {
    if (out.length >= topK) break;
    const t = String(h.payload.type ?? '_other');
    const limit = quota[t] ?? Number.MAX_SAFE_INTEGER;
    const used = counts[t] ?? 0;
    if (used >= limit) continue;
    out.push(h);
    counts[t] = used + 1;
  }
  return out;
}

function renderHits(query: string, hits: EnrichedHit[]): string {
  if (hits.length === 0) return `(no results for "${query}")`;
  const blocks = hits
    .map((h, i) => {
      const body = h.rawContent.slice(0, 2000);
      const labelLine = h.label?.trim() ? `\n[label] ${h.label}` : ''; // no label if enricher is off
      return `## ${i + 1}. [${h.type}] score=${h.score.toFixed(3)} file=${h.file}${labelLine}
[body]
\`\`\`
${body}
\`\`\``;
    })
    .join('\n\n');
  return `# Search results: "${query}"  (${hits.length})\n\n${blocks}`;
}
