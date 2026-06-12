# Benchmarks — verification on real repos

End-to-end `init → serve → search` runs against three public, non-JVM repos. Every number comes from actual run logs (`time`, init output, SQLite/Qdrant counts) — no estimates.

- Environment: macOS, Bun, Ollama `bge-m3` (1024d), local Qdrant, LLM via Claude Code CLI (OAuth)
- Judging criterion: correct file inside `search_codebase` top-5

## Summary

| Repo | Language | `init` time | Files | Chunks (SQLite = Qdrant) | Distinct labels | Search hits |
|---|---|---|---|---|---|---|
| gin-gonic/gin | Go | 166.7s | 58 | 111 | 111 | 3/3 |
| trpc/trpc | TS monorepo | 267.3s (+ repair build 174.2s) | 182 | 473 | 473 | 3/3 |
| fastapi/fastapi | Python | 113.3s | 48 | 81 (87 generated, 6 deduped on id collision) | 78 | 3/3 |

## Query details (top-5 rank)

### gin
| Query | Expected file | Rank |
|---|---|---|
| where is RouterGroup defined | routergroup.go | #1 |
| how does gin recover from panics in middleware | recovery.go | #1 |
| radix tree url path parameter matching | tree.go | #1 |

### trpc
| Query | Expected file | Rank |
|---|---|---|
| where is the procedure builder defined | procedureBuilder.ts | #1 |
| how does the http batch link combine multiple requests into one | httpBatchLink.ts | #3 |
| websocket adapter handling subscriptions on the server | ws.ts | #1 |

### fastapi
| Query | Expected file | Rank |
|---|---|---|
| where is APIRouter defined | fastapi/routing.py | #1 |
| how does dependency injection resolve Depends parameters | fastapi/dependencies/utils.py | #2 |
| OAuth2 password bearer security scheme | fastapi/security/oauth2.py | #2 |

## Bugs found and fixed during this round

1. **Non-Kotlin file chunks lost their body, homogenizing labels/embeddings** — file-unit `rawContent` was rebuilt via the Kotlin symbol parser, leaving it empty for Go/Python/TS; the strategy LLM also invented unsupported template variables that rendered to empty strings, and `*_test.go` files added noise. Fixed by using the raw file head (4000B) for non-JVM languages, pinning the supported template variables in the strategy prompt, and excluding test files by convention.
2. **TS `interface` partially matched the Kotlin class regex, truncating bodies** — e.g. a 6KB `middleware.ts` shrank to 79B; 19% of trpc chunks were affected. Symbol reconstruction is now applied to `.kt/.kts/.java` only.
3. **Enricher batch failures were silent, so `init` exited 0 with unlabeled chunks** — under a 429, 368/473 chunks ended up unlabeled with no warning. Now retries twice per batch (3s/15s backoff) and prints an unlabeled-chunks summary on exit; re-running `init` retries only the failed chunks thanks to the cache.

The limitations observed here are listed in the [README](../README.md#limitations).
