"""KS-4994 (ADR-169): офлайн-конвейер эмбеддинга корпуса → position_embedding.

Корпус: подмножество сильных PGN (pgnmentor, топ-игроки), НЕ прод-архив.
Вектор: t1-256x10 ONNX, слой /encoder9/ln2, усреднение по клеткам → vector(256).
Инвариант §2.5: перспектива «к ходу» + HistoryFill=fen_only — из M.encode
(lc0poc), идентичны запросу. position_key = sha256(FEN поля 1-4) — идентичность
позиции без счётчиков ходов.

Запуск:
  PYTHONPATH=/tmp/ks4989-libs:/tmp/ks4989-proto python3 build_index.py \
      /tmp/ks4989/corpus  /tmp/t1-256x10.onnx  120000
"""
import sys, io, os, zipfile, hashlib, random
import numpy as np
sys.path.insert(0, "/tmp/ks4989-libs"); sys.path.insert(0, "/tmp/ks4989"); sys.path.insert(0, "/tmp/ks4989-proto")
import chess, chess.pgn
import lc0onnx as O

LAYER = "/encoder9/ln2"; POOL = "gap"; SOURCE = "master"
DB = os.environ.get("ARCHIVE_DATABASE_URL", "postgresql://kingside:kingside@localhost:5432/kingside_archive")

def pos_key(board):
    parts = board.fen().split(" ")           # placement active castling ep
    return hashlib.sha256(" ".join(parts[:4]).encode()).digest()

def extract(corpus_dir, target, ply_min=14, ply_max=100, stride=8, seed=7):
    rng = random.Random(seed); rows = []; seen = set()
    zips = sorted(f for f in os.listdir(corpus_dir) if f.endswith(".zip"))
    for zf in zips:
        z = zipfile.ZipFile(os.path.join(corpus_dir, zf))
        name = [n for n in z.namelist() if n.endswith(".pgn")][0]
        text = z.read(name).decode("latin-1"); pgn = io.StringIO(text)
        player = zf[:-4]
        while len(rows) < target:
            game = chess.pgn.read_game(pgn)
            if game is None: break
            h = game.headers
            ref = f"{h.get('White','?')}-{h.get('Black','?')} {h.get('Event','')} {h.get('Date','')}".strip()[:180]
            board = game.board(); ply = 0; off = rng.randint(0, stride - 1)
            for mv in game.mainline_moves():
                board.push(mv); ply += 1
                if ply < ply_min or ply > ply_max or (ply - off) % stride != 0: continue
                if board.is_game_over(): continue
                k = pos_key(board)
                if k in seen: continue
                seen.add(k)
                rows.append((k, board.fen(), ref, ply, "w" if board.turn == chess.WHITE else "b"))
                if len(rows) >= target: break
        if len(rows) >= target: break
    return rows

def embed(sess, fens, bs=256):
    out = []
    for i in range(0, len(fens), bs):
        boards = [chess.Board(f) for f in fens[i:i+bs]]
        raw = O.run(sess, boards, [LAYER])[LAYER]
        out.append(O.pool(raw, POOL).astype(np.float32))
        if (i // bs) % 20 == 0: print(f"  embedded {i+len(boards)}/{len(fens)}", flush=True)
    return np.concatenate(out, 0)

def vec_str(v): return "[" + ",".join(f"{x:.6f}" for x in v) + "]"

def main():
    corpus = sys.argv[1] if len(sys.argv) > 1 else "/tmp/ks4989/corpus"
    onnx = sys.argv[2] if len(sys.argv) > 2 else "/tmp/t1-256x10.onnx"
    target = int(sys.argv[3]) if len(sys.argv) > 3 else 120000
    print(f"extracting up to {target} positions from {corpus} ...", flush=True)
    rows = extract(corpus, target)
    print(f"extracted {len(rows)} unique positions", flush=True)
    sess = O.make_session(onnx, [LAYER])
    V = embed(sess, [r[1] for r in rows])
    print(f"embedded {V.shape}; writing to DB ...", flush=True)
    import pg8000.native as pg
    m = __import__("re").match(r"postgresql://([^:]+):([^@]+)@([^:/]+):(\d+)/(.+)", DB)
    u, pw, host, port, dbname = m.groups()
    con = pg.Connection(user=u, password=pw, host=host, port=int(port), database=dbname)
    con.run("DELETE FROM position_embedding WHERE source = :s", s=SOURCE)
    B = 500
    for i in range(0, len(rows), B):
        chunk = rows[i:i+B]; vs = V[i:i+B]
        # build multi-row insert
        vals = []
        for (k, fen, ref, ply, stm), v in zip(chunk, vs):
            vals.append((k, fen, SOURCE, ref, ply, stm, vec_str(v)))
        ph = ",".join(f"(gen_random_uuid(),:k{j},:f{j},:s{j},:g{j},:p{j},:m{j},:v{j})" for j in range(len(vals)))
        params = {}
        for j, t in enumerate(vals):
            params[f"k{j}"], params[f"f{j}"], params[f"s{j}"], params[f"g{j}"], params[f"p{j}"], params[f"m{j}"], params[f"v{j}"] = t
        con.run(f"INSERT INTO position_embedding(id,position_key,fen,source,game_ref,ply,side_to_move,embedding) VALUES {ph}", **params)
        if (i // B) % 20 == 0: print(f"  wrote {i+len(chunk)}/{len(rows)}", flush=True)
    n = con.run("SELECT count(*) FROM position_embedding WHERE source=:s", s=SOURCE)[0][0]
    print(f"DONE. position_embedding rows (source={SOURCE}): {n}", flush=True)
    con.close()

if __name__ == "__main__":
    main()
