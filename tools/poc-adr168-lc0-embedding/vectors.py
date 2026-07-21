import sys, numpy as np
sys.path.insert(0, "/tmp/ks4989-libs"); sys.path.insert(0, "/tmp/ks4989")
import lc0poc as M, chess

def load_fens(path="/tmp/ks4989/fens.txt"):
    gids, fens = [], []
    for line in open(path):
        line = line.rstrip("\n")
        if not line: continue
        g, f = line.split("\t", 1); gids.append(int(g)); fens.append(f)
    return gids, fens

def compute(net, fens, block):
    boards = [chess.Board(f) for f in fens]
    return M.vec(net, boards, block).astype(np.float32)

if __name__ == "__main__":
    net = M.Lc0Net("/tmp/maia-1500.pb.gz")
    gids, fens = load_fens()
    for blk in (2, 4, 6):
        V = compute(net, fens, blk)
        np.save(f"/tmp/ks4989/vec_b{blk}.npy", V)
        print("block", blk, "shape", V.shape)
    np.save("/tmp/ks4989/gids.npy", np.array(gids))
