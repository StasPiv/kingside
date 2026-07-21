"""Extract middlegame/endgame positions (FEN) from a master PGN + structural labels."""
import sys, io, zipfile, random
sys.path.insert(0, "/tmp/ks4989-libs")
import chess, chess.pgn

def load_pgn_text(zip_path):
    z = zipfile.ZipFile(zip_path)
    name = [n for n in z.namelist() if n.endswith(".pgn")][0]
    return z.read(name).decode("latin-1")

def extract_positions(zip_path, max_positions=4000, ply_min=14, ply_max=90, stride=6, seed=7):
    """One position every `stride` plies within [ply_min,ply_max], across games."""
    rng = random.Random(seed)
    text = load_pgn_text(zip_path)
    pgn = io.StringIO(text)
    fens = []; gids = []; seen = set(); gid = -1
    while len(fens) < max_positions:
        game = chess.pgn.read_game(pgn)
        if game is None: break
        gid += 1
        board = game.board()
        ply = 0; off = rng.randint(0, stride - 1)
        for mv in game.mainline_moves():
            board.push(mv); ply += 1
            if ply < ply_min or ply > ply_max: continue
            if (ply - off) % stride != 0: continue
            key = board.board_fen() + (" w" if board.turn else " b")
            if key in seen: continue
            if board.is_game_over(): continue
            seen.add(key); fens.append(board.fen()); gids.append(gid)
            if len(fens) >= max_positions: break
    return fens, gids

# ---------- structural label (deterministic pawn-structure family) ----------
def _pawn_files(board, color):
    files = [0]*8
    for sq in board.pieces(chess.PAWN, color):
        files[chess.square_file(sq)] += 1
    return files

def _has_passed(board, color):
    opp = not color
    opp_pawn_files = set(chess.square_file(s) for s in board.pieces(chess.PAWN, opp))
    for sq in board.pieces(chess.PAWN, color):
        f = chess.square_file(sq); r = chess.square_rank(sq)
        blocked = False
        for df in (-1, 0, 1):
            nf = f + df
            if 0 <= nf <= 7:
                for s2 in board.pieces(chess.PAWN, opp):
                    if chess.square_file(s2) == nf:
                        r2 = chess.square_rank(s2)
                        if (color == chess.WHITE and r2 > r) or (color == chess.BLACK and r2 < r):
                            blocked = True
        if not blocked:
            return True
    return False

def structural_label(fen):
    """One of 6 mutually-exclusive pawn-structure classes (precedence order)."""
    b = chess.Board(fen)
    npawns = len(b.pieces(chess.PAWN, chess.WHITE)) + len(b.pieces(chess.PAWN, chess.BLACK))
    if npawns <= 4:
        return 0  # pawn-sparse endgame
    wf = _pawn_files(b, chess.WHITE); bf = _pawn_files(b, chess.BLACK)
    # IQP: exactly one pawn on d-file with empty c and e files (either side)
    def iqp(f): return f[3] >= 1 and f[2] == 0 and f[4] == 0
    if iqp(wf) or iqp(bf):
        return 1
    # doubled pawns
    if any(c >= 2 for c in wf) or any(c >= 2 for c in bf):
        return 2
    # passed pawn present
    if _has_passed(b, chess.WHITE) or _has_passed(b, chess.BLACK):
        return 3
    # closed center: white pawn and black pawn in blocking contact on d or e file
    closed = False
    for f in (3, 4):
        for wsq in b.pieces(chess.PAWN, chess.WHITE):
            if chess.square_file(wsq) == f:
                for bsq in b.pieces(chess.PAWN, chess.BLACK):
                    if chess.square_file(bsq) == f and chess.square_rank(bsq) - chess.square_rank(wsq) == 1:
                        closed = True
    if closed:
        return 4
    return 5  # other / open

LABELS = {0: "endgame-sparse", 1: "IQP", 2: "doubled", 3: "passed", 4: "closed-center", 5: "open/other"}

if __name__ == "__main__":
    fens, gids = extract_positions("/tmp/ks4989/Carlsen.zip", max_positions=4000)
    import collections
    c = collections.Counter(structural_label(f) for f in fens)
    print("positions:", len(fens), "games:", len(set(gids)))
    for k in sorted(c): print(f"  {k} {LABELS[k]:16s} {c[k]:5d}  {c[k]/len(fens):.3f}")
    with open("/tmp/ks4989/fens.txt", "w") as fh:
        fh.write("\n".join(f"{g}\t{f}" for g, f in zip(gids, fens)))
