"""KS-4998: кэш учителя — выходы Lc0 (policy softmax 1858 + WDL 3) и внутренние
активации (encoder6, encoder9; поклеточно 64x256 -> flatten 16384) на подкорпусе.
"""
import sys, os, numpy as np
sys.path.insert(0, "/tmp/ks4989-libs"); sys.path.insert(0, "/tmp/ks4989"); sys.path.insert(0, "/tmp/ks4989-proto")
import chess, lc0onnx as O, pg8000.native as pg

N = int(sys.argv[1]) if len(sys.argv) > 1 else 30000
LAYERS = ["/encoder6/ln2", "/encoder9/ln2"]
OUTS = LAYERS + ["/output/policy", "/output/wdl"]
con = pg.Connection(user="kingside", password="kingside", host="localhost", port=5432, database="kingside_archive")
rows = con.run("SELECT fen FROM position_embedding WHERE source='master' ORDER BY id LIMIT :n", n=N)
con.close()
fens = [r[0] for r in rows]
print(f"teacher corpus: {len(fens)}", flush=True)
sess = O.make_session("/tmp/t1-256x10.onnx", LAYERS)  # policy/wdl already graph outputs

pol = np.empty((len(fens), 1858), np.float32)
wdl = np.empty((len(fens), 3), np.float32)
act = {L: np.empty((len(fens), 64*256), np.float16) for L in LAYERS}
B = 256
for i in range(0, len(fens), B):
    bs = [chess.Board(f) for f in fens[i:i+B]]
    r = O.run(sess, bs, OUTS)
    p = r["/output/policy"].astype(np.float64)
    p = np.exp(p - p.max(1, keepdims=True)); p /= p.sum(1, keepdims=True)
    pol[i:i+len(bs)] = p.astype(np.float32)
    w = r["/output/wdl"].astype(np.float64)
    w = np.exp(w - w.max(1, keepdims=True)); w /= w.sum(1, keepdims=True)
    wdl[i:i+len(bs)] = w.astype(np.float32)
    for L in LAYERS:
        act[L][i:i+len(bs)] = r[L].reshape(len(bs), -1).astype(np.float16)
    if (i//B) % 20 == 0: print(f"  {i+len(bs)}/{len(fens)}", flush=True)

np.save("/tmp/ks4989/t_pol.npy", pol)
np.save("/tmp/ks4989/t_wdl.npy", wdl)
for L in LAYERS: np.save(f"/tmp/ks4989/t_act_{L.split('/')[1]}.npy", act[L])
with open("/tmp/ks4989/t_fens.txt", "w") as fh: fh.write("\n".join(fens))
print("DONE cache", pol.shape, wdl.shape, {L: act[L].shape for L in LAYERS}, flush=True)
