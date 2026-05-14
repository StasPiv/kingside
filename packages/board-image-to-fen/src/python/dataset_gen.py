#!/usr/bin/env python3
"""
Board-recog dataset v1 generator (KS-2360, ADR-040 Stage 4).

Pipeline:
    1. Load SVG piece sets from styles_cache/<style>/{wK,wQ,...,bP}.svg.
    2. For each style × board-palette combination, pre-render every piece
       on every (light, dark) square at the target cell size and cache the
       resulting RGBA bitmaps.
    3. Pull unique FENs (DB tactic_drills.fen / puzzles.fen + python-chess
       synthetic fallback) — N_FENS_PER_STYLE per style.
    4. For each FEN, render 64 cells directly (no full-board image) and save
       them as PNGs in data/v1/cells/<style>/<bucket>/<fen_idx>_<square>.png.
    5. Emit manifest_v1.json (meta) + splits/{train,val,test}.jsonl (paths).

Output layout (data/v1 is .gitignored — keep manifest_v1.json only):
    data/v1/
        cells/<style>/<fen_idx//1000>/<fen_idx>_<sq>.png
        splits/{train,val,test}.jsonl
        manifest_v1.json
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import random
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import cairosvg
import chess
from PIL import Image, ImageDraw

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parents[2]          # packages/board-image-to-fen
STYLES_DIR = ROOT / "styles_cache"
DATA_DIR = ROOT / "data" / "v1"
CELLS_DIR = DATA_DIR / "cells"
SPLITS_DIR = DATA_DIR / "splits"
MANIFEST_PATH = ROOT / "data" / "manifest_v1.json"

CELL_SIZE = 64                                       # output cell resolution
BOARD_SIZE = CELL_SIZE * 8                           # 512px

# Active styles (KS-2360 chess-expert apruv, less Maizelis/Dvoretsky/Chess-Merida
# which are deferred to v2 pending source material — see ADR-040 follow-up).
STYLES: List[str] = [
    "lichess_cburnett",
    "lichess_merida",
    "lichess_wikipedia",
    "lichess_alpha",
    "lichess_staunty",
    "lichess_pirouetti",
    "kingside_default",
]

# Board palettes (light, dark). Per-style assignment below — gives each style a
# distinct visual identity even when the piece SVG is identical (e.g.
# kingside_default uses cburnett pieces but a different board colour).
PALETTES: Dict[str, Tuple[str, str]] = {
    "lichess_brown":     ("#f0d9b5", "#b58863"),
    "lichess_blue":      ("#dee3e6", "#8ca2ad"),
    "lichess_green":     ("#ffffdd", "#86a666"),
    "chesscom_classic":  ("#eeeed2", "#769656"),
    "chesscom_modern":   ("#ebecd0", "#739552"),
    "kingside_green":    ("#ebecd0", "#739552"),
    "kingside_dark":     ("#dfdfdf", "#4a6741"),
    "wood":              ("#e0c098", "#8b6a45"),
    "monochrome":        ("#ffffff", "#666666"),
    "purple":            ("#e8d5ff", "#7a5bb5"),
}

# Each style gets a primary palette plus one or two random variants. The random
# variants are chosen per-FEN at generation time, so the dataset shows the
# model multiple board colours within a single style.
STYLE_PALETTES: Dict[str, List[str]] = {
    "lichess_cburnett":  ["lichess_brown", "lichess_blue", "lichess_green"],
    "lichess_merida":    ["lichess_brown", "wood"],
    "lichess_wikipedia": ["lichess_brown", "monochrome"],
    "lichess_alpha":     ["lichess_green", "chesscom_classic"],
    "lichess_staunty":   ["chesscom_classic", "chesscom_modern"],
    "lichess_pirouetti": ["chesscom_modern", "purple"],
    "kingside_default":  ["kingside_green", "kingside_dark"],
}

PIECE_KEYS = ["wK", "wQ", "wR", "wB", "wN", "wP",
              "bK", "bQ", "bR", "bB", "bN", "bP"]

# Class labels: 13 (empty + 12 pieces). Stored in manifest.
LABELS: List[str] = ["empty"] + PIECE_KEYS
LABEL_TO_IDX: Dict[str, int] = {l: i for i, l in enumerate(LABELS)}

# Split ratios.
SPLIT_RATIOS = {"train": 0.70, "val": 0.15, "test": 0.15}

# ---------------------------------------------------------------------------
# Piece bitmap cache
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PieceKey:
    style: str
    piece: str        # 'wK'..'bP'
    bg_color: str     # hex


def _render_svg_to_rgba(svg_bytes: bytes, size: int) -> Image.Image:
    """Render an SVG into a square RGBA bitmap at `size` × `size`."""
    png_bytes = cairosvg.svg2png(
        bytestring=svg_bytes,
        output_width=size,
        output_height=size,
    )
    return Image.open(io.BytesIO(png_bytes)).convert("RGBA")


def load_style_pieces(style: str) -> Dict[str, Image.Image]:
    """Read all 12 piece SVGs for `style` and render them to transparent RGBA
    bitmaps at CELL_SIZE."""
    style_dir = STYLES_DIR / style
    if not style_dir.is_dir():
        raise FileNotFoundError(f"Style cache missing: {style_dir}")
    pieces: Dict[str, Image.Image] = {}
    for piece in PIECE_KEYS:
        svg_file = style_dir / f"{piece}.svg"
        if not svg_file.is_file():
            raise FileNotFoundError(f"Missing SVG: {svg_file}")
        pieces[piece] = _render_svg_to_rgba(svg_file.read_bytes(), CELL_SIZE)
    return pieces


def compose_cell(bg_hex: str, piece_img: Optional[Image.Image]) -> Image.Image:
    """Compose a single 64×64 cell: solid background + optional piece overlay."""
    cell = Image.new("RGB", (CELL_SIZE, CELL_SIZE), bg_hex)
    if piece_img is not None:
        cell.paste(piece_img, (0, 0), piece_img)  # alpha mask = piece itself
    return cell


# ---------------------------------------------------------------------------
# FEN sources
# ---------------------------------------------------------------------------

def fetch_db_fens(limit: int) -> List[str]:
    """Pull up to `limit` distinct FENs from Postgres tactic_drills + puzzles."""
    try:
        import psycopg2
    except ImportError:
        return []
    dsn = os.environ.get("DATABASE_URL",
                         "postgresql://kingside:kingside@localhost:5432/kingside")
    try:
        conn = psycopg2.connect(dsn)
    except Exception as exc:
        print(f"[fen] DB connect failed: {exc}", file=sys.stderr)
        return []
    fens: List[str] = []
    with conn, conn.cursor() as cur:
        # tactic_drills is the bulk source (~400k rows).
        cur.execute(
            "SELECT DISTINCT fen FROM tactic_drills WHERE fen IS NOT NULL LIMIT %s;",
            (limit,),
        )
        fens.extend(r[0] for r in cur.fetchall())
        if len(fens) < limit:
            remaining = limit - len(fens)
            cur.execute(
                "SELECT DISTINCT fen FROM puzzles WHERE fen IS NOT NULL LIMIT %s;",
                (remaining,),
            )
            fens.extend(r[0] for r in cur.fetchall())
    conn.close()
    print(f"[fen] DB delivered {len(fens)} FENs", file=sys.stderr)
    return fens


def synthetic_fens(n: int, seed: int = 42) -> List[str]:
    """Generate `n` synthetic FENs by playing random legal moves from the start.

    Distribution: half from random openings (5-15 ply), half from deeper random
    walks (20-60 ply). Guarantees variety in piece configurations.
    """
    rng = random.Random(seed)
    out: List[str] = []
    while len(out) < n:
        board = chess.Board()
        depth = rng.randint(5, 60)
        for _ in range(depth):
            moves = list(board.legal_moves)
            if not moves:
                break
            board.push(rng.choice(moves))
            if board.is_game_over():
                break
        out.append(board.fen())
    return out


def collect_fens(target: int) -> List[str]:
    """Return `target` distinct FENs, preferring DB rows, falling back to synthetic."""
    fens = fetch_db_fens(target)
    seen = set(fens)
    if len(fens) < target:
        for f in synthetic_fens(target - len(fens) + 500):
            if f in seen:
                continue
            seen.add(f)
            fens.append(f)
            if len(fens) >= target:
                break
    return fens[:target]


# ---------------------------------------------------------------------------
# FEN → cells rendering
# ---------------------------------------------------------------------------

def fen_to_grid(fen: str) -> List[List[str]]:
    """Convert FEN to 8×8 grid of piece codes; 'empty' for empty squares.

    Grid[0] is rank 8 (top of the board), Grid[7] is rank 1.
    """
    board_part = fen.split()[0]
    rows = board_part.split("/")
    grid: List[List[str]] = []
    for row in rows:
        cells: List[str] = []
        for ch in row:
            if ch.isdigit():
                cells.extend(["empty"] * int(ch))
            else:
                colour = "w" if ch.isupper() else "b"
                cells.append(f"{colour}{ch.upper()}")
        if len(cells) != 8:
            raise ValueError(f"Bad FEN row: {row!r}")
        grid.append(cells)
    if len(grid) != 8:
        raise ValueError(f"Bad FEN: {fen!r}")
    return grid


def square_color(file_idx: int, rank_idx_from_top: int) -> str:
    """Return 'light' or 'dark' for the given board coordinate.

    a1 is dark; the colour of (file, rank) is light when (file + rank) is even
    counting from a1.
    """
    rank_from_a1 = 7 - rank_idx_from_top
    return "light" if (file_idx + rank_from_a1) % 2 == 1 else "dark"


def render_fen_cells(
    fen: str,
    style_pieces: Dict[str, Image.Image],
    light_hex: str,
    dark_hex: str,
) -> List[Tuple[Image.Image, str]]:
    """Render 64 cells for `fen` using preloaded piece bitmaps.

    Returns a list of (cell_image, label) tuples in row-major order: index 0 is
    rank 8 file a, index 63 is rank 1 file h.
    """
    grid = fen_to_grid(fen)
    out: List[Tuple[Image.Image, str]] = []
    for r, row in enumerate(grid):
        for f, label in enumerate(row):
            bg = light_hex if square_color(f, r) == "light" else dark_hex
            piece_img = style_pieces.get(label) if label != "empty" else None
            out.append((compose_cell(bg, piece_img), label))
    return out


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------

@dataclass
class WorkItem:
    style: str
    fen_idx: int
    fen: str
    palette_name: str
    light: str
    dark: str


def _process_one(item: WorkItem) -> Tuple[str, int, List[Dict[str, object]]]:
    """Render and persist 64 cells for one (style, fen). Returns metadata rows."""
    # Each worker keeps its own per-style piece cache to avoid re-rendering SVGs.
    cache = _process_one._cache  # type: ignore[attr-defined]
    if item.style not in cache:
        cache[item.style] = load_style_pieces(item.style)
    style_pieces = cache[item.style]

    cells = render_fen_cells(item.fen, style_pieces, item.light, item.dark)
    bucket = item.fen_idx // 1000
    out_dir = CELLS_DIR / item.style / f"{bucket:04d}"
    out_dir.mkdir(parents=True, exist_ok=True)
    rows: List[Dict[str, object]] = []
    for sq_idx, (img, label) in enumerate(cells):
        path = out_dir / f"{item.fen_idx:06d}_{sq_idx:02d}.png"
        img.save(path, format="PNG", optimize=False)
        rel = path.relative_to(DATA_DIR).as_posix()
        rows.append({
            "path": rel,
            "label": label,
            "label_idx": LABEL_TO_IDX[label],
            "style": item.style,
            "palette": item.palette_name,
            "fen_idx": item.fen_idx,
            "square": sq_idx,
        })
    return item.style, item.fen_idx, rows


_process_one._cache = {}  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def deterministic_split(rng_seed: bytes, train: float, val: float) -> str:
    """Stable hash-based assignment to train/val/test (no need to store random state)."""
    h = int.from_bytes(hashlib.sha256(rng_seed).digest()[:8], "big") / 2**64
    if h < train:
        return "train"
    if h < train + val:
        return "val"
    return "test"


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fens-per-style", type=int, default=2300,
                    help="Distinct FENs to render per style (default 2300 → ~1.03M cells across 7 styles).")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) - 1))
    ap.add_argument("--seed", type=int, default=2360)
    ap.add_argument("--dry-run", action="store_true",
                    help="Skip rendering, only print plan and FEN counts.")
    args = ap.parse_args(argv)

    rng = random.Random(args.seed)
    CELLS_DIR.mkdir(parents=True, exist_ok=True)
    SPLITS_DIR.mkdir(parents=True, exist_ok=True)

    # 1. FEN pool — fetch enough for all styles, then sample without replacement
    #    per-style to maximise diversity. With 7 styles × 2300 = 16100 FENs,
    #    we need ~17000 distinct FENs in the pool.
    total_needed = args.fens_per_style * len(STYLES) + 500
    fen_pool = collect_fens(total_needed)
    print(f"[plan] FEN pool size: {len(fen_pool)}", file=sys.stderr)
    if len(fen_pool) < total_needed:
        print(f"[warn] only {len(fen_pool)} FENs available, "
              f"requested {total_needed}", file=sys.stderr)
    rng.shuffle(fen_pool)

    # 2. Build work items: each style gets its own slice of the pool plus a
    #    random palette choice.
    work: List[WorkItem] = []
    offset = 0
    for style in STYLES:
        slice_ = fen_pool[offset: offset + args.fens_per_style]
        offset += args.fens_per_style
        palettes = STYLE_PALETTES[style]
        for i, fen in enumerate(slice_):
            palette_name = rng.choice(palettes)
            light, dark = PALETTES[palette_name]
            work.append(WorkItem(
                style=style, fen_idx=i, fen=fen,
                palette_name=palette_name, light=light, dark=dark,
            ))

    print(f"[plan] {len(work)} work items, {len(STYLES)} styles, "
          f"{args.fens_per_style} FENs/style, {args.workers} workers", file=sys.stderr)
    print(f"[plan] expected cells: {len(work) * 64:,}", file=sys.stderr)

    if args.dry_run:
        return 0

    # 3. Process in parallel.
    all_rows: List[Dict[str, object]] = []
    start = time.time()
    done = 0
    if args.workers > 1:
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            futures = [pool.submit(_process_one, w) for w in work]
            for fut in as_completed(futures):
                _, _, rows = fut.result()
                all_rows.extend(rows)
                done += 1
                if done % 200 == 0 or done == len(work):
                    elapsed = time.time() - start
                    rate = done / max(elapsed, 0.01)
                    eta = (len(work) - done) / max(rate, 0.01)
                    print(f"[render] {done}/{len(work)} "
                          f"({rate:.1f} FEN/s, ETA {eta:.0f}s)", file=sys.stderr)
    else:
        # Serial fallback (debugging).
        for w in work:
            _, _, rows = _process_one(w)
            all_rows.extend(rows)
            done += 1

    # 4. Split + write JSONL.
    splits: Dict[str, List[Dict[str, object]]] = {"train": [], "val": [], "test": []}
    for row in all_rows:
        key = f"{row['style']}|{row['fen_idx']}".encode()
        split = deterministic_split(
            key, SPLIT_RATIOS["train"], SPLIT_RATIOS["val"],
        )
        row["split"] = split
        splits[split].append(row)

    for split_name, rows in splits.items():
        path = SPLITS_DIR / f"{split_name}.jsonl"
        with path.open("w") as fh:
            for row in rows:
                fh.write(json.dumps(row, separators=(",", ":")) + "\n")
        print(f"[split] {split_name}: {len(rows):,} rows → {path}", file=sys.stderr)

    # 5. Style label counts (for manifest stats).
    per_style_counts: Dict[str, Dict[str, int]] = {}
    for row in all_rows:
        st = per_style_counts.setdefault(row["style"], {l: 0 for l in LABELS})
        st[row["label"]] += 1

    # 6. Manifest (meta only — splits live in JSONL).
    manifest = {
        "version": "v1",
        "task": "KS-2360",
        "adr": "ADR-040",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "cell_size": CELL_SIZE,
        "labels": LABELS,
        "label_to_idx": LABEL_TO_IDX,
        "n_cells_total": len(all_rows),
        "n_fens_per_style": args.fens_per_style,
        "split_ratios": SPLIT_RATIOS,
        "split_counts": {k: len(v) for k, v in splits.items()},
        "styles": [
            _style_meta(style, per_style_counts.get(style, {}))
            for style in STYLES
        ],
        "deferred_styles": [
            {"name": "chess_merida", "reason": "enpassant.dk TTF source not reachable (HTTP 403)", "follow_up": "v2"},
            {"name": "maizelis",      "reason": "scan source-file sprites pending curation",        "follow_up": "v2"},
            {"name": "dvoretsky",     "reason": "scan source-file sprites pending curation",        "follow_up": "v2"},
        ],
        "s3_prefix": "s3://kingside-ml/datasets/board-recog/v1/",
    }
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    print(f"[manifest] wrote {MANIFEST_PATH}", file=sys.stderr)

    print(f"[done] {len(all_rows):,} cells in {time.time() - start:.1f}s", file=sys.stderr)
    return 0


# ---------------------------------------------------------------------------
# Style metadata (license + provenance)
# ---------------------------------------------------------------------------

_STYLE_META_BASE: Dict[str, Dict[str, object]] = {
    "lichess_cburnett": {
        "license": "GPL-3.0 / CC BY-SA 3.0 (dual)",
        "source_url": "https://github.com/lichess-org/lila/tree/master/public/piece/cburnett",
        "attribution": "Colin M.L. Burnett",
        "redistribute": True,
    },
    "lichess_merida": {
        "license": "GPL-2.0+",
        "source_url": "https://github.com/lichess-org/lila/tree/master/public/piece/merida",
        "attribution": "Armando H. Marroquín",
        "redistribute": True,
    },
    "lichess_wikipedia": {
        "license": "Public Domain / CC BY-SA 3.0",
        "source_url": "https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces",
        "attribution": "Colin M.L. Burnett (SCID set, distributed via Wikimedia Commons)",
        "redistribute": True,
    },
    "lichess_alpha": {
        "license": "Free for personal/non-commercial (Eric Bentzen)",
        "source_url": "https://github.com/lichess-org/lila/tree/master/public/piece/alpha",
        "attribution": "Eric Bentzen",
        "redistribute": False,
        "note": "Trained weights are publishable, raw rendered cells stay in the internal S3 prefix.",
    },
    "lichess_staunty": {
        "license": "CC BY-SA 4.0",
        "source_url": "https://github.com/lichess-org/lila/tree/master/public/piece/staunty",
        "attribution": "Sadsnake",
        "redistribute": True,
        "replaces": "chess.com/classic (excluded by chess-expert: closed IP)",
    },
    "lichess_pirouetti": {
        "license": "GPL",
        "source_url": "https://github.com/lichess-org/lila/tree/master/public/piece/pirouetti",
        "attribution": "Sergey Makagonov",
        "redistribute": True,
        "replaces": "chess.com/modern (excluded by chess-expert: closed IP)",
    },
    "kingside_default": {
        "license": "MIT (react-chessboard); pieces derived from cburnett (GPL-3.0 / CC BY-SA 3.0)",
        "source_url": "https://github.com/Clariity/react-chessboard/blob/main/src/pieces.tsx",
        "attribution": "Colin M.L. Burnett (pieces); react-chessboard MIT (wrapper)",
        "redistribute": True,
        "note": "Visual diversity vs. lichess_cburnett comes from the board palette (kingside_green / kingside_dark).",
    },
}


def _style_meta(style: str, label_counts: Dict[str, int]) -> Dict[str, object]:
    meta = dict(_STYLE_META_BASE[style])
    meta["name"] = style
    meta["palettes"] = STYLE_PALETTES[style]
    meta["label_counts"] = label_counts
    # Record the lila commit pin if we have it.
    commit_file = STYLES_DIR / ".lila_commit"
    if style.startswith("lichess_") and style != "lichess_wikipedia" and commit_file.is_file():
        meta["source_commit"] = commit_file.read_text().strip()
    return meta


if __name__ == "__main__":
    sys.exit(main())
