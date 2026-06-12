---
description: Auto-ingest a Notion export (zip/dir) into mindcairn. Normalization + chunking + search indexing in one go.
---

# /mindcairn-ingest

**Takes an input path and ingests it into mindcairn.** If it's a zip, unzip it; if it's an md/dir, use it as-is. Following Ingestion Spec v1, it auto-classifies → produces `doc_*` chunks → stores them in SQLite + Qdrant.

Detailed rules: `mindcairn/docs/ingestion-spec.md`

## Usage

```
/mindcairn-ingest <path>
```

Examples:
```
/mindcairn-ingest ~/Downloads/TaskDB.zip
/mindcairn-ingest ~/notes/wiki/
/mindcairn-ingest /tmp/meeting-2026-05/
```

## Steps (for the assistant to follow)

When the user runs `/mindcairn-ingest <path>`, do the following:

### 1. Classify the path
```bash
if [[ "$path" == *.zip ]]; then
  type=zip
elif [[ -d "$path" ]]; then
  type=dir
elif [[ -f "$path" ]]; then
  type=file
fi
```

### 2. If it's a zip, unzip with ditto (preserves Korean filenames on macOS)
```bash
TS=$(date +%Y%m%d-%H%M%S)
UNZIP_DIR="/tmp/mindcairn-ingest-$TS"
ditto -x -k "$path" "$UNZIP_DIR"
# Use the first-level inner directory as the source
SOURCE_DIR=$(ls -d "$UNZIP_DIR"/*/ | head -1 || echo "$UNZIP_DIR")
```

### 3. normalize (if it's a Notion export format)
```bash
cd <mindcairn-repo>
bun run scripts/normalize-notion-export.ts "$SOURCE_DIR"
```

### 4. ingest (SQLite + Qdrant + Enricher)
```bash
cd <mindcairn-repo>
bun run scripts/ingest-notion.ts <tag>
```

### 5. Report the result
The ingest output includes a `by kind: {...}` line. Report the following to the user:
- Number of chunks
- kind distribution (doc_spec/doc_design/...)
- Enrich cost
- A one-line search check ("now search mindcairn MCP for 'X' and you'll see doc_* chunks included")

### 6. Restart mindcairn serve (optional)
To reflect the SQLite changes in search immediately, restart serve:
```bash
# Find the serve PID
pid=$(lsof -i :8765 -sTCP:LISTEN -t)
[ -n "$pid" ] && kill "$pid" && sleep 2

# Restart
cd <mindcairn-repo>
caffeinate -i bun run src/cli/index.ts serve <tag> > /tmp/mindcairn-serve.log 2>&1 &
disown
```

## Assumptions / constraints

- Currently `normalize-notion-export.ts` only supports the **Notion markdown export format**
- Other sources (wiki/Slack) need a separate normalize script (see `docs/ingestion-spec.md` § 7)
- Assumes the machine running mindcairn serve = the machine you're currently using. For a remote Tailscale machine, you must run it there directly.

## kind classification rules (summary)

Defined per instance in `instances/<tag>/notion-rules.ts`. Example mapping (from `instances/example`):

| Notion frontmatter | mindcairn kind |
|---|---|
| Type=spec | `doc_spec` |
| Type=design | `doc_design` |
| Type=qa | `doc_qa` |
| Type=ops | `doc_ops` |
| Type=data OR Role=data | `doc_data` |
| Type=infra OR Role=infra | `doc_infra` |
| Anything else | `doc_misc` |

Full rules: `mindcairn/docs/ingestion-spec.md`
