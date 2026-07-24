"""KS-5003: проверка «глазами» — топ-5 ближайших по multilayer-вектору (embedding_ml)
рядом с базой (embedding = слой-9 gap). Те же контрольные FEN, что query_similar.py.

Запрос кодируется тем же путём (перспектива к ходу + fen_only, §2.5): вектор строится
идентично build_multilayer.py (среднее 10 L2-нормированных gap слоёв).

Запуск:
  PYTHONPATH=/tmp/ks4989-libs:/tmp/ks4989:/tmp/ks4989-proto \
      python3 query_multilayer.py ["<FEN>" ...]
"""
import sys, os, re
import numpy as np
sys.path.insert(0, "/tmp/ks4989-libs"); sys.path.insert(0, "/tmp/ks4989"); sys.path.insert(0, "/tmp/ks4989-proto")
import chess, lc0onnx as O
import pg8000.native as pg

LAYERS = [f"/encoder{i}/ln2" for i in range(10)]
DB = os.environ.get("ARCHIVE_DATABASE_URL", "postgresql://kingside:kingside@localhost:5432/kingside_archive")
sess = O.make_session("/tmp/t1-256x10.onnx", LAYERS)

def norm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)

def ml_query(fen):
    raw = O.run(sess, [chess.Board(fen)], LAYERS)
    gaps = [raw[l].mean(axis=1).astype(np.float32) for l in LAYERS]   # 10 × [1,256]
    v = np.mean([norm(g) for g in gaps], axis=0)[0]
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"

def base_query(fen):
    v = O.pool(O.run(sess, [chess.Board(fen)], ["/encoder9/ln2"])["/encoder9/ln2"], "gap")[0]
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"

m = re.match(r"postgresql://([^:]+):([^@]+)@([^:/]+):(\d+)/(.+)", DB); u, pw, h, port, db = m.groups()
con = pg.Connection(user=u, password=pw, host=h, port=int(port), database=db)
con.run("SET hnsw.ef_search = 100")

queries = sys.argv[1:] or [
    "r1bq1rk1/pp2bppp/2n1pn2/2pp4/2PP4/1PN1PN2/P2B1PPP/R2QKB1R w KQ - 0 8",   # IQP-структура
    "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 6", # итальянка
    "8/5pk1/6p1/7p/7P/6P1/5PK1/8 w - - 0 40",                                  # пешечный эндшпиль
    "r3r1k1/pp3ppp/2p2n2/3p4/3P4/2P2N2/PP3PPP/R3R1K1 w - - 0 15",             # ладейный, симметрия
]
for fen in queries:
    print(f"\nЗАПРОС: {fen}")
    for tag, col, q in (("ml ", "embedding_ml", ml_query(fen)), ("gap", "embedding", base_query(fen))):
        rows = con.run(f"SELECT fen, game_ref, round((({col}) <=> :q)::numeric,4) d "
                       f"FROM position_embedding WHERE source='master' AND {col} IS NOT NULL "
                       f"ORDER BY {col} <=> :q LIMIT 5", q=q)
        print(f" [{tag}]")
        for fen2, ref, d in rows:
            print(f"    d={d}  {fen2[:44]}   [{(ref or '')[:50]}]")
con.close()
