#!/usr/bin/env bash
# Downloads chess piece SVG sets for the board-image-to-fen dataset (KS-2360).
#
# Sources (all open-source, see LICENSES.md):
#   - lichess_{cburnett,merida,alpha,staunty,pirouetti} : github.com/lichess-org/lila/public/piece
#   - lichess_wikipedia                                  : commons.wikimedia.org (SCID Cburnett SVG, equivalent set)
#   - kingside_default                                   : copy of cburnett (react-chessboard default is cburnett-derived; visual diversity comes from the board palette, not pieces)
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

echo "[fetch_styles] done. Total: $(find "$CACHE" -maxdepth 2 -name '*.svg' | wc -l) SVG files."
