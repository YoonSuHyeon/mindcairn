# Extending mindcairn for your company

Every company's codebase looks different — different conventions, different layers, different languages. mindcairn is built so that most per-company adaptation needs **no code at all**: the strategy agent designs chunkers for your repo, and everything it designs lives in an editable JSON file. This guide covers the four extension points, from zero-code to code.

| What you want to change | Where | Code? |
|---|---|---|
| Which files get indexed | `instances/<tag>/preset.ts` | No |
| How files are chunked / embedded / quota'd | `.mindcairn/<tag>/indexing-strategy.json` | No |
| How external docs (Notion, wiki) are classified | `instances/<tag>/notion-rules.ts` | A tiny mapping function |
| Symbol-level parsing for a new language | `src/builder/` | Yes |

## 1. Preset — which files get indexed

`init` auto-detects languages and generates include/exclude globs, but for monorepos or repos with noise you'll want explicit control. Copy the example:

```bash
mkdir -p instances/my-app
cp instances/example/preset.ts instances/my-app/preset.ts
```

```ts
export const preset: Preset = {
  include: [
    'domain/**/*.kt',
    'application/**/*.kt',
    'core/src/main/kotlin/**/*.kt',   // only shared modules worth searching
  ],
  exclude: ['**/test/**', '**/build/**', '**/*Test.kt'],
};
```

Then run any stage with `--preset my-app`. Rule of thumb: exclude tests and generated code — they dominate chunk counts and add noise (we saw 41 `*_test.go` files drown out 58 source files before excluding them by default).

## 2. Indexing strategy — chunkers without code

This is the main extension point. During `init`, the strategy agent inspects your repo and writes `.mindcairn/<tag>/indexing-strategy.json`. **That file is yours to edit.** Each chunker is declarative:

```jsonc
{
  "chunkers": [
    {
      "name": "entity",                          // chunk type name (shows up in search results)
      "matcher": {
        "pathGlob": ["**/entity/**/*.kt"],       // and/or:
        "annotation": "@Table",                  // classes with this annotation
        "superType": "CodeValueEnum"              // classes implementing this interface
      },
      "unit": "class",                           // file | class | method | enum (custom = class fallback)
      "embeddingTextTemplate": "entity {{className}} (table {{tableName}})\n{{kdoc}}\n{{properties}}",
      "metadataKeys": ["className", "tableName", "package"]
    }
  ],
  "retrievalQuota": { "entity": 2, "method": 3 } // per-type result caps at search time
}
```

So "my company marks domain events with `@DomainEvent`" is one new chunker block — matcher on the annotation, a template that surfaces the event name and KDoc — not a code change.

Template variables available (anything else renders as an empty string):

| Unit | Variables |
|---|---|
| all | `{{file}}` `{{filePath}}` `{{fileName}}` `{{package}}` |
| `file` | `{{fileHead}}` (first 4000 bytes of source) |
| `class` / `enum` | `{{className}}` `{{kind}}` `{{kdoc}}` `{{annotations}}` `{{superTypes}}` `{{properties}}` `{{tableName}}` `{{enumEntries}}` |
| `method` | `{{methodName}}` `{{className}}` `{{signature}}` `{{parameters}}` `{{returnType}}` `{{kdoc}}` `{{annotations}}` `{{body}}` |

After editing, rebuild the index (the enrichment cache makes re-runs cheap — unchanged chunks aren't re-labeled):

```bash
bun run src/cli/index.ts build /path/to/repo --preset my-app --enrich
```

(`--preset my-app` doubles as the tag; if `instances/<tag>/preset.ts` exists, `--tag my-app` alone also picks it up.)

Tuning tips from our own deployments:

- **One chunker per company-standard pattern.** If your repo has a code-enum convention (enums implementing a shared interface), give it its own chunker with `superType` matcher and `{{enumEntries}}` in the template — exact code-value lookups improve dramatically.
- **5–10 chunkers is the sweet spot.** More means duplicate chunks per file and enrich cost; quotas only soften the bias.
- **`retrievalQuota` prevents one chunk type from flooding results** — if DDL/enum chunks outnumber everything, cap them at 2–3.

## 2.5 No-LLM mode — hand-written strategy, zero code leaves your machine

The discovery/strategy agents are a convenience, not a requirement — their only output is the strategy JSON above. If your security policy forbids sending code to an LLM (or you just want full control), write the strategy yourself and skip them entirely:

```bash
cp instances/example/indexing-strategy.json my-strategy.json   # generic Kotlin/Spring starter — edit chunkers to taste
bun run src/cli/index.ts build /path/to/repo --strategy my-strategy.json --tag my-app
bun run src/cli/index.ts serve my-app
```

What runs where in this mode:

| Step | LLM calls | Data leaving your machine |
|---|---|---|
| `build --strategy` (no `--enrich`) | **0** | none — chunking is local parsing |
| embedding | 0 | none — local Ollama (`bge-m3`) |
| search / serve | 0 | none |

The trade-off: no enrichment labels, so embeddings index raw chunk text — search precision is lower than the enriched path. A middle ground: run discovery once on a repo you're comfortable sharing structure for, review/edit the generated JSON, and keep `ENRICHER=off`. The `--strategy` file is copied into `.mindcairn/<tag>/` automatically so `search`/`serve` find it.

## 3. External docs — classification rules

`ingest_doc` and the Notion batch scripts classify documents into kinds (`doc_spec`, `doc_design`, `doc_qa`, ...) via a per-instance rule file. Copy and adapt to your own Notion columns:

```bash
cp instances/example/notion-rules.ts instances/my-app/notion-rules.ts
```

```ts
export const classifyKind: ClassifyKind = (fm) => {
  if (fm['Type'] === 'RFC') return 'doc_design';
  if (fm['Team'] === 'QA') return 'doc_qa';
  return 'doc_misc';
};
```

The full ingestion contract (3-axis tagging, frontmatter whitelist, normalize scripts) is in [ingestion-spec.md](ingestion-spec.md).

## 4. A new language parser (code)

Today only Kotlin/Java get symbol-level chunks (`unit: class | method | enum`); other languages fall back to file-unit chunks, which still search fine but with lower per-function precision. To add structural parsing for another language:

1. **Write a parser** in `src/builder/` that returns the `ParsedFile` shape defined in [`kotlin-parser.ts`](../src/builder/kotlin-parser.ts) — also the reference implementation (regex-based, ~260 lines; a tree-sitter-based parser would slot in the same way).
2. **Wire the dispatch** in `src/agents/builder.ts`:
   - `getParsed()` — pick your parser by file extension.
   - the `structuredLang` regex (`/\.(kt|kts|java)$/`) — add your extensions so class/method units use symbol reconstruction instead of the raw-file-head fallback.
3. **Tell the strategy agent** in `src/agents/strategy-agent.ts` — the prompt currently instructs it to use `unit: file` for non-JVM languages; relax that for yours.
4. **Check the incremental path**: `cmdSync` in `src/cli/index.ts` currently filters changed files to `.kt` only — add your extensions there, or incremental `sync` will skip your language (full `build` still covers it). Note also that class/enum raw-content reconstruction (`buildClassRawContent`) emits Kotlin-shaped syntax; for a very different language you may want a per-language variant.
5. **Verify**: run `init` on a repo in that language and check that chunk counts per type look sane and `search` finds function-level queries.

Caution from our verification round: partial regex matches across languages are the main hazard — a TS `interface` once matched the Kotlin class regex and silently truncated chunk bodies. Keep parsers strictly gated by extension.

## Where state lives

| Path | What |
|---|---|
| `instances/<tag>/` | Your preset + ingestion rules (commit these) |
| `.mindcairn/<tag>/` | Generated: discovery, strategy JSON, `chunks.sqlite`, enrich cache (gitignored) |
| Qdrant collection `mindcairn_<tag>` | Vectors (dense + BM25 sparse) — non-alphanumerics in the tag become `_` (`my-app` → `mindcairn_my_app`) |

Deleting `.mindcairn/<tag>` + the Qdrant collection fully resets an instance.
