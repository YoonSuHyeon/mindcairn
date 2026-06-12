# Mindcairn Ingestion Spec v1

> This document is the standard for how the **external document data mindcairn receives (Notion / wiki / meeting notes / Slack, etc.)**
> is chunked, tagged, and stored.
> Follow the rules in this document whenever you add new data.

## 1. Three-axis classification

Data is classified and tagged along the following three axes.

| Axis | Values | Metadata location |
|---|---|---|
| **source** | `notion` / `slack` / `meeting` / `wiki` / `manual_capture` / ... | `metadata.source` |
| **kind** | `doc_spec` / `doc_design` / `doc_qa` / `doc_ops` / `doc_data` / `doc_infra` / `doc_misc` | `chunk.type` (chunker type) |
| **domain** | `order` / `member` / `payment` / `batch` / ... | `metadata.domain` (set automatically by the enricher) |

> kind is used directly as the chunker type → you can tune the per-type search ratio via `retrievalQuota` in strategy.json.

## 2. kind definitions

| kind | Meaning | Example |
|---|---|---|
| `doc_spec` | Planning / requirements / specs | "[Planning] Member dashboard improvements" |
| `doc_design` | Dev design / implementation notes / API changes | "[BE Dev] Order-sheet parsing API response spec" |
| `doc_qa` | Testing / verification / discovered issues | "[QA] Order registration verification scenarios" |
| `doc_ops` | Operations / deployment / monitoring / policy | "[Ops] Handling a temporary order suspension" |
| `doc_data` | Analysis / SQL / reports / metric definitions | "First-order conversion rate of new members within 7 days" |
| `doc_infra` | Systems / network / permissions / infrastructure | "VPC routing change" |
| `doc_misc` | Auto-classification failed / other | Category header pages, etc. |

## 3. Mapping rules

### Notion (frontmatter)

Each instance defines this mapping in `instances/<tag>/notion-rules.ts` (`classifyKind`) against
its own column names. The example below uses the columns from `instances/example/notion-rules.ts`:

```ts
Type = 'spec'                       → doc_spec
Type = 'design'                     → doc_design
Type = 'qa'                         → doc_qa
Type = 'ops'                        → doc_ops
Type = 'data'  OR Role = 'data'     → doc_data
Type = 'infra' OR Role = 'infra'    → doc_infra
anything else / missing            → doc_misc
```

> Non-English column names work too — just read the keys your frontmatter actually has
> (e.g. `fm['유형']`). Adjust both `classifyKind` and `extractDocMeta` to your schema.

### Slack / meeting notes / other sources
- When there's no explicit frontmatter, the enricher infers it by analyzing the body (LLM)
- On inference failure, fall back to `doc_misc`

## 4. Chunking rules

| source | Chunk unit | Length threshold |
|---|---|---|
| notion | H2/H3 section | skip if under 30 chars |
| meeting | Per speaker or H2 section | skip if under 30 chars |
| slack | Per thread | skip if under 50 chars |
| wiki | H2 section | skip if under 30 chars |

## 5. Metadata standard (for notion)

```ts
{
  type: <kind>,                  // used as the chunker type
  source: 'notion',
  file: <md filename>,
  title: <section H2/H3 title>,
  pageTitle: <Notion page title>,
  pageUrl: <Notion URL>,
  pageId: <Notion page id>,
  taskId: <task ID, e.g. TASK-1234>,
  status: <status, e.g. done/canceled/in-progress>,
  docType: <docType from extractDocMeta, e.g. the Notion 'Type' column>,
  job: <job from extractDocMeta, e.g. the Notion 'Role' column>,
  owners: <task owners>,
  plannedAt: <planned date>,
  executedAt: <execution date>,
  enrichedLabel: <Enricher v2 result>,
  identifiers: { tables, columns, keywords, ... },  // Enricher v2
  domain: <inferred by the enricher>,                 // Enricher v2
}
```

## 6. retrievalQuota (per-type cap at search time)

The `retrievalQuota` in `indexing-strategy.json`. Per search, the max number of chunks of each type that can be included in the response.

```jsonc
{
  // code (~34)
  "code_enum_value": 3,
  "domain_model": 2,
  "repository_method": 4,
  ...

  // docs (~10)
  "doc_spec": 2,
  "doc_design": 2,
  "doc_qa": 1,
  "doc_ops": 1,
  "doc_data": 2,
  "doc_infra": 1,
  "doc_misc": 1
}
```

→ For a topK=10 search, that's a ~6 code + ~4 docs balance. Adjust to fit the search intent.

## 7. Procedure for adding new data

### Case A — new Notion export (or another DB)
1. In Notion, apply a view filter → Export Markdown
2. Download to `~/Downloads/<name>.zip`
3. `/mindcairn-ingest <zip-path>` or:
   ```bash
   ditto -x -k <zip> /tmp/notion-export
   bun run scripts/normalize-notion-export.ts "/tmp/notion-export/<dir>"
   bun run scripts/ingest-notion.ts
   ```
4. Restart mindcairn serve (to reflect it in search immediately)

### Case B — non-Notion source (wiki/meeting notes/Slack)
1. Write a normalize script per source (`scripts/normalize-<source>.ts`)
2. Save the normalized output to `inputs/<source>/` — the same YAML frontmatter format is recommended
3. Write `ingest-<source>.ts` (or adapt the classifyKind rules from `ingest-notion.ts`)

## 8. Using it in search

MCP `search_codebase("member dashboard improvements")` →
- Returns code chunks (domain_model / repository_method, etc.) together with doc chunks (doc_spec / doc_design)
- The `taskId` / `status` metadata from frontmatter lets you track progress
- Use `find_pattern(query="...", type="doc_design")` to filter for design docs only

## 9. Fallbacks for missing fields

- Notion page with no `Type` column → `doc_misc`
- Pages with `Status = canceled` are also ingested (usable at search time via metadata.status)
- Sections under 30 chars → skip (not indexed)
