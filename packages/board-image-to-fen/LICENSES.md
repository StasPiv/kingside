# Board-recog dataset v1 — Style licenses & attributions

This file documents the source, license and attribution of every chess piece
set bundled into the v1 dataset (`packages/board-image-to-fen/data/v1`).
Curation approved by chess-expert (KS-2360 comment, 2026-05-04).

| # | Style              | License                                | Redistribute | Source                                                                                  | Attribution                                                                  |
|---|--------------------|----------------------------------------|--------------|------------------------------------------------------------------------------------------|------------------------------------------------------------------------------|
| 1 | lichess_cburnett   | GPL-3.0 / CC BY-SA 3.0 (dual)          | ✅           | github.com/lichess-org/lila (pinned commit, see `styles_cache/.lila_commit`)             | Colin M.L. Burnett                                                           |
| 2 | lichess_merida     | GPL-2.0+                               | ✅           | github.com/lichess-org/lila/public/piece/merida                                          | Armando H. Marroquín                                                         |
| 3 | lichess_wikipedia  | Public Domain / CC BY-SA 3.0           | ✅           | commons.wikimedia.org `Chess_<pc><col>t45.svg` (SCID Cburnett set)                       | Colin M.L. Burnett (SCID set, distributed via Wikimedia Commons)             |
| 4 | lichess_alpha      | Free for personal/non-commercial use   | ⚠️ no        | github.com/lichess-org/lila/public/piece/alpha                                           | Eric Bentzen                                                                 |
| 5 | lichess_staunty    | CC BY-SA 4.0                           | ✅           | github.com/lichess-org/lila/public/piece/staunty                                         | Sadsnake                                                                     |
| 6 | lichess_pirouetti  | GPL                                    | ✅           | github.com/lichess-org/lila/public/piece/pirouetti                                       | Sergey Makagonov                                                             |
| 7 | kingside_default   | MIT (wrapper) / GPL-3.0 + CC BY-SA 3.0 (pieces, derived from cburnett) | ✅           | github.com/Clariity/react-chessboard `src/pieces.tsx` (Cburnett SVG inlined)             | Colin M.L. Burnett (pieces); react-chessboard MIT (wrapper)                  |

## Redistribution rules

* Styles with `Redistribute = ✅` ship in the public S3 prefix
  `s3://kingside-ml/datasets/board-recog/v1/public/`.
* **`lichess_alpha`** (Eric Bentzen, free for personal/non-commercial only) —
  rendered cells live in the internal-only prefix
  `s3://kingside-ml/datasets/board-recog/v1/internal/`. The trained model
  weights derived from these cells **are** publishable (transformative use:
  the weights do not reproduce the original glyphs).
* Always serve the model weights together with this LICENSES.md (GPL / CC
  BY-SA attribution requirement).

## Deferred styles (v2 follow-up, not in v1)

These were in the chess-expert apruv but are postponed until source material
is curated. Listed here for traceability:

* **chess_merida** (TrueType, Armando H. Marroquín, freeware) —
  enpassant.dk currently returns HTTP 403 for the font ZIP. Needs an
  alternative mirror or a direct file drop.
* **maizelis** (scans from I.L. Maizelis textbook, 1956–1980) — sprite
  extraction from the local `src/templates/maizelis_*.jpg` scans pending.
  Educational fair-use scope: rendered cells stay internal, weights
  publishable.
* **dvoretsky** (diagrams from Dvoretsky's "Школа будущих чемпионов") —
  sprite extraction from local `src/templates/dvoretsky/*.png` pending.
  Same fair-use scope as maizelis.

## Re-fetch procedure

`scripts/fetch_styles.sh` is idempotent. It pins the lila master commit on
first run (writes to `styles_cache/.lila_commit`) and reuses cached SVGs
afterwards. Delete `styles_cache/` and re-run to rebuild from scratch.

## License files of the upstream projects

Full upstream LICENSE files are not duplicated here to avoid drift; refer to
the URLs in the table above. The GPL / CC BY-SA notices propagate
automatically through `manifest_v1.json` (`license` field per style).
