# mindcairn

> Self-hosted team brain for AI coding agents — your code, docs, and decisions in one hybrid-searchable index, served over MCP.

[**한국어 README**](README.ko.md) | **English**

[![CI](https://github.com/YoonSuHyeon/mindcairn/actions/workflows/ci.yml/badge.svg)](https://github.com/YoonSuHyeon/mindcairn/actions/workflows/ci.yml)

![mindcairn demo — hybrid search answering in the terminal](docs/assets/demo.gif)


## Why

Code-search tools know your code but nothing else. Memory servers know your notes but not your code. A development team's knowledge doesn't split that cleanly: the question "how do refunds work here?" is answered by `RefundService.kt` *and* the design memo that says why partial refunds are disabled — and your agent should get both from **the same search**.

mindcairn is a small, self-hosted MCP server an individual developer can stand up on a spare machine. Point it at a repo, let it analyze the structure, ingest your design docs and captured decisions into the same index, and every Claude Code / Cursor session on your team gets one `search_codebase` that answers with code, docs, and decisions together — over plain HTTP, or Tailscale for remote teammates.

- **One index for code + docs + decisions** — chunks from your repo, Notion exports / markdown (`ingest_doc`), and decisions captured mid-session (`capture_decision`) all live in the same hybrid index.
- **Hybrid search that actually finds identifiers** — BM25 sparse + dense (bge-m3) fused with RRF. On our internal eval this took Hit@5 from **63% to 88%** (exact-identifier queries: 50% → 75%, natural-language queries: 75% → 100%).
- **Built for teams of 1–10** — read-only mode, an IP allowlist for write tools, usage logging, and a `report_issue` feedback loop. No SSO, no cluster, no per-seat pricing.

## How it compares

Respectfully — these are different tools for different jobs. mindcairn's job is the intersection.

| | mindcairn | [claude-context](https://github.com/zilliztech/claude-context) | [mem0](https://github.com/mem0ai/mem0) | [basic-memory](https://github.com/basicmachines-co/basic-memory) |
|---|---|---|---|---|
| Remembers | code + docs + decisions | code only | conversation facts | markdown notes |
| Deployment | self-hosted, no new 3rd party | OpenAI key + Zilliz Cloud | SaaS or self-host | local files |
| Team sharing | read-only mode + IP allowlist + usage log | — | — | — |

## Privacy & data flow

Honest table — what runs where:

| Step | Where it runs | Your code leaves the machine? |
|---|---|---|
| Embeddings | local Ollama (`bge-m3`), default | No (unless you opt into `EMBEDDING_PROVIDER=openai`) |
| Vector storage & search | local Qdrant + SQLite | No |
| `init` analysis (discovery/strategy) | Claude — via your existing Claude Code CLI login or API key | Yes — repo structure and snippets are sent for analysis |
| Chunk enrichment (labeling) | Claude (Haiku) | Yes — chunk contents are sent; **set `ENRICHER=off` to block** |

If you already use Claude Code, mindcairn adds **zero new third parties**. (claude-context requires OpenAI + Zilliz Cloud accounts.) We deliberately don't claim "fully local": the LLM analysis steps call Claude, and you control how much of that happens.

## Verified on real repos

From the [verification benchmarks](docs/benchmarks.md) — every number from actual run logs, no estimates. Judging criterion: correct file inside `search_codebase` top-5.

| Repo | Language | `init` time | Files | Chunks | Search hits |
|---|---|---|---|---|---|
| gin-gonic/gin | Go | 166.7s | 58 | 111 | 3/3 (all #1) |
| trpc/trpc | TS monorepo | 267.3s (+ repair build 174.2s) | 182 | 473 | 3/3 |
| fastapi/fastapi | Python | 113.3s | 48 | 81 | 3/3 |

**9/9 top-5 hits** across three non-JVM repos, `init` in 113–267 seconds each. On our internal Kotlin/Spring deployment, hybrid search raised Hit@5 from 63% to 88%.

## Quickstart

### Easiest: let your coding agent set it up

If you use Claude Code, Cursor, or any MCP-capable coding agent, you don't have to run anything by hand. Open your project and paste this:

> Set up **mindcairn** for this repository.
> 1. Clone `https://github.com/YoonSuHyeon/mindcairn` next to this project (skip if it's already there) and run `bun install` inside it.
> 2. Make sure Docker and Ollama are running, then from the mindcairn folder run `docker compose up -d` (Qdrant) and `ollama pull bge-m3`.
> 3. Run `bun run src/cli/index.ts init --repo <absolute path of THIS repo> --tag <short-name> --yes`.
> 4. Start the server with `bun run src/cli/index.ts serve <short-name>`, then register it with me: `claude mcp add --transport http mindcairn-<short-name> http://localhost:8765/mcp`.
>
> From then on, use the `search_codebase` tool whenever I ask about this codebase.

The agent runs each step, resolves any preflight errors it hits (missing Docker / Ollama / model), and wires up the MCP connection — you just approve. Want to drive it yourself? The manual steps are below.

### 0. Prerequisites

[Bun](https://bun.sh) (required — uses `bun:sqlite`), Docker, and either Ollama or an OpenAI API key for embeddings. LLM analysis uses the Claude Code CLI (no API key needed) or `ANTHROPIC_API_KEY`.

On macOS:

```bash
brew install oven-sh/bun/bun
brew install --cask docker      # then launch Docker Desktop once and wait until it's up
brew install ollama             # then launch the Ollama app (or run `ollama serve`)
```

For the LLM analysis, either be logged in to the [Claude Code CLI](https://claude.com/claude-code) (`claude` on your PATH) or export `ANTHROPIC_API_KEY`. Neither? Use [No-LLM mode](docs/extending.md#25-no-llm-mode--hand-written-strategy-zero-code-leaves-your-machine).

Verify the two daemons are actually *running* — the most common quickstart failure:

```bash
docker info > /dev/null && echo "docker OK"            # errors if Docker Desktop isn't running
curl -s localhost:11434 > /dev/null && echo "ollama OK" # errors if Ollama isn't running
```

(Linux: Docker Engine + [Ollama](https://ollama.com/download); same checks apply.)

### 1. Index & serve

```bash
docker compose up -d          # Qdrant (vector DB)
ollama pull bge-m3            # embedding model (or set EMBEDDING_PROVIDER=openai)
bun install

# Interactive wizard: preflight → preset → analysis → indexing → MCP instructions
bun run src/cli/index.ts init

# Non-interactive
bun run src/cli/index.ts init --repo /path/to/your/repo --tag my-app --yes

# Serve as an MCP server
bun run src/cli/index.ts serve my-app
```

Then connect your agent:

```bash
claude mcp add --transport http mindcairn-my-app http://localhost:8765/mcp
```

> **Already running Qdrant or something on these ports?** Skip `docker compose up` if a Qdrant is already listening on 6333 — mindcairn just uses it. If port 8765 is taken, `serve` refuses to start (instead of silently sharing the port); pick another with `MINDCAIRN_MCP_PORT=8770`. Note the wizard `init` is interactive — run it on its own line, not as part of a pasted block, or use the non-interactive form.

Measured on a clean machine: `init` finished in **88 seconds** against [spring-petclinic](https://github.com/spring-projects/spring-petclinic) (37 files) — well under 30 minutes end to end, including Docker images and the embedding model pull.

### Stopping & resetting

```bash
# stop: Ctrl-C the serve process; docker compose down   (index data survives)
# reset one instance: delete its local state + Qdrant collection
# (collection name = mindcairn_<tag> with non-alphanumerics replaced by "_": my-app → mindcairn_my_app)
rm -rf .mindcairn/my-app
curl -X DELETE http://localhost:6333/collections/mindcairn_my_app
# reset everything: docker compose down -v  (drops all Qdrant volumes)
```

## Features

- **Hybrid search (BM25 + dense, RRF fusion)** — a code-aware tokenizer (camelCase/snake_case splitting, full-identifier tokens, CJK support) feeds a sparse BM25 vector next to the dense embedding in Qdrant; queries fuse both with Reciprocal Rank Fusion. Exact function names and natural-language questions both work.
- **Layer-aware chunking** — a strategy agent inspects the repo and designs chunkers per architectural layer (controller / service / repository / DTO / entity), instead of fixed-size text windows. Falls back to a generic strategy when coverage is low.
- **Decision capture** — `capture_decision` saves a decision/fact/incident from the middle of a coding session into the index; it's searchable within seconds, next to the code it's about.
- **Docs ingestion** — push Notion exports or arbitrary markdown into the same index via the `ingest_doc` tool or batch scripts, so design docs answer alongside code.
- **LLM enrichment (optional)** — a fast model (Haiku) attaches structured labels to each chunk (class name, methods, tables, keywords); embeddings index the label rather than raw noise. Set `ENRICHER=off` to skip.
- **Incremental sync** — re-index only changed files (`sync` command); new chunks automatically participate in BM25.
- **Team sharing, safely** — `MINDCAIRN_READONLY=1` exposes search tools only; `MINDCAIRN_WRITE_IPS` allowlists who can write; every query is logged for usage review.
- **Feedback & regression loop** — `report_issue` captures bad answers, `eval_query` + a golden set catch search-quality regressions before they ship.

### MCP tools

| Tool | What it does |
|------|--------------|
| `search_codebase` | Hybrid search over code + ingested docs + decisions |
| `find_pattern` | Find implementations of a pattern/convention |
| `explain_module` | Summarize a module by name |
| `get_chunk` | Fetch a full chunk by id |
| `capture_decision` | Save a team decision into the index |
| `ingest_doc` | Index an external document |
| `list_captured` | List captured decisions/docs |
| `learn_preference` | Store a team preference/rule |
| `eval_query` | Run a search-quality eval case |
| `report_issue` | File feedback on a bad answer |

With `MINDCAIRN_READONLY=1`, only the search/read tools plus `report_issue` are exposed.

## Architecture

```
 your repo ────▶ ┌──────────────────────────────────────┐
 (read-only)     │ init  (one-time, < 30 min)           │
 docs/decisions  │  1 preset    detect languages/globs  │
 (ingest_doc,    │  2 discovery LLM analyzes structure  │
  capture_…)     │  3 strategy  layer-aware chunk plan  │
                 │  4 build     chunk → enrich → embed  │
                 └───────────────┬──────────────────────┘
                                 ▼
                  ┌────────────┐   ┌──────────────┐
                  │ Qdrant     │   │ SQLite       │
                  │ dense+BM25 │   │ chunks, usage│
                  │ (RRF)      │   │ logs, evals  │
                  └─────┬──────┘   └──────┬───────┘
                        └────────┬────────┘
                                 ▼
                 ┌───────────────────────────┐  HTTP /mcp
                 │ MCP server  :8765         │◀──────────── Claude Code / Cursor
                 │ search_codebase,          │              (teammates via
                 │ find_pattern, ingest_doc… │               Tailscale, etc.)
                 └───────────────────────────┘
```

## Configuration

Everything is optional — defaults work with local Ollama + Claude CLI. See [`.env.example`](.env.example).

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_PROVIDER` | `ollama` | `ollama` or `openai` |
| `OPENAI_API_KEY` | — | Required when `EMBEDDING_PROVIDER=openai` |
| `MINDCAIRN_EMBED_MODEL` | `bge-m3` / `text-embedding-3-small` | Embedding model per provider |
| `MINDCAIRN_EMBED_DIM` | `1024` / `1536` | Embedding dimension |
| `ANTHROPIC_API_KEY` | — | If set, LLM calls use the API; otherwise the Claude CLI (OAuth) |
| `MINDCAIRN_LLM` | auto | Force `claude-cli` or `api` |
| `MINDCAIRN_CLAUDE_BIN` | `claude` | Path to the Claude CLI binary |
| `MINDCAIRN_LLM_TIMEOUT_MS` | `120000` | Per-call LLM timeout (ms); a hung CLI/API call is killed so indexing can't wedge |
| `ENRICHER` | `auto` | Chunk labeling: `claude-cli` / `api` / `off` / `auto` |
| `MINDCAIRN_MODEL_LARGE` | (Claude Opus) | Model for discovery/strategy |
| `MINDCAIRN_MODEL_FAST` | (Claude Haiku) | Model for enrich/eval |
| `MINDCAIRN_QDRANT_HOST` | `http://localhost:6333` | Qdrant endpoint |
| `MINDCAIRN_OLLAMA_HOST` | `http://localhost:11434` | Ollama endpoint |
| `MINDCAIRN_MCP_PORT` | `8765` | MCP server port |
| `MINDCAIRN_MCP_HOST` | `0.0.0.0` | MCP bind address |
| `MINDCAIRN_READONLY` | off | `1` = expose search tools + `report_issue` only (shared team instance) |
| `MINDCAIRN_WRITE_IPS` | — | Comma-separated IP allowlist for write tools. localhost always allowed; **if unset, remote writes are blocked** (localhost-only) |
| `MINDCAIRN_TRUST_PROXY` | — | Trust the proxy's `X-Forwarded-For` so `req.ip` is the real client. `loopback` / IP / hop-count. **Set only when behind a reverse proxy** — otherwise clients could spoof their IP and bypass `MINDCAIRN_WRITE_IPS` |
| `MINDCAIRN_OUTPUT_DIR` | `.mindcairn` | Where indexes/presets are stored |

## Extending

Most per-company adaptation needs no code: presets control what gets indexed, and the LLM-designed chunking strategy is a plain JSON file you can edit (custom chunkers per convention — `@Table` entities, code-enum interfaces, your own annotations). Adding symbol-level parsing for a new language is a code change with a clear seam. See [docs/extending.md](docs/extending.md).

[`templates/commands/`](templates/commands/) ships a ready-made Claude Code slash command (`/mindcairn-start`) — copy it into your project's `.claude/commands/`, replace the placeholder skill/agent names with your team's, and you get a mindcairn-first workflow entry point (task kickoff, free-form search, SQL drafting, debugging, retros).

## Limitations

Straight from the verification round — known today, on the roadmap:

1. **Symbol-level chunking is Kotlin/Java only.** Go/Python/TS get file-unit chunks (the regex parser doesn't extract their classes/methods). Search works, but per-function precision is lower than for JVM languages. Incremental `sync` also only picks up changed `.kt` files today and requires a prior `build --ref` (which records the baseline SHA) — for other languages, re-run `build`.
2. **Multiple file-unit chunkers can chunk the same file more than once** — gin: 58 files → 111 chunks; trpc: 182 files → 473 chunks. Search-time quotas soften the bias, but index size and enrich cost grow.
3. **The claude-cli path is bound by your session usage limit.** Enrichment can fail under a 429 even with retries; re-running `init` retries only the failed chunks thanks to the cache.
4. **Korean-first UX** — the CLI wizard, log output, and enrichment labels are currently in Korean (the codebase comes from a Korean team). Search itself is language-agnostic (bge-m3 is multilingual), but a UI language option is not implemented yet.
5. **No graph layer, no automatic memory extraction.** This is pure hybrid retrieval; decisions enter the index only via explicit `capture_decision` / `ingest_doc`.

## FAQ

**Does my code leave my machine?**
Embeddings and vector search are local (Ollama + Qdrant). The discovery/strategy analysis and optional chunk enrichment send code snippets to Claude — via your existing Claude Code CLI login or an API key. Set `ENRICHER=off` to minimize LLM calls; the one-time discovery + strategy analysis is all that remains. For **zero** LLM calls, hand-write the strategy JSON and `build --strategy` directly — see [No-LLM mode](docs/extending.md#25-no-llm-mode--hand-written-strategy-zero-code-leaves-your-machine). See also [Privacy & data flow](#privacy--data-flow).

**Why Bun and not Node?**
mindcairn uses `bun:sqlite` for chunk storage and gets a fast dev loop for free. Node is not supported.

**Which languages are supported?**
Kotlin/Java get a dedicated structural parser today; TypeScript/JavaScript, Python, Go, Rust, and SQL are indexed via the generic file-unit strategy (see [Limitations](#limitations)). The strategy agent picks what fits your repo.

**How do remote teammates connect?**
The server binds `0.0.0.0`, so anything that gives them network access works — we use [Tailscale](https://tailscale.com). Run the shared instance with `MINDCAIRN_READONLY=1` and put your own IP in `MINDCAIRN_WRITE_IPS`.

**How is this different from Glean / Sourcegraph?**
Those are excellent for large orgs — and priced/operated like it. mindcairn targets the other end: one developer, one spare machine, one `init` command, a team of one to ten.

**Can it index my Notion / internal docs?**
Yes — `ingest_doc` (MCP tool) for one-offs, plus batch scripts for Notion exports. Docs, decisions, and code share the same hybrid index.

## License

[MIT](LICENSE)
