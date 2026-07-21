"""KS-4995 (ADR-169 §2.4): тестовый маршрут GET /positions/similar?fen=…&k=5.

Внутренний/тестовый (фаза «глазами», без публичного UI). Тонкий: вектор запроса
берёт у сервиса-кодировщика по HTTP (onnxruntime не встроен), затем ищет топ-k
ближайших по косинусу в position_embedding (HNSW).

Запуск: PYTHONPATH=/tmp/ks4989-libs python3 similar_service.py [port]
Проверка: curl 'http://127.0.0.1:8182/positions/similar?fen=<FEN>&k=5'
"""
import sys, os, re, json
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs, unquote, quote
import urllib.request
sys.path.insert(0, "/tmp/ks4989-libs")
import pg8000.native as pg

ENCODER = os.environ.get("ENCODER_URL", "http://127.0.0.1:8181/encode")
DB = os.environ.get("ARCHIVE_DATABASE_URL", "postgresql://kingside:kingside@localhost:5432/kingside_archive")
_m = re.match(r"postgresql://([^:]+):([^@]+)@([^:/]+):(\d+)/(.+)", DB)
_u, _pw, _h, _port, _db = _m.groups()

def _con():
    c = pg.Connection(user=_u, password=_pw, host=_h, port=int(_port), database=_db)
    c.run("SET hnsw.ef_search = 100")
    return c

def query_vec(fen):
    with urllib.request.urlopen(f"{ENCODER}?fen={quote(fen)}", timeout=30) as r:
        return json.loads(r.read())["vector"]

def similar(fen, k):
    vec = query_vec(fen); q = "[" + ",".join(f"{x:.6f}" for x in vec) + "]"
    c = _con()
    try:
        rows = c.run("SELECT fen, game_ref, ply, side_to_move, "
                     "round((embedding <=> :q)::numeric,4) AS cos_dist "
                     "FROM position_embedding WHERE source='master' "
                     "ORDER BY embedding <=> :q LIMIT :k", q=q, k=k)
        return [{"fen": r[0], "game_ref": r[1], "ply": r[2], "side_to_move": r[3],
                 "cos_dist": float(r[4])} for r in rows]
    finally:
        c.close()

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        u = urlparse(self.path)
        if u.path != "/positions/similar":
            self.send_error(404); return
        qs = parse_qs(u.query); fen = unquote(qs.get("fen", [""])[0]); k = int(qs.get("k", ["5"])[0])
        try:
            body = json.dumps({"query_fen": fen, "neighbors": similar(fen, k)}, ensure_ascii=False).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        except Exception as e:
            self.send_error(400, str(e))

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8182
    print(f"similar-service encoder={ENCODER} db={_db} on :{port}", flush=True)
    HTTPServer(("127.0.0.1", port), H).serve_forever()
