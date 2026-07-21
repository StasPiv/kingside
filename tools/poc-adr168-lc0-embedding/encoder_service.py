"""KS-4995 (ADR-169 §2.3): лёгкий сервис-кодировщик запроса. FEN → vector(256).

Отдельный процесс — onnxruntime НЕ живёт в основном API. Использует тот же
lc0poc.encode (перспектива «к ходу» + HistoryFill=fen_only) и тот же слой
/encoder9/ln2 + усреднение по клеткам, что и построение индекса (инвариант §2.5).

Запуск:  PYTHONPATH=/tmp/ks4989-libs:/tmp/ks4989-proto python3 encoder_service.py [port]
Проверка: curl 'http://127.0.0.1:8181/encode?fen=<FEN>'
"""
import sys, os, json
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs, unquote
sys.path.insert(0, "/tmp/ks4989-libs"); sys.path.insert(0, "/tmp/ks4989"); sys.path.insert(0, "/tmp/ks4989-proto")
import chess, lc0onnx as O

LAYER = "/encoder9/ln2"; POOL = "gap"
ONNX = os.environ.get("ONNX_NET", "/tmp/t1-256x10.onnx")
_sess = O.make_session(ONNX, [LAYER])

def encode_fen(fen):
    v = O.pool(O.run(_sess, [chess.Board(fen)], [LAYER])[LAYER], POOL)[0]
    return [round(float(x), 6) for x in v]

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        u = urlparse(self.path)
        if u.path != "/encode":
            self.send_error(404); return
        qs = parse_qs(u.query); fen = unquote(qs.get("fen", [""])[0])
        try:
            vec = encode_fen(fen)
            body = json.dumps({"dim": len(vec), "vector": vec}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        except Exception as e:
            self.send_error(400, str(e))

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8181
    print(f"encoder-service ONNX={ONNX} layer={LAYER} pool={POOL} on :{port}", flush=True)
    HTTPServer(("127.0.0.1", port), H).serve_forever()
