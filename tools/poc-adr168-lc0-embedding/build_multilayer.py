"""KS-5003 (PoC ADR-168/169): заполнить position_embedding.embedding_ml вектором
= среднее gap по ВСЕМ 10 слоям encoder (каждый слой L2-нормирован перед смешиванием).

НЕ затирает колонку embedding (слой-9 gap, база сравнения) — пишет в embedding_ml.
Корпус тот же: position_embedding source='master' ORDER BY id (200k).

Инвариант §2.5: перспектива «к ходу» + fen_only — M.encode, идентично запросу.

Флаг --raw: усреднять БЕЗ нормировки слоёв — пишет в СВОЮ колонку embedding_ml_raw
(embedding_ml=ml_norm не затирается). Без флага → embedding_ml (ml_norm).
После заполнения строит hnsw cosine индекс на целевой колонке.

Запуск:
  PYTHONPATH=/tmp/ks4989-libs:/tmp/ks4989:/tmp/ks4989-proto \
      python3 build_multilayer.py [N=200000] [--raw]
"""
import sys, os, re, time
import numpy as np
sys.path.insert(0, "/tmp/ks4989-libs"); sys.path.insert(0, "/tmp/ks4989"); sys.path.insert(0, "/tmp/ks4989-proto")
import chess, lc0onnx as O
import onnx, onnxruntime as ort
import pg8000.native as pg

LAYERS = [f"/encoder{i}/ln2" for i in range(10)]
THREADS = int(os.environ.get("ORT_THREADS", "16"))

def make_session_fast(onnx_path, extra_outputs):
    """Как O.make_session, но intra_op=THREADS (helper жёстко на 4) для CPU-параллелизма."""
    mo = onnx.load(onnx_path); have = {o.name for o in mo.graph.output}
    for name in extra_outputs:
        if name not in have:
            mo.graph.output.append(onnx.helper.make_empty_tensor_value_info(name))
    tmp = onnx_path + ".mlfast.onnx"; onnx.save(mo, tmp)
    so = ort.SessionOptions(); so.intra_op_num_threads = THREADS
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(tmp, so, providers=["CPUExecutionProvider"])
RAW = "--raw" in sys.argv
argN = [a for a in sys.argv[1:] if not a.startswith("--")]
N = int(argN[0]) if argN else 200000
DB = os.environ.get("ARCHIVE_DATABASE_URL", "postgresql://kingside:kingside@localhost:5432/kingside_archive")
COL = "embedding_ml_raw" if RAW else "embedding_ml"   # raw → своя колонка, ml_norm не затирается
IDX = f"position_embedding_{COL}_cosine_idx"

def norm(X): return X / (np.linalg.norm(X, axis=1, keepdims=True) + 1e-9)

def ml_vec(raw):
    gaps = [raw[l].mean(axis=1).astype(np.float32) for l in LAYERS]   # 10 × [b,256]
    if RAW:
        return np.mean(gaps, axis=0).astype(np.float32)
    return np.mean([norm(g) for g in gaps], axis=0).astype(np.float32)

m = re.match(r"postgresql://([^:]+):([^@]+)@([^:/]+):(\d+)/(.+)", DB); u, pw, h, port, db = m.groups()
con = pg.Connection(user=u, password=pw, host=h, port=int(port), database=db)
con.run(f"ALTER TABLE position_embedding ADD COLUMN IF NOT EXISTS {COL} vector(256)")
# докачка: только строки без вектора в целевой колонке (идемпотентно, можно продолжать)
rows = con.run(f"SELECT id, fen FROM position_embedding WHERE source='master' AND {COL} IS NULL "
               "ORDER BY id LIMIT :n", n=N)
ids = [str(r[0]) for r in rows]; fens = [r[1] for r in rows]; N = len(fens)
print(f"to fill: {N} positions  col={COL}  mode={'raw' if RAW else 'l2norm'}  threads={THREADS}", flush=True)

sess = make_session_fast("/tmp/t1-256x10.onnx", LAYERS)
def vstr(v): return "[" + ",".join(f"{x:.6f}" for x in v) + "]"

t0 = time.time(); BS = 256
for i in range(0, N, BS):
    chunk_ids = ids[i:i+BS]; boards = [chess.Board(f) for f in fens[i:i+BS]]
    V = ml_vec(O.run(sess, boards, LAYERS))
    # многострочный UPDATE через VALUES-join
    ph = ",".join(f"(:i{j}::uuid,:v{j}::vector)" for j in range(len(chunk_ids)))
    params = {}
    for j, (pid, v) in enumerate(zip(chunk_ids, V)):
        params[f"i{j}"] = pid; params[f"v{j}"] = vstr(v)
    con.run(f"UPDATE position_embedding p SET {COL} = d.v FROM (VALUES {ph}) AS d(id,v) WHERE p.id = d.id", **params)
    if (i // BS) % 20 == 0:
        print(f"  {i+len(boards)}/{N}  {time.time()-t0:.0f}s", flush=True)

print(f"building hnsw cosine index on {COL} ...", flush=True)
con.run(f"DROP INDEX IF EXISTS {IDX}")
con.run(f"CREATE INDEX {IDX} ON position_embedding USING hnsw ({COL} vector_cosine_ops)")
n = con.run(f"SELECT count(*) FROM position_embedding WHERE {COL} IS NOT NULL")[0][0]
print(f"DONE. {COL} filled: {n}  {time.time()-t0:.0f}s", flush=True)
con.close()
