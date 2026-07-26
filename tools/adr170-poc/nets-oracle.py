"""ADR-170 рев.8 — тёплый сервис двух сетей Lc0 через ONNX (без поиска).

Читает построчно FEN из stdin, на каждый отвечает одной строкой JSON:
  {"maia": [["<uci>", p], ...], "maia_wdl": [w,d,l],
   "oracle_best": "<uci>", "oracle_wdl": [w,d,l]}

- Maia-1 (maia-1500.onnx) — человеческая policy (голова политики, ELO 1500).
- Leela T1 (t1-256x10.onnx) — «оракул»: argmax головы политики + WDL.

Обе сети — классический вход 112 плоскостей lc0 (энкодер lc0poc, KS-4989);
при ходе чёрных доска зеркалится на сторону хода, ходы возвращаются обратно.
Декод политики 1858 — карта kAttnPolicyMap (стандартный порядок ходов lc0,
общий для onnx-экспорта обеих сетей). Одно кодирование на позицию, два прогона.

Запуск: PYTHONPATH=/tmp/ks4989-libs python3 nets-oracle.py
"""
import sys, re, json
import numpy as np

sys.path.insert(0, "/tmp/ks4989-libs")
sys.path.insert(0, "/tmp/ks4989")
import onnxruntime as ort  # noqa: E402
import chess  # noqa: E402
import lc0poc as M  # noqa: E402

MAIA = "/tmp/maia-1500.onnx"
ORACLE = "/project/.agent-tmp/t1-256x10.onnx"
AMAP_H = "/tmp/lc0/src/neural/tables/attention_policy_map.h"

_body = open(AMAP_H).read().split("kAttnPolicyMap[] = {")[1].split("};")[0]
AMAP = [int(x) for x in re.findall(r"-?\d+", _body)]

_so = ort.SessionOptions()
_so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
_maia = ort.InferenceSession(MAIA, sess_options=_so, providers=["CPUExecutionProvider"])
_oracle = ort.InferenceSession(ORACLE, sess_options=_so, providers=["CPUExecutionProvider"])


def _mirror_sq(sq: int) -> int:
    return sq ^ 56


def _softmax_over_legal(board, black, pol):
    rows = []
    for mv in board.legal_moves:
        f, t = mv.from_square, mv.to_square
        if black:
            f, t = _mirror_sq(f), _mirror_sq(t)
        flat = f * 64 + t
        if flat >= len(AMAP):
            continue
        idx = AMAP[flat]
        if idx < 0 or idx >= len(pol):
            continue  # промоушены в наших позициях не встречаются
        rows.append((mv.uci(), float(pol[idx])))
    if not rows:
        return []
    logits = np.array([r[1] for r in rows], dtype=np.float64)
    p = np.exp(logits - logits.max())
    p /= p.sum()
    order = np.argsort(-p)
    return [[rows[i][0], round(float(p[i]), 6)] for i in order]


def _wdl(logits):
    w = np.exp(logits - logits.max())
    w /= w.sum()
    return [round(float(w[0]), 6), round(float(w[1]), 6), round(float(w[2]), 6)]


def analyse(fen: str):
    b = chess.Board(fen)
    black = b.turn == chess.BLACK
    enc = b.mirror() if black else b
    x = M.encode(enc).astype(np.float32).reshape(1, 112, 8, 8)
    mp, mw = _maia.run(["/output/policy", "/output/wdl"], {"/input/planes": x})
    op, ow = _oracle.run(["/output/policy", "/output/wdl"], {"/input/planes": x})
    maia = _softmax_over_legal(b, black, mp[0])
    oracle = _softmax_over_legal(b, black, op[0])
    return {
        "maia": maia,
        "maia_wdl": _wdl(mw[0]) if len(mw) else None,
        "oracle": oracle,
        "oracle_best": oracle[0][0] if oracle else None,
        "oracle_wdl": _wdl(ow[0]) if len(ow) else None,
    }


def main():
    sys.stderr.write("nets-oracle: готов\n")
    sys.stderr.flush()
    for line in sys.stdin:
        fen = line.strip()
        if not fen:
            continue
        if fen == "quit":
            break
        try:
            out = analyse(fen)
        except Exception as e:  # noqa: BLE001
            out = {"error": str(e)}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
