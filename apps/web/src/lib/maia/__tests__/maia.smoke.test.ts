/**
 * @vitest-environment node
 *
 * KS-3577 smoke-test: реальная Maia-3 ONNX модель из
 * `apps/web/public/maia3/` загружается, прогоняется на стартовой
 * позиции (и позиции «ход чёрных») — проверяем форму выхода и
 * нормировку softmax по легальным ходам.
 *
 * Inference используется через `onnxruntime-web` в Node-окружении
 * (его WASM-рантайм работает и в Node, и в браузере — поэтому один
 * провайдер покрывает оба сценария). Изначально пробовали
 * `onnxruntime-node`, но его prebuilt native binding в текущем
 * docker-окружении сегфолтится — wasm-вариант стабилен.
 *
 * Тест помечен как медленный (~3-5 с на сессию + 1-2 с на inference),
 * прогоняется в общем `npm test` — таймауты выставлены явно.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it, beforeAll } from 'vitest';
import * as ortWeb from 'onnxruntime-web';

import {
  Maia,
  type InferenceProvider,
  type TensorLike,
} from '../engine';

// onnxruntime-web в Node-окружении: отключаем multi-threading и
// proxy worker — там нет SharedArrayBuffer/Worker по умолчанию.
beforeAll(() => {
  ortWeb.env.wasm.numThreads = 1;
  ortWeb.env.wasm.proxy = false;
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = resolve(
  __dirname,
  '../../../../public/maia3/maia3_simplified.onnx',
);

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const webProvider: InferenceProvider = {
  Tensor: ortWeb.Tensor as unknown as InferenceProvider['Tensor'],
  createSession: async (buffer) => {
    const session = await ortWeb.InferenceSession.create(buffer, {
      executionProviders: ['wasm'],
    });
    return {
      run: async (feeds) => {
        const result = await session.run(
          feeds as unknown as Record<string, ortWeb.Tensor>,
        );
        return result as unknown as Record<string, TensorLike>;
      },
    };
  },
};

async function loadBuffer(): Promise<ArrayBuffer> {
  const file = await readFile(MODEL_PATH);
  // Skip prefix/suffix чтобы получить чистый ArrayBuffer без node-Buffer
  // metadata (которое onnxruntime трактует иначе).
  return file.buffer.slice(
    file.byteOffset,
    file.byteOffset + file.byteLength,
  ) as ArrayBuffer;
}

describe('Maia smoke (KS-3577)', () => {
  it('модель не грузится до первого predictMoves (lazy)', () => {
    let fetched = false;
    const maia = new Maia({
      modelUrl: 'unused',
      modelVersion: 'test',
      provider: webProvider,
      useIndexedDbCache: false,
      fetchBuffer: async () => {
        fetched = true;
        return new ArrayBuffer(0);
      },
    });
    expect(maia).toBeInstanceOf(Maia);
    expect(fetched).toBe(false);
  });

  it(
    'на стартовой позиции возвращает 20 легальных ходов с softmax-распределением',
    { timeout: 120_000 },
    async () => {
      const buffer = await loadBuffer();
      const maia = new Maia({
        modelUrl: MODEL_PATH,
        modelVersion: 'test',
        provider: webProvider,
        useIndexedDbCache: false,
        fetchBuffer: async () => buffer,
      });

      const result = await maia.predictMoves(STARTPOS, 1500, 1500);

      expect(result.policy.length).toBe(20);

      const sum = result.policy.reduce((acc, p) => acc + p.probability, 0);
      expect(sum).toBeGreaterThan(0.999);
      expect(sum).toBeLessThan(1.001);

      for (const { probability } of result.policy) {
        expect(probability).toBeGreaterThanOrEqual(0);
        expect(probability).toBeLessThanOrEqual(1);
      }

      const moves = new Set(result.policy.map((p) => p.move));
      expect(moves.has('e2e4')).toBe(true);
      expect(moves.has('d2d4')).toBe(true);
      expect(moves.has('g1f3')).toBe(true);

      expect(result.winProbability).toBeGreaterThan(0.3);
      expect(result.winProbability).toBeLessThan(0.7);
    },
  );

  it(
    'для позиции «ход чёрных» возвращает ходы чёрной стороны',
    { timeout: 120_000 },
    async () => {
      const buffer = await loadBuffer();
      const maia = new Maia({
        modelUrl: MODEL_PATH,
        modelVersion: 'test',
        provider: webProvider,
        useIndexedDbCache: false,
        fetchBuffer: async () => buffer,
      });

      // После 1. e4 — ход чёрных, 20 ходов.
      const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
      const result = await maia.predictMoves(fen, 1500, 1500);

      expect(result.policy.length).toBe(20);
      const moves = new Set(result.policy.map((p) => p.move));
      expect(moves.has('e7e5')).toBe(true);
      expect(moves.has('c7c5')).toBe(true);

      const sum = result.policy.reduce((acc, p) => acc + p.probability, 0);
      expect(sum).toBeCloseTo(1, 3);
    },
  );
});
