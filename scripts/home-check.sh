#!/bin/bash
#
# home-check — check the mindcairn stack + start only what's not running (idempotent).
#
#   bash scripts/home-check.sh          # check + recover only what's dead
#   bash scripts/home-check.sh --check  # check only (no recovery)
#
# Depends on: Qdrant(docker, 6333) / Ollama(11434) / mindcairn serve / cron
# Things that need a human (Docker Desktop/Ollama app not running) are not launched — it only 'advises'.
#
# Adjust to your environment:
#   - MINDCAIRN_DIR / MINDCAIRN_REPO_DIR (can also be injected via env)
#   - TAGS: list of "tag:port" (add an entry when adding an instance)
#   - READONLY_TAGS: shared-instance tags that expose only search tools (space-separated)
#   - MINDCAIRN_WRITE_IPS(env): whitelist of IPs allowed to use write tools (e.g. VPN/Tailscale IP, comma-separated)
#     If unset, the server's default policy applies (localhost is always allowed).

set -uo pipefail
MINDCAIRN_DIR="${MINDCAIRN_DIR:-$HOME/mindcairn}"
REPO_DIR="${MINDCAIRN_REPO_DIR:-}"          # git repo being indexed (for origin drift check, optional)
BUN="$(command -v bun || echo /opt/homebrew/bin/bun)"
# On macOS use caffeinate to prevent sleep; on other OSes just run (cross-platform)
KEEPAWAKE=""
command -v caffeinate >/dev/null 2>&1 && KEEPAWAKE="caffeinate -i"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

# Instance list — 1 example. Add as many as needed.
declare -a TAGS=("example-app:8765")
READONLY_TAGS=""                         # e.g. "shared-docs" (read-only shared instance)
WRITE_IPS="${MINDCAIRN_WRITE_IPS:-}"

declare -a ALERTS=()
ok()   { echo "  ✅ $1"; }
warn() { echo "  ⚠️  $1"; ALERTS+=("$1"); }   # ⚠️ entries are collected in the summary at the bottom
act()  { echo "  ▶  $1"; }

http_ok() { curl -s -m 3 "$1" >/dev/null 2>&1; }

echo "═══ mindcairn stack check ═══"

# 1) Qdrant (docker)
echo "[1] Qdrant (6333)"
if http_ok http://localhost:6333/collections; then
  ok "running"
else
  if [ $CHECK_ONLY -eq 1 ]; then warn "down"; else
    if docker info >/dev/null 2>&1; then
      act "docker start qdrant"
      docker start qdrant >/dev/null 2>&1 && sleep 3
      http_ok http://localhost:6333/collections && ok "recovered" || warn "started but no response"
    else
      warn "Docker not running — must turn it on first (manual)"
    fi
  fi
fi

# 2) Ollama (11434) — bge-m3 embedding
echo "[2] Ollama (11434)"
if http_ok http://localhost:11434/api/tags; then
  ok "running"
else
  if [ $CHECK_ONLY -eq 1 ]; then warn "down"; else
    if command -v ollama >/dev/null 2>&1; then
      act "ollama serve (background)"
      nohup ollama serve >/tmp/ollama.log 2>&1 &
      sleep 3
      http_ok http://localhost:11434/api/tags && ok "recovered" || warn "started but no response"
    else
      warn "no ollama command — Ollama app must be started manually"
    fi
  fi
fi

# 3) mindcairn serve
echo "[3] mindcairn serve"
for entry in "${TAGS[@]}"; do
  tag="${entry%%:*}"; port="${entry##*:}"
  if http_ok "http://localhost:$port/health"; then
    ok "$tag ($port) running"
  else
    if [ $CHECK_ONLY -eq 1 ]; then warn "$tag ($port) down"; else
      act "$tag serve start (port $port)"
      ro=""
      case " $READONLY_TAGS " in *" $tag "*) ro="1" ;; esac   # shared instance → search tools only
      ( cd "$MINDCAIRN_DIR" && MINDCAIRN_MCP_PORT="$port" MINDCAIRN_READONLY="$ro" MINDCAIRN_WRITE_IPS="$WRITE_IPS" $KEEPAWAKE "$BUN" run src/cli/index.ts serve "$tag" \
          > ".mindcairn/serve-$tag.log" 2>&1 & )
    fi
  fi
done
# serve takes time to come up — in recovery mode, re-check after a short wait
if [ $CHECK_ONLY -eq 0 ]; then
  sleep 7
  echo "  ── re-check ──"
  for entry in "${TAGS[@]}"; do
    tag="${entry%%:*}"; port="${entry##*:}"
    http_ok "http://localhost:$port/health" && ok "$tag ($port)" || warn "$tag ($port) still no response (log: .mindcairn/serve-$tag.log)"
  done
fi

# 4) cron (persists across reboots, but check anyway)
echo "[4] cron incremental sync"
if crontab -l 2>/dev/null | grep -q "sync-all.ts"; then
  ok "sync-all registered"
else
  warn "no sync-all cron — registration needed (see comments in scripts/sync-all.ts)"
fi

# 5) Sync freshness — detect 'silently stale/stuck with no error'
echo "[5] Sync freshness"
# 5-1) last sync completion time → whether cron is actually running
SYNC_LOG="$MINDCAIRN_DIR/.mindcairn/sync-all.log"
MINS=$(python3 - "$SYNC_LOG" <<'PY' 2>/dev/null
import sys, re, datetime
try:
    txt = open(sys.argv[1]).read()
    ts = re.findall(r'\[(20\d\d-\d\d-\d\dT[\d:.]+Z)\] sync-all done', txt)
    last = datetime.datetime.fromisoformat(ts[-1].replace('Z', '+00:00'))
    now = datetime.datetime.now(datetime.timezone.utc)
    print(int((now - last).total_seconds() // 60))
except Exception:
    print(-1)
PY
)
if [ "${MINS:--1}" -lt 0 ]; then warn "no sync log / unparseable"
elif [ "$MINS" -gt 30 ]; then warn "last sync ${MINS} min ago — cron may be stuck"
else ok "last sync ${MINS} min ago"; fi

# 5-2) origin drift — behind the true latest. Caught here if git auth is broken.
if [ -n "$REPO_DIR" ] && [ -d "$REPO_DIR" ]; then
  REMOTE_SHA=$(cd "$REPO_DIR" 2>/dev/null && timeout 12 git ls-remote origin HEAD 2>/dev/null | awk '{print $1}')
  if [ -z "$REMOTE_SHA" ]; then
    warn "origin lookup failed — git auth/network down. mindcairn cannot receive new code"
  else
    DRIFT=0
    for d in "$MINDCAIRN_DIR"/.mindcairn/*/; do
      [ -f "$d/state.json" ] || continue
      ISHA=$(python3 -c "import json;print(json.load(open('$d/state.json')).get('sha',''))" 2>/dev/null)
      [ "${ISHA:0:12}" != "${REMOTE_SHA:0:12}" ] && DRIFT=$((DRIFT + 1))
    done
    if [ "$DRIFT" -gt 0 ]; then warn "$DRIFT instance(s) behind origin(${REMOTE_SHA:0:8})"
    else ok "all instances match origin latest (${REMOTE_SHA:0:8})"; fi
  fi
fi

# ── Issue summary ──
if [ ${#ALERTS[@]} -gt 0 ]; then
  echo ""
  echo "⚠️  ${#ALERTS[@]} check issue(s):"
  for a in "${ALERTS[@]}"; do echo "   • $a"; done
else
  echo ""
  echo "✅ all healthy — no issues"
fi

echo "═══ check done ═══"
