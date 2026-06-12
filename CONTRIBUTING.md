# Contributing to mindcairn

Thanks for taking a look. mindcairn is young and feedback shapes it — issues, ideas, and PRs are all welcome.

## Quick dev setup

```bash
bun install
bun run typecheck        # tsc --noEmit — keep this green
```

To run it end to end you need Qdrant (`docker compose up -d`), an embedding provider (Ollama with `bge-m3`, or OpenAI), and an LLM path (Claude Code CLI logged in, or `ANTHROPIC_API_KEY`). See the [Quickstart](README.md#quickstart).

## Good first contributions

These are high-impact and explicitly welcome:

- **Localization** — the CLI/docs are English-first. Helping localize user-facing output (the wizard, logs) to other languages is welcome. The Korean-language tokenizer in `src/builder/bm25.ts` shows the pattern for adding more scripts/languages.
- **Language-aware chunking** — symbol-level chunking is strongest for Kotlin/Java today (`src/builder/kotlin-parser.ts`); other languages fall back to file-unit. Parsers/strategies for TypeScript, Python, Go, etc. would help a lot.
- **Source adapters** — `ingest_doc` + `instances/<tag>/notion-rules.ts` map an external source's fields into mindcairn. Adapters/examples for other doc sources are welcome.
- **Eval cases** — the benchmark scripts under `scripts/` use example queries; better/broader eval sets improve search-quality regression coverage.

## Pull requests

1. Branch off `main`.
2. Keep `bun run typecheck` green.
3. Keep changes focused; describe the *why* in the PR.
4. User-facing strings (CLI output, MCP tool descriptions, errors) should be English. Per-instance config (e.g. `notion-rules.ts`) can use any language.
5. Don't commit secrets or instance data — `.env`, `.mindcairn/`, and `instances/<your-tag>/` are gitignored for a reason.

## Reporting issues

Use the issue templates. For search-quality problems, include the query and what you expected vs. what you got — that's the most useful signal.

By contributing you agree your contributions are licensed under the project's [MIT License](LICENSE).
