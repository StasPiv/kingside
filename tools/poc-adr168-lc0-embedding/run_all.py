"""KS-4989 / ADR-168 PoC — full run: validate forward, then Tests 1-3 with baselines.
Usage: NET=/path/net.pb.gz python3 run_all.py "5,7,10" [npos]
"""
import os, sys, gzip, numpy as np
sys.path.insert(0, "/tmp/ks4989-libs"); sys.path.insert(0, "/tmp/ks4989"); sys.path.insert(0, "/tmp/ks4989-proto")
import lc0poc as M, chess, chess.engine, net_pb2, data as D, vectors as V
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split

NET = os.environ.get("NET", "/tmp/maia-1500.pb.gz")
BLOCKS = [int(x) for x in (sys.argv[1] if len(sys.argv) > 1 else "5,7,10").split(",")]
NPOS = int(sys.argv[2]) if len(sys.argv) > 2 else 250
POOLS = ["flat", "gap"]; VAR = [(b, p) for b in BLOCKS for p in POOLS]
DEPTH = 10
net = M.Lc0Net(NET)
print(f"NET={NET}  blocks_total={net.n_blocks}  C={net.C}  act={net.act}  sweep={BLOCKS}")
gids, fens = V.load_fens(); gids = np.array(gids)
labels = np.array([D.structural_label(f) for f in fens])
passed = np.array([1 if (D._has_passed(chess.Board(f), chess.WHITE) or
                         D._has_passed(chess.Board(f), chess.BLACK)) else 0 for f in fens])
def norm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)

# ---------------- forward validation ----------------
W = net_pb2.Net(); W.ParseFromString(gzip.open(NET, "rb").read()); w = W.weights
vconv = M.ConvBlock(w.value); vcf = vconv.outs
ip1_w = M._dequant(w.ip1_val_w); hid = M._dequant(w.ip1_val_b).shape[0]
ip1_w = ip1_w.reshape(hid, vcf * 64); ip1_b = M._dequant(w.ip1_val_b)
ip2_w = M._dequant(w.ip2_val_w).reshape(3, hid); ip2_b = M._dequant(w.ip2_val_b)
def value_eval(boards):
    P = np.stack([M.encode(b) for b in boards]).astype(np.float32)
    t = M.forward_trunk(net, P, net.n_blocks); B = t.shape[0]
    vc = np.einsum("oc,bcs->bos", vconv.W.reshape(vcf, net.C), t.reshape(B, net.C, 64)) + vconv.b[:, None]
    vc = np.maximum(vc, 0.0).reshape(B, vcf * 64)
    h = np.maximum(vc @ ip1_w.T + ip1_b, 0.0); lg = h @ ip2_w.T + ip2_b
    e = np.exp(lg - lg.max(1, keepdims=True)); sm = e / e.sum(1, keepdims=True)
    return sm[:, 0] - sm[:, 2]
# perspective
pmax = 0.0
for f in fens[:40]:
    b = chess.Board(f); pmax = max(pmax, float(np.linalg.norm(M.vec(net,[b],net.n_blocks)[0]-M.vec(net,[b.mirror()],net.n_blocks)[0]))/ (np.linalg.norm(M.vec(net,[b],net.n_blocks)[0])+1e-9))
# value corr on realistic positions
vb = [chess.Board(f) for f in fens[:60]]
evs = value_eval(vb)
eng = chess.engine.SimpleEngine.popen_uci("/usr/games/stockfish"); eng.configure({"Threads": 4})
sf = [eng.analyse(b, chess.engine.Limit(depth=12))["score"].pov(b.turn).score(mate_score=10000) for b in vb]
rval = float(np.corrcoef(evs, np.tanh(np.array(sf)/300.0))[0, 1])
print(f"[VALIDATE] perspective side-to-move-only diff<=~ {pmax:.3f} ; value corr vs SF = {rval:.3f} (>0.85 => forward correct)")

# ---------------- embeddings ----------------
boards = [chess.Board(f) for f in fens]
emb = M.embed_all(net, boards, BLOCKS)

# ---------------- TEST 1: neighbors ----------------
print("=== TEST 1: Neighbors (same-game excluded), top-10 structural-label agreement ===")
p = np.bincount(labels, minlength=6) / len(fens); base1 = float((p*p).sum())
rng = np.random.default_rng(1); q = rng.choice(len(fens), 1500, replace=False)
for v in VAR:
    Vn = norm(emb[v].astype(np.float32)); S = Vn @ Vn.T
    ag = []
    for i in q:
        s = S[i].copy(); s[gids == gids[i]] = -2
        nn = np.argpartition(-s, 10)[:10]; ag.append(np.mean(labels[nn] == labels[i]))
    m = float(np.mean(ag)); print(f"  b{v[0]}-{v[1]:4s}: {m:.3f}  base {base1:.3f}  lift x{m/base1:.2f}")

# ---------------- TEST 3a: probe passed ----------------
print("=== TEST 3a: probe 'passed pawn present' ===")
for v in VAR:
    X = norm(emb[v]); Xtr,Xte,ytr,yte = train_test_split(X, passed, test_size=.3, random_state=1, stratify=passed)
    a = LogisticRegression(max_iter=300).fit(Xtr,ytr).score(Xte,yte); bs = max(yte.mean(),1-yte.mean())
    print(f"  b{v[0]}-{v[1]:4s}: acc {a:.3f}  base {bs:.3f}")

# ---------------- TEST 2 + 3b: stockfish ----------------
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
    e2 = M.embed_all(net, bs, BLOCKS)
    for v in VAR:
        E = e2[v]; c = lambda j: 1.0 - float(E[0]@E[j]/((np.linalg.norm(E[0])*np.linalg.norm(E[j]))+1e-9))
        acc[v]["q"].append(c(1)); acc[v]["b"].append(c(2)); acc[v]["r"].append(c(3)); probe[v].append(E[0])
    e0s.append(e0); used += 1
eng.quit()
print(f"=== TEST 2 (CRITICAL): character-not-moves, n={used} ===")
print("  variant     quietMed blundMed  randMed  b/q_ratio  frac(b>q)")
for v in VAR:
    Q=np.array(acc[v]["q"]);Bl=np.array(acc[v]["b"]);R=np.array(acc[v]["r"])
    print(f"  b{v[0]}-{v[1]:4s}   {np.median(Q):.4f}  {np.median(Bl):.4f}  {np.median(R):.4f}   x{np.median(Bl)/np.median(Q):.2f}    {np.mean(Bl>Q):.3f}")
print(f"=== TEST 3b: probe 'who is better' (SF sign, |e0|>50) ===")
e=np.array(e0s); mk=np.abs(e)>50; y=(e[mk]>0).astype(int)
for v in VAR:
    X=norm(np.array(probe[v])[mk]); Xtr,Xte,ytr,yte=train_test_split(X,y,test_size=.3,random_state=1,stratify=y)
    a=LogisticRegression(max_iter=400).fit(Xtr,ytr).score(Xte,yte); bs=max(yte.mean(),1-yte.mean())
    print(f"  b{v[0]}-{v[1]:4s}: acc {a:.3f}  base {bs:.3f}  n={len(y)}")
