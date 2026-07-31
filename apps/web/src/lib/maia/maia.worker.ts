/// <reference lib="webworker" />
/**
 * KS-3579. Maia-3 Web Worker — переносит inference с main thread,
 * чтобы доска и анимации не подвисали на ~1 сек инференса.
 *
 * Message-протокол:
 *   IN  { type:'init', modelUrl, modelVersion? }
 *   IN  { type:'inference', id, tokens:ArrayBuffer, eloSelfs:ArrayBuffer,
 *         eloOppos:ArrayBuffer, batchSize }
 *   OUT { type:'ready' }
 *   OUT { type:'result', id, logitsMove:ArrayBuffer, logitsValue:ArrayBuffer }
 *   OUT { type:'error', id?, message }
 *
 * Все Float32Array'и передаются как ArrayBuffer'ы с transfer-list для
 * zero-copy (postMessage 3-й аргумент).
 *
 * Препроцессинг (FEN → tokens + legal mask + blackToMove) делается на
 * main thread (`tensor.ts`) — он быстрый (~1 мс) и требует `chess.js`,
 * который я бы не хотел тянуть в worker-bundle. Post-processing
 * (softmax по легальным ходам + декодирование UCI с зеркалом) — там же
 * на main thread (`postprocessMaia3` в engine.ts).
 */
import * as ort from 'onnxruntime-web';

let session: ort.InferenceSession | null = null;
let initPromise: Promise<void> | null = null;

declare const self: DedicatedWorkerGlobalScope;

async function initSession(
  modelUrl: string,
  modelBuffer?: ArrayBuffer,
): Promise<void> {
  // Worker без SharedArrayBuffer (на нашем фронте COOP/COEP по KS-3065
  // стоят, но onnxruntime-web в multi-thread в воркере мудрит — проще
  // зафиксировать single-thread, скорость inference Maia-3 single
  // ~600-900 мс батчем 14 на средних ноутах, нам этого хватает).
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  // KS-4103: явный путь к ort-wasm бинарнику, обслуживаемому с нашего
  // origin (`apps/web/public/ort/`). Без этого onnxruntime-web ищет
  // `ort-wasm-simd-threaded.jsep.wasm` относительно своего скрипта; в
  // vite dev этот путь уходит на SPA-fallback и возвращает index.html
  // (text/html) вместо бинарника → InferenceSession.create падает, и
  // колонка MAIA% в анализе показывала «(--)» (на проде wasm
  // эмитировался сборкой и грузился). Дефолтная сборка ort
  // (`ort.bundle.min.mjs`) инлайнит JS-glue и FETCH-ит только `.wasm`,
  // поэтому достаточно указать `wasm`; fetch из /public разрешён (в
  // отличие от import .mjs-модуля). Same-origin, dev+prod, COEP ок.
  ort.env.wasm.wasmPaths = { wasm: '/ort/ort-wasm-simd-threaded.jsep.wasm' };

  // KS-5016: если main-thread уже устойчиво загрузил модель (с повтором
  // и прогрессом) и передал буфер — используем его напрямую, без второго
  // сетевого запроса. Fallback на fetch по URL сохранён для обратной
  // совместимости (тесты/старые вызовы без буфера).
  let buffer: ArrayBuffer;
  if (modelBuffer) {
    buffer = modelBuffer;
  } else {
    const response = await fetch(modelUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    buffer = await response.arrayBuffer();
  }
  session = await ort.InferenceSession.create(buffer, {
    executionProviders: ['wasm'],
  });
}

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data as
    | { type: 'init'; modelUrl: string; modelBuffer?: ArrayBuffer }
    | {
        type: 'inference';
        id: number;
        tokens: ArrayBuffer;
        eloSelfs: ArrayBuffer;
        eloOppos: ArrayBuffer;
        batchSize: number;
      };

  try {
    if (msg.type === 'init') {
      if (!initPromise) {
        initPromise = initSession(msg.modelUrl, msg.modelBuffer);
      }
      await initPromise;
      self.postMessage({ type: 'ready' });
      return;
    }

    if (msg.type === 'inference') {
      if (!session) {
        throw new Error('Model not initialised');
      }
      const tokens = new Float32Array(msg.tokens);
      const eloSelfs = new Float32Array(msg.eloSelfs);
      const eloOppos = new Float32Array(msg.eloOppos);

      const feeds = {
        tokens: new ort.Tensor('float32', tokens, [msg.batchSize, 64, 12]),
        elo_self: new ort.Tensor('float32', eloSelfs, [msg.batchSize]),
        elo_oppo: new ort.Tensor('float32', eloOppos, [msg.batchSize]),
      };

      const out = await session.run(feeds);
      const logitsMove = new Float32Array(out.logits_move.data as Float32Array);
      const logitsValue = new Float32Array(
        out.logits_value.data as Float32Array,
      );

      self.postMessage(
        {
          type: 'result',
          id: msg.id,
          logitsMove: logitsMove.buffer,
          logitsValue: logitsValue.buffer,
        },
        { transfer: [logitsMove.buffer, logitsValue.buffer] },
      );
      return;
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      id: 'id' in msg ? msg.id : undefined,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
