/**
 * KS-3632/KS-3633 / ADR-104 §4-5. Node-провайдер Maia engine.
 *
 * Использует `onnxruntime-web` через WASM (а не `onnxruntime-node`):
 *  - `onnxruntime-node` сегфолтит в Docker prebuilt-биндингом (см.
 *    KS-3577 smoke);
 *  - `onnxruntime-web` через WASM запускается и в Node, и в браузере.
 *
 * Возвращает готовый `InferenceProvider` для передачи в `Maia({provider})`.
 * Singleton не делаем — caller сам решает (admin-CLI и tactic-worker
 * держат один инстанс на процесс).
 *
 * Этот файл отделён от `engine.ts` намеренно: pure-engine не зависит
 * от onnxruntime-web — caller может передать свой провайдер (например,
 * mock в unit-тестах или onnxruntime-node когда баг с биндингом починят).
 */
import * as ort from 'onnxruntime-web';

import type {
  InferenceProvider,
  InferenceSessionLike,
  TensorLike,
} from './engine.js';

/**
 * Создаёт `InferenceProvider`, подходящий для Node-окружения
 * (admin-CLI, воркер). Конфигурирует ORT WASM: 1 поток, без proxy,
 * — это совместимо с Node и не требует SharedArrayBuffer.
 */
export function createNodeProvider(): InferenceProvider {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;

  return {
    Tensor: ort.Tensor as unknown as InferenceProvider['Tensor'],
    createSession: async (buffer: ArrayBuffer): Promise<InferenceSessionLike> => {
      const session = await ort.InferenceSession.create(buffer, {
        executionProviders: ['wasm'],
      });
      return {
        run: async (
          feeds: Record<string, TensorLike>,
        ): Promise<Record<string, TensorLike>> => {
          const result = await session.run(
            feeds as unknown as Record<string, ort.Tensor>,
          );
          return result as unknown as Record<string, TensorLike>;
        },
      };
    },
  };
}

/**
 * Helper для чтения ONNX-модели с FS в `ArrayBuffer`. Slice по
 * `byteOffset` нужен потому что `readFile` возвращает Node `Buffer`,
 * у которого `.buffer` может быть shared с другими аллокациями;
 * onnxruntime требует чистый ArrayBuffer-окно.
 */
export async function loadModelFromFs(modelPath: string): Promise<ArrayBuffer> {
  const { readFile } = await import('node:fs/promises');
  const file = await readFile(modelPath);
  return file.buffer.slice(
    file.byteOffset,
    file.byteOffset + file.byteLength,
  ) as ArrayBuffer;
}
