"""KS-4997: диагностика сигнала похожести на атакующих позициях.
Сравнение трёх сигналов из ОДНОЙ сети t1-256x10 (без перестройки индекса):
  base — /encoder9/ln2, усреднение по клеткам, 256 (текущий).
  A    — голова политики /output/policy (softmax 1858), косинус (слепок плана).
  B    — /encoder9/ln2 64x256, похожесть с сохранением места:
         токены L2-нормируются по каждой клетке, sim = средний по 64 клеткам косинус.
Метрика (задана ДО прогона): доля топ-5 соседей, делящих план-признак
label=(крыло своего короля, крыло чужого короля) — сторона рокировок/атаки.
"""
import sys, os, re, numpy as np
sys.path.insert(0, "/tmp/ks4989-libs"); sys.path.insert(0, "/tmp/ks4989"); sys.path.insert(0, "/tmp/ks4989-proto")
import chess, lc0onnx as O, pg8000.native as pg

SUBSET = int(sys.argv[1]) if len(sys.argv) > 1 else 18000
DB = os.environ.get("ARCHIVE_DATABASE_URL", "postgresql://kingside:kingside@localhost:5432/kingside_archive")
m = re.match(r"postgresql://([^:]+):([^@]+)@([^:/]+):(\d+)/(.+)", DB); U,PW,H,PORT,DBN = m.groups()

def wing(sq): return 'Q' if chess.square_file(sq) <= 3 else 'K'
def plan_label(fen):
    b = chess.Board(fen); me = b.turn
    mk = b.king(me); ok = b.king(not me)
    return wing(mk) + wing(ok)   # напр. 'KQ' = свой король K-крыло, чужой Q-крыло
def npieces(fen): return sum(c.isalpha() for c in fen.split(" ")[0])

# ---- corpus subset ----
con = pg.Connection(user=U, password=PW, host=H, port=int(PORT), database=DBN)
rows = con.run("SELECT position_key, fen, game_ref FROM position_embedding WHERE source='master' ORDER BY id LIMIT :n", n=SUBSET)
con.close()
keys = [bytes(r[0]) for r in rows]; fens = [r[1] for r in rows]; refs = [r[2] or "" for r in rows]
print(f"subset: {len(fens)} positions", flush=True)

sess = O.make_session("/tmp/t1-256x10.onnx", ["/encoder9/ln2", "/output/policy"])
def compute(fen_list):
    base=[]; A=[]; Btok=[]
    for i in range(0, len(fen_list), 256):
        bs = [chess.Board(f) for f in fen_list[i:i+256]]
        r = O.run(sess, bs, ["/encoder9/ln2", "/output/policy"])
        tok = r["/encoder9/ln2"]                      # [b,64,256]
        base.append(tok.mean(axis=1))                 # gap-256
        pol = r["/output/policy"].astype(np.float64)
        pol = np.exp(pol - pol.max(1, keepdims=True)); pol /= pol.sum(1, keepdims=True)
        A.append(pol.astype(np.float32))              # softmax policy 1858
        Btok.append((tok / (np.linalg.norm(tok, axis=2, keepdims=True) + 1e-9)).astype(np.float32))
        if (i//256) % 20 == 0: print(f"  computed {i+len(bs)}/{len(fen_list)}", flush=True)
    return np.concatenate(base), np.concatenate(A), np.concatenate(Btok)

base, A, Btok = compute(fens)
labels = [plan_label(f) for f in fens]   # список строк ('KQ' и т.п.), точное сравнение
def norm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
baseN = norm(base); AN = norm(A.reshape(len(A), -1))

def nn_base(qv, k=6):  return np.argsort(-(baseN @ (qv/ (np.linalg.norm(qv)+1e-9))))[:k]
def nn_A(qv, k=6):     return np.argsort(-(AN @ (qv/(np.linalg.norm(qv)+1e-9))))[:k]
def nn_B(qtok, k=6):
    qn = qtok / (np.linalg.norm(qtok, axis=1, keepdims=True) + 1e-9)   # [64,256]
    sims = np.tensordot(Btok, qn, axes=([1,2],[0,1])) / 64.0           # [N]
    return np.argsort(-sims)[:k]

def embed_query(fen):
    r = O.run(sess, [chess.Board(fen)], ["/encoder9/ln2", "/output/policy"])
    tok = r["/encoder9/ln2"][0]; base_q = tok.mean(0)
    pol = r["/output/policy"][0].astype(np.float64); pol = np.exp(pol-pol.max()); pol/=pol.sum()
    tokn = tok / (np.linalg.norm(tok, axis=1, keepdims=True) + 1e-9)
    return base_q, pol.astype(np.float32), tokn

USER = "2r3k1/pp1q1ppb/4p2p/3pP3/3Q1PPP/2N5/PPP5/2KR3R b - - 2 20"
# queries: user + opposite-castled middlegame positions from subset
opp = [i for i in range(len(fens)) if labels[i][0] != labels[i][1] and npieces(fens[i]) >= 20]
rng = np.random.default_rng(11); qidx = list(rng.choice(opp, size=min(18, len(opp)), replace=False))
queries = [("USER", USER)] + [(f"corpus#{i}", fens[i]) for i in qidx]

agg = {"base": [], "A": [], "B": []}
for tag, fen in queries:
    ql = plan_label(fen); qkey = None
    bq, aq, tq = embed_query(fen)
    res = {"base": nn_base(bq), "A": nn_A(aq.reshape(-1)), "B": nn_B(tq)}
    for sig, idxs in res.items():
        nb = [j for j in idxs if fens[j] != fen][:5]
        frac = np.mean([labels[j] == ql for j in nb])
        agg[sig].append(frac)
    if tag == "USER":
        print(f"\n=== USER {fen}  план={ql} ===")
        for sig in ("base","A","B"):
            nb = [j for j in res[sig] if fens[j] != fen][:5]
            print(f"  [{sig}] plan-agree {np.mean([labels[j]==ql for j in nb]):.2f}")
            for j in nb: print(f"     {labels[j]} {fens[j][:44]}  [{refs[j][:40]}]")

print(f"\n=== СРЕДНЕЕ по {len(queries)} атакующим запросам (доля топ-5 с тем же план-признаком) ===")
for sig in ("base","A","B"):
    print(f"  {sig}: {np.mean(agg[sig]):.3f}")
