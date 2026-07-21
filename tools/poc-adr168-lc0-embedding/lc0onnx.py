"""ONNX-based embedding extraction for transformer Lc0 nets (KS-4990).
Reuses the validated 112-plane encoder from lc0poc. Adds encoder-block outputs
to the ONNX graph and runs via onnxruntime; extracts hidden layer, pools flat/gap.
"""
import sys, numpy as np
sys.path.insert(0, "/tmp/ks4989-libs"); sys.path.insert(0, "/tmp/ks4989")
import onnx, onnxruntime as ort, chess
import lc0poc as M

def make_session(onnx_path, extra_outputs):
    m = onnx.load(onnx_path)
    have = {o.name for o in m.graph.output}
    vi = {v.name: v for v in list(m.graph.value_info)}
    for name in extra_outputs:
        if name in have: continue
        m.graph.output.append(onnx.helper.make_empty_tensor_value_info(name))
    tmp = onnx_path + ".ext.onnx"
    onnx.save(m, tmp)
    so = ort.SessionOptions(); so.intra_op_num_threads = 4
    return ort.InferenceSession(tmp, so, providers=["CPUExecutionProvider"])

def planes_batch(boards):
    P = np.stack([M.encode(b) for b in boards]).astype(np.float32)  # [B,112,64]
    return P.reshape(len(boards), 112, 8, 8)

def run(sess, boards, out_names, bs=128):
    res = {n: [] for n in out_names}
    for i in range(0, len(boards), bs):
        chunk = boards[i:i+bs]; B = len(chunk)
        x = planes_batch(chunk)
        outs = sess.run(out_names, {"/input/planes": x})
        for n, a in zip(out_names, outs):
            # encoder token tensors come back as [B*64, C]; restore [B,64,C]
            if a.ndim == 2 and a.shape[0] == B * 64:
                a = a.reshape(B, 64, a.shape[1])
            res[n].append(a)
    return {n: np.concatenate(v, 0) for n, v in res.items()}

def pool(a, kind):
    # a: [B,64,C] token sequence -> flat [B,64*C] or gap [B,C]
    B = a.shape[0]
    if a.ndim == 4: a = a.reshape(B, a.shape[1], -1)
    if kind == "gap": return a.mean(axis=1)
    return a.reshape(B, -1)

if __name__ == "__main__":
    import chess.engine
    ONNX = "/tmp/t1-256x10.onnx"
    layers = ["/encoder5/ln2", "/encoder7/ln2", "/encoder9/ln2"]
    sess = make_session(ONNX, layers)
    print("inputs", [i.name for i in sess.get_inputs()], "outputs", [o.name for o in sess.get_outputs()][:6])
    # shapes
    r = run(sess, [chess.Board()], ["/output/wdl"] + layers)
    for k, v in r.items(): print(k, v.shape)
    # perspective: white vs mirrored differ only by side-to-move plane propagation
    f = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4"
    b = chess.Board(f)
    e = run(sess, [b, b.mirror()], ["/encoder9/ln2"])["/encoder9/ln2"]
    va, vb = pool(e[:1], "gap")[0], pool(e[1:], "gap")[0]
    print("perspective gap rel-diff:", float(np.linalg.norm(va-vb))/(np.linalg.norm(va)+1e-9))
    # value vs stockfish
    fens = ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            "8/8/8/4k3/8/8/4Q3/4K3 w - - 0 1","4k3/4q3/8/8/4K3/8/8/8 w - - 0 1",
            "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
            "r3k2r/ppp2ppp/2n5/3q4/3P4/2N5/PPP2PPP/R2QK2R w KQkq - 0 1",
            "8/8/8/8/8/5k2/5p2/5K2 w - - 0 1","6k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1",
            "r4rk1/pp3ppp/2p5/3q4/8/2P2N2/P4PPP/3QR1K1 w - - 0 1"]
    bs = [chess.Board(x) for x in fens]
    wdl = run(sess, bs, ["/output/wdl"])["/output/wdl"]
    def softmax(z): e=np.exp(z-z.max(1,keepdims=True)); return e/e.sum(1,keepdims=True)
    sm = softmax(wdl) if wdl.max()>1.01 or wdl.min()<-0.01 else wdl
    ev = sm[:,0]-sm[:,2]
    eng = chess.engine.SimpleEngine.popen_uci("/usr/games/stockfish")
    sf = [eng.analyse(b, chess.engine.Limit(depth=12))["score"].pov(b.turn).score(mate_score=10000) for b in bs]
    eng.quit()
    for f_,e_,s_ in zip(fens,ev,sf): print(f"  net {e_:+.3f}  SF {s_:+6d}  {f_[:26]}")
    print("value corr:", float(np.corrcoef(ev, np.tanh(np.array(sf)/300))[0,1]))
