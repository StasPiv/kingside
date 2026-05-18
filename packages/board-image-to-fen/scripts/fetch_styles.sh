#!/usr/bin/env bash
# Downloads chess piece sets for the board-image-to-fen dataset (KS-2360 v1
# + KS-3091 v2).
#
# Sources (all open-source; see manifest_v2.json for per-style license):
#   v1 (still required for val_only in v2):
#     - lichess_{cburnett,merida,alpha,staunty,pirouetti}  : lila/public/piece (SVG)
#     - lichess_wikipedia                                  : Wikimedia Commons (SCID)
#     - kingside_default                                   : copy of cburnett
#   v2 train_only (KS-3091, chess-expert finalised list):
#     - lichess_{tatiana,caliente,fantasy,gioco,riohacha,dubrovny,kosal,letter} : lila/public/piece (SVG)
#     - lichess_monarchy                                                       : lila/public/piece (WebP only)
#
# Commit pin: written to styles_cache/.lila_commit. Re-run idempotent.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/styles_cache"
mkdir -p "$CACHE"

PIECES="wK wQ wR wB wN wP bK bQ bR bB bN bP"

# Pin the lila master commit at first run (for reproducibility).
if [[ ! -s "$CACHE/.lila_commit" ]]; then
  curl -sSL "https://api.github.com/repos/lichess-org/lila/commits/master" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['sha'])" \
    > "$CACHE/.lila_commit"
fi
LILA_SHA="$(cat "$CACHE/.lila_commit")"
echo "[fetch_styles] lila commit: $LILA_SHA"

fetch_lichess() {
  local style="$1"
  local dir="$CACHE/lichess_$style"
  mkdir -p "$dir"
  for p in $PIECES; do
    local out="$dir/$p.svg"
    [[ -s "$out" ]] && continue
    local url="https://raw.githubusercontent.com/lichess-org/lila/$LILA_SHA/public/piece/$style/$p.svg"
    local code
    code="$(curl -sSL -o "$out" -w "%{http_code}" "$url")"
    if [[ "$code" != "200" ]]; then
      echo "[ERR] lichess_$style/$p.svg → HTTP $code"
      rm -f "$out"
      return 1
    fi
  done
  echo "[ok] lichess_$style ($(ls "$dir" | wc -l) files)"
}

# Wikipedia chess pieces are SCID Cburnett SVG on Commons.
# Naming scheme: Chess_{piece}{color}t45.svg where piece={k,q,r,b,n,p}, color={l=light/white, d=dark/black}.
fetch_wikipedia() {
  local dir="$CACHE/lichess_wikipedia"
  mkdir -p "$dir"
  declare -A MAP=(
    [wK]="klt45" [wQ]="qlt45" [wR]="rlt45" [wB]="blt45" [wN]="nlt45" [wP]="plt45"
    [bK]="kdt45" [bQ]="qdt45" [bR]="rdt45" [bB]="bdt45" [bN]="ndt45" [bP]="pdt45"
  )
  for p in $PIECES; do
    local out="$dir/$p.svg"
    [[ -s "$out" ]] && continue
    local fn="Chess_${MAP[$p]}.svg"
    local h1 h2
    h1="$(echo -n "$fn" | md5sum | cut -c1)"
    h2="$(echo -n "$fn" | md5sum | cut -c1-2)"
    local url="https://upload.wikimedia.org/wikipedia/commons/$h1/$h2/$fn"
    local code
    code="$(curl -sSL -A "Mozilla/5.0 Kingside-bot" -o "$out" -w "%{http_code}" "$url")"
    if [[ "$code" != "200" ]]; then
      echo "[ERR] lichess_wikipedia/$p → HTTP $code"
      rm -f "$out"
      return 1
    fi
  done
  echo "[ok] lichess_wikipedia ($(ls "$dir" | wc -l) files)"
}

for s in cburnett merida alpha staunty pirouetti; do
  fetch_lichess "$s"
done
fetch_wikipedia

# kingside_default = same cburnett SVG (react-chessboard MIT default is cburnett-derived).
# Visual diversity for this style comes from a distinct board palette in dataset_gen.py.
mkdir -p "$CACHE/kingside_default"
cp -f "$CACHE/lichess_cburnett"/*.svg "$CACHE/kingside_default"/
echo "[ok] kingside_default ($(ls "$CACHE/kingside_default" | wc -l) files, derived from cburnett)"

# ──────────────────────────────────────────────────────────────────────
# KS-3091 / ADR-040-v2 train_only piece-sets.
#
# 9 styles chosen by chess-expert (KS-3091 comment) to cover non-mainstream
# visual classes orthogonal to v2 val (kingside_default + lichess_cburnett/
# merida/wikipedia/alpha + chess.com proxies). pirouetti excluded — visually
# leaks chess.com_classic. gioco added as «stylized rounded» replacement.
# ──────────────────────────────────────────────────────────────────────

# 8 SVG sets.
for s in tatiana caliente fantasy gioco riohacha dubrovny kosal letter; do
  fetch_lichess "$s"
done

# monarchy is distributed as WebP only.
fetch_lichess_webp() {
  local style="$1"
  local dir="$CACHE/lichess_$style"
  mkdir -p "$dir"
  for p in $PIECES; do
    local out="$dir/$p.webp"
    [[ -s "$out" ]] && continue
    local url="https://raw.githubusercontent.com/lichess-org/lila/$LILA_SHA/public/piece/$style/$p.webp"
    local code
    code="$(curl -sSL -o "$out" -w "%{http_code}" "$url")"
    if [[ "$code" != "200" ]]; then
      echo "[ERR] lichess_$style/$p.webp → HTTP $code"
      rm -f "$out"
      return 1
    fi
  done
  echo "[ok] lichess_$style ($(ls "$dir" | wc -l) webp files)"
}
fetch_lichess_webp monarchy

echo "[fetch_styles] done. Total: $(find "$CACHE" -maxdepth 2 -type f \( -name '*.svg' -o -name '*.webp' \) | wc -l) piece files."
