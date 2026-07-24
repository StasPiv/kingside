"""KS-5003 (PoC ADR-168 §4): вектор = среднее gap по ВСЕМ 10 слоям encoder.

Сравнение вариантов вектора позиции на общем протоколе KS-4990 (run_onnx.py),
тот же корпус (data.py / vectors.py fens.txt) и те же пороги:
  base9    — gap /encoder9/ln2 (текущий индекс, база сравнения).
  ml_norm  — среднее 10 слоёв gap, каждый L2-нормирован перед смешиванием.
  ml_raw   — среднее 10 слоёв gap БЕЗ нормировки (опциональный контроль).

Инвариант §2.5: перспектива «к ходу» + fen_only — из M.encode, идентично запросу.

Тесты (ADR-168 §4):
  T1 Соседи   — доля топ-10 с той же структурной меткой vs случайная база (lift).
  T2 КРИТИЧНЫЙ — расстояние после зевка (переворот оценки) >> после тихого хода.
  T3 Проба    — линейный классификатор читает «проходная» / «кто лучше».

Запуск:
  PYTHONPATH=/tmp/ks4989-libs:/tmp/ks4989:/tmp/ks4989-proto \
      python3 metrics_multilayer.py [NPOS_T2=250]
"""
import sys, numpy as np
sys.path.insert(0, "/tmp/ks4989-libs"); sys.path.insert(0, "/tmp/ks4989"); sys.path.insert(0, "/tmp/ks4989-proto")
import chess, chess.engine, data as D, vectors as V, lc0onnx as O
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split

ONNX = "/tmp/t1-256x10.onnx"
LAYERS = [f"/encoder{i}/ln2" for i in range(10)]
NPOS = int(sys.argv[1]) if len(sys.argv) > 1 else 250
DEPTH = 10
VARIANTS = ["base9", "ml_norm", "ml_raw"]

def norm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)

def build_variants(raw):
    """raw: dict layer -> [N,64,256]. Возвращает dict variant -> [N,256]."""
    gaps = [raw[l].mean(axis=1).astype(np.float32) for l in LAYERS]  # 10 × [N,256]
    ml_norm = np.mean([norm(g) for g in gaps], axis=0).astype(np.float32)
    ml_raw = np.mean(gaps, axis=0).astype(np.float32)
    return {"base9": gaps[9], "ml_norm": ml_norm, "ml_raw": ml_raw}

sess = O.make_session(ONNX, LAYERS)
gids, fens = V.load_fens(); gids = np.array(gids)
labels = np.array([D.structural_label(f) for f in fens])
passed = np.array([1 if (D._has_passed(chess.Board(f), chess.WHITE) or
                         D._has_passed(chess.Board(f), chess.BLACK)) else 0 for f in fens])
boards = [chess.Board(f) for f in fens]
raw = O.run(sess, boards, LAYERS)
emb = build_variants(raw)
print(f"corpus={len(fens)}  variants={VARIANTS}  npos_t2={NPOS}", flush=True)

# ---- TEST 1: Соседи ----
p = np.bincount(labels, minlength=6) / len(fens); base1 = float((p*p).sum())
rng = np.random.default_rng(1); q = rng.choice(len(fens), 1500, replace=False)
print(f"=== T1 Соседи (same-game excluded), случайная база {base1:.3f} ===")
for v in VARIANTS:
    Vn = norm(emb[v]); S = Vn @ Vn.T; ag = []
    for i in q:
        s = S[i].copy(); s[gids == gids[i]] = -2; nn = np.argpartition(-s, 10)[:10]
        ag.append(np.mean(labels[nn] == labels[i]))
    m = float(np.mean(ag)); print(f"  {v:8s}: {m:.3f}  lift x{m/base1:.2f}")

# ---- TEST 3a: проба «проходная» ----
print("=== T3a проба 'проходная пешка' ===")
for v in VARIANTS:
    X = norm(emb[v]); Xtr,Xte,ytr,yte = train_test_split(X, passed, test_size=.3, random_state=1, stratify=passed)
    a = LogisticRegression(max_iter=300).fit(Xtr,ytr).score(Xte,yte)
    print(f"  {v:8s}: acc {a:.3f}  base {max(yte.mean(),1-yte.mean()):.3f}")

# ---- TEST 2 (КРИТИЧНЫЙ) + 3b: stockfish ----
rng = np.random.default_rng(3)
eng = chess.engine.SimpleEngine.popen_uci("/usr/games/stockfish"); eng.configure({"Threads": 4})
acc = {v: {"q": [], "b": [], "r": []} for v in VARIANTS}; probe = {v: [] for v in VARIANTS}; e0s = []; used = 0
for idx in rng.permutation(len(fens)):
    if used >= NPOS: break
    b = chess.Board(fens[idx]); legal = list(b.legal_moves)
    if len(legal) < 6: continue
    info = eng.analyse(b, chess.engine.Limit(depth=DEPTH), multipv=len(legal))
    me = {pv["pv"][0]: pv["score"].pov(b.turn).score(mate_score=10000) for pv in info}
    if len(me) < len(legal): continue
    best = max(me, key=me.get); e0 = me[best]; worst = min(me, key=me.get)
    if e0 - me[worst] < 300: continue                     # зевок = переворот на >=300cp
    rmv = legal[rng.integers(len(legal))]; bs = [b]
    for mv in (best, worst, rmv): b.push(mv); bs.append(b.copy()); b.pop()
    r2 = O.run(sess, bs, LAYERS); ev = build_variants(r2)
    for v in VARIANTS:
        E = ev[v]
        c = lambda j: 1.0 - float(E[0]@E[j]/((np.linalg.norm(E[0])*np.linalg.norm(E[j]))+1e-9))
        acc[v]["q"].append(c(1)); acc[v]["b"].append(c(2)); acc[v]["r"].append(c(3)); probe[v].append(E[0])
    e0s.append(e0); used += 1
eng.quit()
print(f"=== T2 (КРИТИЧНЫЙ) характер-не-ходы, n={used} ===")
print("  variant    quietMed blundMed  randMed   b/q  frac(b>q)")
for v in VARIANTS:
    Q=np.array(acc[v]["q"]);Bl=np.array(acc[v]["b"]);R=np.array(acc[v]["r"])
    print(f"  {v:8s}  {np.median(Q):.4f}  {np.median(Bl):.4f}  {np.median(R):.4f}  x{np.median(Bl)/np.median(Q):.2f}  {np.mean(Bl>Q):.3f}")
print("=== T3b проба 'кто лучше' (|e0|>50) ===")
e=np.array(e0s); mk=np.abs(e)>50; y=(e[mk]>0).astype(int)
for v in VARIANTS:
    X=norm(np.array(probe[v])[mk]); Xtr,Xte,ytr,yte=train_test_split(X,y,test_size=.3,random_state=1,stratify=y)
    a=LogisticRegression(max_iter=400).fit(Xtr,ytr).score(Xte,yte)
    print(f"  {v:8s}: acc {a:.3f}  base {max(yte.mean(),1-yte.mean()):.3f}  n={len(y)}")
