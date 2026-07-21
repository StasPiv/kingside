"""KS-4989 PoC (ADR-168): FEN -> vector from a hidden layer of an Lc0-family net.

Net: Maia-1500 (.pb.gz) = Lc0 classic SE-ResNet (6 blocks x 64 filters),
INPUT_CLASSICAL_112_PLANE, POLICY_CLASSICAL. Forward reimplemented in numpy from
lc0 sources (encoder.cc, network_legacy.cc BN-fold, network_blas.cc trunk, se_unit.cc).

Perspective normalization ("to move", ADR main trap): board mirrored to side-to-move
via python-chess board.mirror() when black to move. HistoryFill=fen_only: current
position repeated into all 8 history frames (unless startpos). Metric: cosine.
"""
import sys, gzip, math
import numpy as np
sys.path.insert(0, "/tmp/ks4989-proto")
import net_pb2
import chess

EPS = 1e-5

def _dequant(layer):
    b = layer.params
    q = np.frombuffer(b, dtype="<u2").astype(np.float32)
    mn = layer.min_val; rng = layer.max_val - layer.min_val
    return q / 65535.0 * rng + mn

class ConvBlock:
    def __init__(self, blk):
        self.W = _dequant(blk.weights)        # [Cout*Cin*9]
        biases = _dequant(blk.biases) if len(blk.biases.params) else None
        gammas = _dequant(blk.bn_gammas) if len(blk.bn_gammas.params) else None
        betas  = _dequant(blk.bn_betas) if len(blk.bn_betas.params) else None
        means  = _dequant(blk.bn_means) if len(blk.bn_means.params) else None
        stddiv = _dequant(blk.bn_stddivs) if len(blk.bn_stddivs.params) else None
        outs = means.shape[0] if means is not None else (biases.shape[0] if biases is not None else None)
        if biases is None: biases = np.zeros(outs, np.float32)
        if betas is None and means is not None:
            betas = np.zeros(outs, np.float32); gammas = np.ones(outs, np.float32)
        if means is not None:  # fold BN (network_legacy.cc)
            gammas = gammas * (1.0 / np.sqrt(stddiv + EPS))
            means = means - biases
            inp = self.W.shape[0] // outs
            Wm = self.W.reshape(outs, inp)
            Wm = Wm * gammas[:, None]
            self.W = Wm.reshape(-1)
            biases = -gammas * means + betas
        self.b = biases
        self.outs = outs

class SEunit:
    def __init__(self, se):
        self.w1 = _dequant(se.w1); self.b1 = _dequant(se.b1)
        self.w2 = _dequant(se.w2); self.b2 = _dequant(se.b2)

class Residual:
    def __init__(self, r):
        self.conv1 = ConvBlock(r.conv1)
        self.conv2 = ConvBlock(r.conv2)
        self.se = SEunit(r.se) if r.HasField("se") else None

class Lc0Net:
    def __init__(self, path):
        n = net_pb2.Net(); n.ParseFromString(gzip.open(path, "rb").read())
        w = n.weights
        self.input = ConvBlock(w.input)
        self.C = self.input.outs
        self.residual = [Residual(r) for r in w.residual]
        f = n.format.network_format
        # default activation: MISH if DEFAULT_ACTIVATION_MISH else RELU (network_blas.cc)
        self.act = "mish" if f.default_activation == 1 and f.network >= 100 else "relu"
        # maia/classic: RELU. keep relu unless explicitly mish nets (attn). Force relu for classic.
        if len(self.residual) > 0:
            self.act = "relu"
        self.n_blocks = len(self.residual)

def _act(x, kind):
    if kind == "relu": return np.maximum(x, 0.0)
    if kind == "mish": return x * np.tanh(np.log1p(np.exp(x)))
    return x

# ---------- input encoding (encoder.cc, INPUT_CLASSICAL_112_PLANE) ----------
KPLANES = 13; KHIST = 8; KAUX = 104

def _bb_to_plane(bb):
    """python-chess bitboard (bit i = square i, a1=0) -> flat[64], index i = square i."""
    a = np.zeros(64, np.float32)
    while bb:
        i = (bb & -bb).bit_length() - 1
        a[i] = 1.0; bb &= bb - 1
    return a

def encode(board_in):
    """board_in: python-chess Board. Returns [112,64] float32 (index = square, a1=0)."""
    black_to_move = (board_in.turn == chess.BLACK)
    b = board_in.mirror() if black_to_move else board_in  # perspective -> side to move
    planes = np.zeros((KAUX + 8, 64), np.float32)
    startpos = (b.fen().split(" ")[0] == chess.STARTING_BOARD_FEN.split(" ")[0])
    # piece planes: us = WHITE on b, them = BLACK on b
    us = chess.WHITE
    order = [chess.PAWN, chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN, chess.KING]
    frame = np.zeros((KPLANES, 64), np.float32)
    for k, pt in enumerate(order):
        frame[k] = _bb_to_plane(int(b.pieces(pt, us)))
        frame[6 + k] = _bb_to_plane(int(b.pieces(pt, not us)))
    # repetitions plane (12) = 0 for bare FEN
    nframes = 0 if startpos else KHIST  # FEN_ONLY: repeat unless startpos
    if startpos:
        # for startpos only the current frame is filled (history stops), i=0
        planes[0:KPLANES] = frame; nframes = 1
    else:
        for i in range(KHIST):
            planes[i * KPLANES:(i + 1) * KPLANES] = frame
    # aux planes (104..111)
    cr = b.castling_rights
    if cr & chess.BB_A1: planes[KAUX + 0] = 1.0   # we_can_000 (queenside, white=us)
    if cr & chess.BB_H1: planes[KAUX + 1] = 1.0   # we_can_00
    if cr & chess.BB_A8: planes[KAUX + 2] = 1.0   # they_can_000
    if cr & chess.BB_H8: planes[KAUX + 3] = 1.0   # they_can_00
    if black_to_move: planes[KAUX + 4] = 1.0      # side-to-move plane
    planes[KAUX + 5] = float(board_in.halfmove_clock)  # rule50 raw
    # KAUX+6 zeros ; KAUX+7 all ones
    planes[KAUX + 7] = 1.0
    return planes  # [112,64]

# ---------- forward ----------
def _conv3(x, W, b, outs, act):
    """x [B,Cin,8,8] ; W flat [outs*Cin*9] layout [o,c,kh,kw] ; returns [B,outs,8,8]."""
    B, Cin, H, Wd = x.shape
    xp = np.zeros((B, Cin, H + 2, Wd + 2), np.float32)
    xp[:, :, 1:-1, 1:-1] = x
    # im2col: cols [B, Cin, 3,3, H, W] -> [B*H*W, Cin*9]
    cols = np.empty((B, Cin, 3, 3, H, Wd), np.float32)
    for kh in range(3):
        for kw in range(3):
            cols[:, :, kh, kw] = xp[:, :, kh:kh + H, kw:kw + Wd]
    cols = cols.transpose(0, 4, 5, 1, 2, 3).reshape(B * H * Wd, Cin * 9)
    Wm = W.reshape(outs, Cin * 9)
    out = cols @ Wm.T + b[None, :]
    out = out.reshape(B, H, Wd, outs).transpose(0, 3, 1, 2)
    return _act(out, act) if act else out

def forward_trunk(net, planes_batch, upto_block):
    """planes_batch [B,112,64] -> trunk activation after block `upto_block` (1-based), [B,C,8,8]."""
    B = planes_batch.shape[0]
    x = planes_batch.reshape(B, 112, 8, 8)
    x = _conv3(x, net.input.W, net.input.b, net.C, net.act)
    for bi in range(upto_block):
        r = net.residual[bi]
        h = _conv3(x, r.conv1.W, r.conv1.b, net.C, net.act)
        c2 = _conv3(h, r.conv2.W, r.conv2.b, net.C, None)  # no act, bias added in SE path
        if r.se is not None:
            cb = r.conv2.b  # ch_bias
            # global avg pool + ch_bias  (se_unit.cc global_avg_pooling)
            pool = c2.reshape(B, net.C, 64).mean(axis=2) + cb[None, :]
            n_se = r.se.b1.shape[0]
            w1 = r.se.w1.reshape(n_se, net.C)
            fc1 = _act(pool @ w1.T + r.se.b1[None, :], net.act)
            w2 = r.se.w2.reshape(2 * net.C, n_se)
            fc2 = fc1 @ w2.T + r.se.b2[None, :]        # [B, 2C]
            gamma = 1.0 / (1.0 + np.exp(-fc2[:, :net.C]))
            beta = fc2[:, net.C:] + gamma * cb[None, :]
            out = gamma[:, :, None] * c2.reshape(B, net.C, 64) + beta[:, :, None]
            out = out.reshape(B, net.C, 8, 8) + x  # + residual (block input)
            x = _act(out, net.act)
        else:
            x = _act(c2 + r.conv2.b[None, :, None, None] + x, net.act)
    return x

def vec(net, boards, upto_block, pool="flat"):
    """list of boards -> [N, D] trunk vectors. pool: 'flat' (C*64) or 'gap' (C)."""
    P = np.stack([encode(b) for b in boards]).astype(np.float32)
    out = []
    BS = 256
    for i in range(0, len(boards), BS):
        t = forward_trunk(net, P[i:i + BS], upto_block)
        out.append(_pool(t, pool))
    return np.concatenate(out, axis=0)

def _pool(t, pool):
    B = t.shape[0]
    if pool == "gap":
        return t.reshape(B, t.shape[1], -1).mean(axis=2)
    return t.reshape(B, -1)

def forward_all(net, planes_batch, blocks):
    """Run trunk once, capture activations after each block in `blocks` -> dict[block]=[B,C,8,8]."""
    B = planes_batch.shape[0]
    x = planes_batch.reshape(B, 112, 8, 8)
    x = _conv3(x, net.input.W, net.input.b, net.C, net.act)
    caps = {}
    for bi in range(max(blocks)):
        r = net.residual[bi]
        h = _conv3(x, r.conv1.W, r.conv1.b, net.C, net.act)
        c2 = _conv3(h, r.conv2.W, r.conv2.b, net.C, None)
        cb = r.conv2.b
        pool = c2.reshape(B, net.C, 64).mean(axis=2) + cb[None, :]
        n_se = r.se.b1.shape[0]
        w1 = r.se.w1.reshape(n_se, net.C)
        fc1 = _act(pool @ w1.T + r.se.b1[None, :], net.act)
        w2 = r.se.w2.reshape(2 * net.C, n_se)
        fc2 = fc1 @ w2.T + r.se.b2[None, :]
        gamma = 1.0 / (1.0 + np.exp(-fc2[:, :net.C]))
        beta = fc2[:, net.C:] + gamma * cb[None, :]
        out = gamma[:, :, None] * c2.reshape(B, net.C, 64) + beta[:, :, None]
        x = _act(out.reshape(B, net.C, 8, 8) + x, net.act)
        if (bi + 1) in blocks:
            caps[bi + 1] = x.copy()
    return caps

def embed_all(net, boards, blocks):
    """-> dict[(block,pool)] = [N,D] for pool in flat,gap."""
    P = np.stack([encode(b) for b in boards]).astype(np.float32)
    res = {}
    BS = 256
    for i in range(0, len(boards), BS):
        caps = forward_all(net, P[i:i + BS], blocks)
        for blk, t in caps.items():
            for pl in ("flat", "gap"):
                res.setdefault((blk, pl), []).append(_pool(t, pl))
    return {k: np.concatenate(v, 0) for k, v in res.items()}

if __name__ == "__main__":
    net = Lc0Net("/tmp/maia-1500.pb.gz")
    print("blocks", net.n_blocks, "C", net.C, "act", net.act)
    b = chess.Board()
    v = vec(net, [b], net.n_blocks)
    print("startpos vec shape", v.shape, "norm", float(np.linalg.norm(v)))
