"""KS-4990: 3 ADR-168 tests on transformer Lc0 net via ONNX. Same data/thresholds as KS-4989."""
import sys, numpy as np
sys.path.insert(0, "/tmp/ks4989-libs"); sys.path.insert(0, "/tmp/ks4989"); sys.path.insert(0, "/tmp/ks4989-proto")
import chess, chess.engine, data as D, vectors as V, lc0onnx as O
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split

ONNX = sys.argv[1] if len(sys.argv) > 1 else "/tmp/t1-256x10.onnx"
LAYERS = ["/encoder5/ln2", "/encoder7/ln2", "/encoder9/ln2"]
NPOS = int(sys.argv[2]) if len(sys.argv) > 2 else 250
POOLS = ["flat", "gap"]; VAR = [(l, p) for l in LAYERS for p in POOLS]
DEPTH = 10
sess = O.make_session(ONNX, LAYERS)
gids, fens = V.load_fens(); gids = np.array(gids)
labels = np.array([D.structural_label(f) for f in fens])
passed = np.array([1 if (D._has_passed(chess.Board(f), chess.WHITE) or
                         D._has_passed(chess.Board(f), chess.BLACK)) else 0 for f in fens])
def norm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)
def lname(l): return l.split("/")[1]

boards = [chess.Board(f) for f in fens]
raw = O.run(sess, boards, LAYERS)
emb = {(l, p): O.pool(raw[l], p).astype(np.float32) for l in LAYERS for p in POOLS}
print(f"ONNX={ONNX}  layers={[lname(l) for l in LAYERS]}  npos_t2={NPOS}")

# TEST 1
p = np.bincount(labels, minlength=6) / len(fens); base1 = float((p*p).sum())
rng = np.random.default_rng(1); q = rng.choice(len(fens), 1500, replace=False)
print(f"=== TEST 1 Neighbors (same-game excluded), base {base1:.3f} ===")
for v in VAR:
    Vn = norm(emb[v]); S = Vn @ Vn.T; ag = []
    for i in q:
        s = S[i].copy(); s[gids == gids[i]] = -2; nn = np.argpartition(-s, 10)[:10]
        ag.append(np.mean(labels[nn] == labels[i]))
    m = float(np.mean(ag)); print(f"  {lname(v[0])}-{v[1]:4s}: {m:.3f}  lift x{m/base1:.2f}")

# TEST 3a
print("=== TEST 3a probe 'passed pawn' ===")
for v in VAR:
    X = norm(emb[v]); Xtr,Xte,ytr,yte = train_test_split(X, passed, test_size=.3, random_state=1, stratify=passed)
    a = LogisticRegression(max_iter=300).fit(Xtr,ytr).score(Xte,yte)
    print(f"  {lname(v[0])}-{v[1]:4s}: acc {a:.3f}  base {max(yte.mean(),1-yte.mean()):.3f}")

# TEST 2 + 3b (stockfish); same sampling as run_all.py (seed-3 permutation)
rng = np.random.default_rng(3)
eng = chess.engine.SimpleEngine.popen_uci("/usr/games/stockfish"); eng.configure({"Threads": 4})
acc = {v: {"q": [], "b": [], "r": []} for v in VAR}; probe = {v: [] for v in VAR}; e0s = []; used = 0
for idx in rng.permutation(len(fens)):
    if used >= NPOS: break
    b = chess.Board(fens[idx]); legal = list(b.legal_moves)
    if len(legal) < 6: continue
    info = eng.analyse(b, chess.engine.Limit(depth=DEPTH), multipv=len(legal))
    me = {pv["pv"][0]: pv["score"].pov(b.turn).score(mate_score=10000) for pv in info}
    if len(me) < len(legal): continue
    best = max(me, key=me.get); e0 = me[best]; worst = min(me, key=me.get)
    if e0 - me[worst] < 300: continue
    rmv = legal[rng.integers(len(legal))]; bs = [b]
    for mv in (best, worst, rmv): b.push(mv); bs.append(b.copy()); b.pop()
    r2 = O.run(sess, bs, LAYERS)
    for v in VAR:
        E = O.pool(r2[v[0]], v[1])
        c = lambda j: 1.0 - float(E[0]@E[j]/((np.linalg.norm(E[0])*np.linalg.norm(E[j]))+1e-9))
        acc[v]["q"].append(c(1)); acc[v]["b"].append(c(2)); acc[v]["r"].append(c(3)); probe[v].append(E[0])
    e0s.append(e0); used += 1
eng.quit()
print(f"=== TEST 2 (CRITICAL) character-not-moves, n={used} ===")
print("  layer-pool   quietMed blundMed  randMed  b/q  frac(b>q)")
for v in VAR:
    Q=np.array(acc[v]["q"]);Bl=np.array(acc[v]["b"]);R=np.array(acc[v]["r"])
    print(f"  {lname(v[0])}-{v[1]:4s}  {np.median(Q):.4f}  {np.median(Bl):.4f}  {np.median(R):.4f}  x{np.median(Bl)/np.median(Q):.2f}  {np.mean(Bl>Q):.3f}")
print("=== TEST 3b probe 'who is better' (SF sign |e0|>50) ===")
e=np.array(e0s); mk=np.abs(e)>50; y=(e[mk]>0).astype(int)
for v in VAR:
    X=norm(np.array(probe[v])[mk]); Xtr,Xte,ytr,yte=train_test_split(X,y,test_size=.3,random_state=1,stratify=y)
    a=LogisticRegression(max_iter=400).fit(Xtr,ytr).score(Xte,yte)
    print(f"  {lname(v[0])}-{v[1]:4s}: acc {a:.3f}  base {max(yte.mean(),1-yte.mean()):.3f}  n={len(y)}")
