"""KS-4994: проверка «глазами» — топ-5 ближайших по косинусу из position_embedding.
Запрос кодируется ТЕМ ЖЕ путём (перспектива к ходу + fen_only), что и индекс (§2.5).
Запуск: PYTHONPATH=... python3 query_similar.py "<FEN>"
"""
import sys, os, re, numpy as np
sys.path.insert(0, "/tmp/ks4989-libs"); sys.path.insert(0, "/tmp/ks4989"); sys.path.insert(0, "/tmp/ks4989-proto")
import chess, lc0onnx as O, pg8000.native as pg

LAYER = "/encoder9/ln2"; DB = os.environ.get("ARCHIVE_DATABASE_URL", "postgresql://kingside:kingside@localhost:5432/kingside_archive")
sess = O.make_session("/tmp/t1-256x10.onnx", [LAYER])
m = re.match(r"postgresql://([^:]+):([^@]+)@([^:/]+):(\d+)/(.+)", DB); u,pw,h,port,db = m.groups()
con = pg.Connection(user=u, password=pw, host=h, port=int(port), database=db)
con.run("SET hnsw.ef_search = 100")

def qvec(fen):
    v = O.pool(O.run(sess, [chess.Board(fen)], [LAYER])[LAYER], "gap")[0]
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"

queries = sys.argv[1:] or [
    "r1bq1rk1/pp2bppp/2n1pn2/2pp4/2PP4/1PN1PN2/P2B1PPP/R2QKB1R w KQ - 0 8",   # IQP-структура
    "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 6", # итальянка
    "8/5pk1/6p1/7p/7P/6P1/5PK1/8 w - - 0 40",                                  # пешечный эндшпиль
    "r3r1k1/pp3ppp/2p2n2/3p4/3P4/2P2N2/PP3PPP/R3R1K1 w - - 0 15",             # ладейный, симметрия
]
for fen in queries:
    q = qvec(fen)
    rows = con.run("SELECT fen, game_ref, round((embedding <=> :q)::numeric,4) d "
                   "FROM position_embedding WHERE source='master' ORDER BY embedding <=> :q LIMIT 5", q=q)
    print(f"\nЗАПРОС: {fen}")
    for fen2, ref, d in rows:
        print(f"  d={d}  {fen2}   [{(ref or '')[:60]}]")
con.close()
