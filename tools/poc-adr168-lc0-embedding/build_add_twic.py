"""KS-4996: дозагрузка position_embedding из одиночного PGN (TWIC) до ~200k.
Та же конфигурация ADR-168 §9 (t1-256x10 /encoder9/ln2, усреднение, перспектива
к ходу + fen_only). НЕ удаляет существующие; дедуп по position_key внутри прогона
и против уже лежащих строк. source='master' (единый банк поиска), провенанс — в game_ref.

Запуск: python3 build_add_twic.py /tmp/twic1567.pgn /tmp/t1-256x10.onnx 80000
"""
import sys, os, io, re, hashlib
import numpy as np
sys.path.insert(0, "/tmp/ks4989-libs"); sys.path.insert(0, "/tmp/ks4989"); sys.path.insert(0, "/tmp/ks4989-proto")
import chess, chess.pgn, lc0onnx as O, pg8000.native as pg

LAYER = "/encoder9/ln2"; POOL = "gap"; SOURCE = "master"
DB = os.environ.get("ARCHIVE_DATABASE_URL", "postgresql://kingside:kingside@localhost:5432/kingside_archive")
_m = re.match(r"postgresql://([^:]+):([^@]+)@([^:/]+):(\d+)/(.+)", DB); U,PW,H,PORT,DBN = _m.groups()

def con(): return pg.Connection(user=U, password=PW, host=H, port=int(PORT), database=DBN)
def pos_key(board):
    return hashlib.sha256(" ".join(board.fen().split(" ")[:4]).encode()).digest()
def vec_str(v): return "[" + ",".join(f"{x:.6f}" for x in v) + "]"

def main():
    pgn_path = sys.argv[1]; onnx = sys.argv[2]; add_target = int(sys.argv[3])
    c = con()
    before = c.run("SELECT count(*) FROM position_embedding")[0][0]
    print(f"existing rows: {before}; loading existing position_keys ...", flush=True)
    seen = set(bytes(r[0]) for r in c.run("SELECT position_key FROM position_embedding"))
    print(f"existing unique keys: {len(seen)}", flush=True)

    rows = []
    fh = open(pgn_path, encoding="latin-1"); ngames = 0
    while len(rows) < add_target:
        game = chess.pgn.read_game(fh)
        if game is None: break
        ngames += 1
        h = game.headers
        ref = f"{h.get('White','?')}-{h.get('Black','?')} {h.get('Event','')} {h.get('Date','')}".strip()[:180]
        board = game.board(); ply = 0
        for mv in game.mainline_moves():
            board.push(mv); ply += 1
            if ply < 14 or ply > 90 or ply % 5 != 0: continue
            if board.is_game_over(): continue
            k = pos_key(board)
            if k in seen: continue
            seen.add(k)
            rows.append((k, board.fen(), ref, ply, "w" if board.turn == chess.WHITE else "b"))
            if len(rows) >= add_target: break
    print(f"scanned {ngames} games; new unique positions: {len(rows)}", flush=True)

    sess = O.make_session(onnx, [LAYER])
    B = 256
    written = 0
    for i in range(0, len(rows), B):
        chunk = rows[i:i+B]
        boards = [chess.Board(r[1]) for r in chunk]
        V = O.pool(O.run(sess, boards, [LAYER])[LAYER], POOL).astype(np.float32)
        vals = [(k, fen, SOURCE, ref, ply, stm, vec_str(v)) for (k, fen, ref, ply, stm), v in zip(chunk, V)]
        ph = ",".join(f"(gen_random_uuid(),:k{j},:f{j},:s{j},:g{j},:p{j},:m{j},:v{j})" for j in range(len(vals)))
        params = {}
        for j, t in enumerate(vals):
            params[f"k{j}"],params[f"f{j}"],params[f"s{j}"],params[f"g{j}"],params[f"p{j}"],params[f"m{j}"],params[f"v{j}"] = t
        c.run(f"INSERT INTO position_embedding(id,position_key,fen,source,game_ref,ply,side_to_move,embedding) VALUES {ph}", **params)
        written += len(chunk)
        if (i // B) % 20 == 0: print(f"  wrote {written}/{len(rows)}", flush=True)
    total = c.run("SELECT count(*) FROM position_embedding")[0][0]
    print(f"DONE. added {written}; total position_embedding rows: {total}", flush=True)
    c.close()

if __name__ == "__main__":
    main()
