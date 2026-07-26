"""ADR-170 рев.8 — тёплый оракул Leela T1 через ONNX (без поиска).

Читает построчно FEN из stdin, на каждый отвечает одной строкой JSON:
  {"best": "<uci>", "wdl": [w,d,l], "policy": [["<uci>", p], ...]}
где wdl — с точки зрения side-to-move (softmax /output/wdl), policy —
голова политики сети (softmax по легальным ходам, argmax = best).

Сеть: t1-256x10.onnx (Leela T1 256x10). Вход — 112 плоскостей lc0-classical
из валидированного энкодера lc0poc (KS-4989): при ходе чёрных доска зеркалится
на сторону хода, ходы возвращаются в исходную ориентацию. Декод политики —
карта kAttnPolicyMap из исходников lc0.

Запуск: PYTHONPATH=/tmp/ks4989-libs python3 leela-oracle.py
"""
import sys, re, json
import numpy as np

sys.path.insert(0, "/tmp/ks4989-libs")
sys.path.insert(0, "/tmp/ks4989")
import onnxruntime as ort  # noqa: E402
import chess  # noqa: E402
import lc0poc as M  # noqa: E402

ONNX = "/project/.agent-tmp/t1-256x10.onnx"
AMAP_H = "/tmp/lc0/src/neural/tables/attention_policy_map.h"

# Карта (from*64+to [+ промоушены]) -> индекс политики 1858 (или -1).
_body = open(AMAP_H).read().split("kAttnPolicyMap[] = {")[1].split("};")[0]
AMAP = [int(x) for x in re.findall(r"-?\d+", _body)]

# Промоушен-слоты attention policy: хвост карты после 64*64 = 8*24, порядок
# lc0 — по (файл, направление, фигура). Для наших позиций промоушенов нет,
# поэтому промо-ходы отбрасываем (best всё равно из основной части).
_sess = ort.InferenceSession(ONNX, providers=["CPUExecutionProvider"])


def _mirror_sq(sq: int) -> int:
    # вертикальное зеркало (как board.mirror() в python-chess): ранг 8-r.
    return sq ^ 56


def analyse(fen: str):
    b = chess.Board(fen)
    black = b.turn == chess.BLACK
    enc_board = b.mirror() if black else b  # перспектива стороны хода
    x = M.encode(enc_board).astype(np.float32).reshape(1, 112, 8, 8)
    pol, wdl = _sess.run(["/output/policy", "/output/wdl"], {"/input/planes": x})
    pol, wdl = pol[0], wdl[0]

    rows = []  # (uci_в_исходной_ориентации, logit)
    for mv in b.legal_moves:
        f, t = mv.from_square, mv.to_square
        if black:  # индексируем в зеркальной (сети) ориентации
            f, t = _mirror_sq(f), _mirror_sq(t)
        flat = f * 64 + t
        if flat >= len(AMAP):
            continue
        idx = AMAP[flat]
        if idx < 0 or idx >= len(pol):
            continue  # промоушен-ход — пропускаем (в наших позициях не встречается)
        rows.append((mv.uci(), float(pol[idx])))

    if not rows:
        return {"best": None, "wdl": None, "policy": []}
    logits = np.array([r[1] for r in rows], dtype=np.float64)
    p = np.exp(logits - logits.max())
    p /= p.sum()
    order = np.argsort(-p)
    policy = [[rows[i][0], round(float(p[i]), 6)] for i in order]
    w = np.exp(wdl - wdl.max())
    w /= w.sum()
    return {
        "best": policy[0][0],
        "wdl": [round(float(w[0]), 6), round(float(w[1]), 6), round(float(w[2]), 6)],
        "policy": policy,
    }


def main():
    sys.stderr.write("leela-oracle: готов\n")
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
