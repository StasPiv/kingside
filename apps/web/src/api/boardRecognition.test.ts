/**
 * KS-2365: тесты `recognizeBoard`. Покрываем оба сценария — happy path
 * (backend ответил), 404 fallback (KS-2363 ещё не задеплоен), network
 * error.
 */
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  recognizeBoard,
  BoardNotDetectedError,
  BoardRecognitionUnreliableError,
  normalizeLowConfidenceCells,
  normalizeOrientation,
  autodetectOrientationFromFen,
  resolveOrientation,
  normalizeBoards,
} from './boardRecognition';

const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function makeFile(): File {
  return new File([new Uint8Array([1, 2, 3])], 'board.png', { type: 'image/png' });
}

describe('recognizeBoard (KS-2365)', () => {
  it('возвращает backend-ответ при HTTP 200', async () => {
    const expected = {
      fen: '8/8/4k3/4P2p/8/P2pR3/P4PP1/3r2K1 w - - 2 51',
      fenBoard: '8/8/4k3/4P2p/8/P2pR3/P4PP1/3r2K1',
      orientation: 'white',
      orientationConfidence: 0.92,
      bbox: { x: 10, y: 20, width: 300, height: 300 },
      modelVersion: 'br-v1',
      lowConfidenceCells: [],
      warnings: [],
    };
    const fetchImpl = async () => new Response(JSON.stringify(expected), { status: 200 });
    const res = await recognizeBoard(makeFile(), { fetchImpl: fetchImpl as typeof fetch });
    expect(res).toEqual(expected);
  });

  it('при 404 (KS-2363 pending) возвращает мок без падения', async () => {
    const fetchImpl = async () => new Response('not found', { status: 404 });
    const res = await recognizeBoard(makeFile(), { fetchImpl: fetchImpl as typeof fetch });
    expect(res.fen).toBe(STARTING_FEN);
    expect(res.modelVersion).toBe('mock-ks2363-pending');
    expect(res.warnings[0]).toMatch(/^mock:/);
  });

  it('KS-3120: network-error → BoardNotDetectedError (раньше возвращался мок со стартовой позицией и тех. строкой в warnings — это вводило в заблуждение)', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(
      recognizeBoard(makeFile(), { fetchImpl: fetchImpl as typeof fetch }),
    ).rejects.toBeInstanceOf(BoardNotDetectedError);
  });

  it('AbortError пробрасывается без подмены мока', async () => {
    const fetchImpl = async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    };
    await expect(
      recognizeBoard(makeFile(), { fetchImpl: fetchImpl as typeof fetch }),
    ).rejects.toThrow('aborted');
  });

  it('hotfix: URL запроса включает VITE_API_URL (api.kingside.site, не относительный /api/...)', async () => {
    // Раньше: const res = await fetchFn('/api/board-recognition', …) —
    // CloudFront на kingside.site/api/* не маршрутизирует, запросы
    // улетали в 404. Контроллер на бэке висит на `/board-recognition`
    // без `/api`-префикса (как `/auth/login`), origin задаётся через
    // `VITE_API_URL` (api.kingside.site).
    let capturedUrl = '';
    const fetchImpl = async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          fen: STARTING_FEN,
          fenBoard: STARTING_FEN.split(' ')[0],
          orientation: 'white',
          orientationConfidence: 0.5,
          bbox: { x: 0, y: 0, width: 0, height: 0 },
          modelVersion: 'br-v1',
          lowConfidenceCells: [],
          warnings: [],
        }),
        { status: 200 },
      );
    };
    await recognizeBoard(makeFile(), { fetchImpl: fetchImpl as typeof fetch });
    expect(capturedUrl).toMatch(/\/board-recognition$/);
    expect(capturedUrl.startsWith('/api/')).toBe(false);
  });

  it('KS-3093: на 422 бросает BoardRecognitionUnreliableError c payload', async () => {
    const payload = {
      error: 'recognition_unreliable',
      fenAttempt:
        'r2q1rk1/ppp1b1pp/1nn1pP2/5b2/2PP4/2N1BN2/PP2B1PP/P2Q1RK1 w - - 0 1',
      issues: ['some pawns are on the edge rows'],
      lowConfidenceCells: [
        { file: 0, rank: 7, piece: 'P', confidence: 0.51 },
      ],
      orientation: 'white' as const,
      modelVersion: '0.9.3',
    };
    const fetchImpl = async () =>
      new Response(JSON.stringify(payload), { status: 422 });
    await expect(
      recognizeBoard(makeFile(), { fetchImpl: fetchImpl as typeof fetch }),
    ).rejects.toBeInstanceOf(BoardRecognitionUnreliableError);
    // Повторим с try/catch чтобы достать payload (rejects.toMatchObject
    // на классовом instance не разворачивает кастомные поля).
    try {
      await recognizeBoard(makeFile(), { fetchImpl: fetchImpl as typeof fetch });
    } catch (e) {
      const err = e as BoardRecognitionUnreliableError;
      expect(err.payload.fenAttempt).toBe(payload.fenAttempt);
      expect(err.payload.issues).toEqual(payload.issues);
      expect(err.payload.lowConfidenceCells).toHaveLength(1);
      expect(err.payload.modelVersion).toBe('0.9.3');
    }
  });

  it('KS-3093: на 422 с битым JSON всё равно бросает unreliable-error', async () => {
    const fetchImpl = async () => new Response('not-a-json', { status: 422 });
    await expect(
      recognizeBoard(makeFile(), { fetchImpl: fetchImpl as typeof fetch }),
    ).rejects.toBeInstanceOf(BoardRecognitionUnreliableError);
  });

  it('KS-3094: на 400 бросает BoardNotDetectedError c payload', async () => {
    const payload = {
      error: 'board_not_detected',
      message: 'no board square found in image',
    };
    const fetchImpl = async () =>
      new Response(JSON.stringify(payload), { status: 400 });
    await expect(
      recognizeBoard(makeFile(), { fetchImpl: fetchImpl as typeof fetch }),
    ).rejects.toBeInstanceOf(BoardNotDetectedError);
    try {
      await recognizeBoard(makeFile(), { fetchImpl: fetchImpl as typeof fetch });
    } catch (e) {
      const err = e as BoardNotDetectedError;
      expect(err.payload.error).toBe('board_not_detected');
      expect(err.payload.message).toBe('no board square found in image');
    }
  });

  it('KS-3094: на 400 с битым JSON всё равно бросает board_not_detected', async () => {
    const fetchImpl = async () => new Response('not-a-json', { status: 400 });
    await expect(
      recognizeBoard(makeFile(), { fetchImpl: fetchImpl as typeof fetch }),
    ).rejects.toBeInstanceOf(BoardNotDetectedError);
  });

  it('KS-3120: 500 → BoardNotDetectedError (не мок со стартовой позицией)', async () => {
    const fetchImpl = async () => new Response('boom', { status: 500 });
    await expect(
      recognizeBoard(makeFile(), { fetchImpl: fetchImpl as typeof fetch }),
    ).rejects.toBeInstanceOf(BoardNotDetectedError);
  });

  it('KS-3120: 502/503 — тот же путь, BoardNotDetectedError', async () => {
    for (const status of [502, 503] as const) {
      const fetchImpl = async () => new Response('boom', { status });
      await expect(
        recognizeBoard(makeFile(), { fetchImpl: fetchImpl as typeof fetch }),
      ).rejects.toBeInstanceOf(BoardNotDetectedError);
    }
  });

  it('KS-3120: 500-error message без stack/statusCode в техническом виде', async () => {
    const fetchImpl = async () => new Response('boom', { status: 500 });
    try {
      await recognizeBoard(makeFile(), { fetchImpl: fetchImpl as typeof fetch });
    } catch (e) {
      const err = e as BoardNotDetectedError;
      // message не содержит «mock:», «network:», stack-trace, response body.
      expect(err.message).not.toMatch(/mock:/i);
      expect(err.message).not.toContain('boom');
      // statusCode допустим в техническом payload.message (для дебага),
      // но это НЕ финальный UI-текст — компонент i18n-маппит на свой
      // пользовательский message.
      expect(err.payload.error).toBe('board_not_detected');
    }
  });

  it('KS-3106: 200 c реальным форматом backend ({square, predicted, ...}) — нормализуется в {file, rank, piece}', async () => {
    // Точный формат от apps/api/board-recognition.service.ts → toResponse().
    const realPayload = {
      fen: '6b1/kK3r2/3pQ1np/4N3/2Pp4/3P2PP/PP2Q1BK/4R3 w - - 0 1',
      fenBoard: '6b1/kK3r2/3pQ1np/4N3/2Pp4/3P2PP/PP2Q1BK/4R3',
      orientation: 'white' as const,
      orientationConfidence: 0.94,
      bbox: [0, 0, 320, 320],
      modelVersion: '0.9.5',
      lowConfidenceCells: [
        { square: 'a8', predicted: 'empty', confidence: 0.41, top3: [] },
        { square: 'h2', predicted: 'wK', confidence: 0.52, top3: [] },
        { square: 'b7', predicted: 'wK', confidence: 0.48, top3: [] },
      ],
      warnings: ['sanity: white king count = 2 (expected 1)', 'low confidence: 3 cells'],
    };
    const fetchImpl = async () =>
      new Response(JSON.stringify(realPayload), { status: 200 });
    const res = await recognizeBoard(makeFile(), {
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(res.lowConfidenceCells).toHaveLength(3);
    expect(res.lowConfidenceCells[0]).toMatchObject({ file: 0, rank: 0 });
    expect(res.lowConfidenceCells[1]).toMatchObject({ file: 7, rank: 6 });
    expect(res.lowConfidenceCells[2]).toMatchObject({ file: 1, rank: 1 });
    expect(res.lowConfidenceCells[1].piece).toBe('wK');
  });
});

describe('normalizeLowConfidenceCells (KS-3106)', () => {
  it('бэк-формат {square, predicted}', () => {
    const out = normalizeLowConfidenceCells([
      { square: 'a8', predicted: 'wK', confidence: 0.5, top3: [] },
      { square: 'h1', predicted: 'empty', confidence: 0.3 },
    ]);
    expect(out).toEqual([
      { file: 0, rank: 0, piece: 'wK', confidence: 0.5 },
      { file: 7, rank: 7, piece: 'empty', confidence: 0.3 },
    ]);
  });

  it('legacy-формат {file, rank, piece} (0-based file/rank)', () => {
    const out = normalizeLowConfidenceCells([
      { file: 0, rank: 7, piece: 'P', confidence: 0.51 },
    ]);
    expect(out).toEqual([{ file: 0, rank: 7, piece: 'P', confidence: 0.51 }]);
  });

  it('массив строк ["a1", "h8"]', () => {
    const out = normalizeLowConfidenceCells(['a1', 'h8']);
    expect(out).toEqual([
      { file: 0, rank: 7, piece: '.', confidence: 0 },
      { file: 7, rank: 0, piece: '.', confidence: 0 },
    ]);
  });

  it('FEN-rank (1..8) автоматически конвертируется в 0..7', () => {
    const out = normalizeLowConfidenceCells([
      { file: 0, rank: 8, piece: 'k', confidence: 0.4 },
    ]);
    expect(out).toEqual([{ file: 0, rank: 0, piece: 'k', confidence: 0.4 }]);
  });

  it('пропускает мусор без падения', () => {
    const out = normalizeLowConfidenceCells([
      null,
      'zz',
      { square: 'not-a-square' },
      { file: 99, rank: 0 },
      { square: 'a8', predicted: 'wK', confidence: 0.5 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ file: 0, rank: 0, piece: 'wK' });
  });

  it('массив отсутствует / null', () => {
    expect(normalizeLowConfidenceCells(undefined)).toEqual([]);
    expect(normalizeLowConfidenceCells(null)).toEqual([]);
    expect(normalizeLowConfidenceCells({ wrong: 'shape' })).toEqual([]);
  });
});

describe('normalizeOrientation (KS-3108)', () => {
  it('строки white/black', () => {
    expect(normalizeOrientation('white')).toBe('white');
    expect(normalizeOrientation('black')).toBe('black');
  });
  it('короткие w/b', () => {
    expect(normalizeOrientation('w')).toBe('white');
    expect(normalizeOrientation('b')).toBe('black');
  });
  it('boolean flipped', () => {
    expect(normalizeOrientation(true)).toBe('black');
    expect(normalizeOrientation(false)).toBe('white');
  });
  it('числа 0/1', () => {
    expect(normalizeOrientation(0)).toBe('white');
    expect(normalizeOrientation(1)).toBe('black');
  });
  it('мусор / отсутствует → null', () => {
    expect(normalizeOrientation(undefined)).toBeNull();
    expect(normalizeOrientation('zz')).toBeNull();
    expect(normalizeOrientation(42)).toBeNull();
  });
});

describe('autodetectOrientationFromFen (KS-3108)', () => {
  it('стандартная стартовая позиция → white', () => {
    expect(
      autodetectOrientationFromFen(
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
      ),
    ).toBe('white');
  });
  it('перевёрнутая (чёрные снизу) → black', () => {
    // wK на 8-м ранге (top FEN), bK на 1-м (bottom FEN) — доска как
    // будто перевёрнута относительно стандартного рендера.
    expect(
      autodetectOrientationFromFen(
        'RNBKQBNR/PPPPPPPP/8/8/8/8/pppppppp/rnbkqbnr',
      ),
    ).toBe('black');
  });
  it('wK на ранге 1, bK на ранге 8 → white (стандарт)', () => {
    expect(autodetectOrientationFromFen('4k3/8/8/8/8/8/8/4K3')).toBe(
      'white',
    );
  });
  it('wK на ранге 8, bK на ранге 1 → black (перевёрнуто)', () => {
    expect(autodetectOrientationFromFen('4K3/8/8/8/8/8/8/4k3')).toBe(
      'black',
    );
  });
  it('короли в центре (rank 4-5) → null (неоднозначно)', () => {
    expect(autodetectOrientationFromFen('8/8/8/4K3/4k3/8/8/8')).toBeNull();
  });
  it('нет королей → null', () => {
    expect(autodetectOrientationFromFen('8/8/8/8/8/8/8/8')).toBeNull();
  });
  it('битый FEN → null', () => {
    expect(autodetectOrientationFromFen('badfen')).toBeNull();
  });
});

describe('resolveOrientation (KS-3108)', () => {
  const STD = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
  const FLIPPED = 'RNBKQBNR/PPPPPPPP/8/8/8/8/pppppppp/rnbkqbnr';

  it('backend confidence >= 0.7 → доверяем backend', () => {
    expect(resolveOrientation('white', 0.9, FLIPPED)).toBe('white');
    expect(resolveOrientation('black', 0.85, STD)).toBe('black');
  });
  it('backend confidence < 0.7 + autodetect → autodetect', () => {
    // Backend сказал white с низким confidence, эвристика говорит
    // black (перевёрнутая позиция) — берём эвристику.
    expect(resolveOrientation('white', 0.3, FLIPPED)).toBe('black');
  });
  it('backend orientation мусор → autodetect', () => {
    expect(resolveOrientation('garbage', 1.0, STD)).toBe('white');
    expect(resolveOrientation(undefined, 1.0, FLIPPED)).toBe('black');
  });
  it('backend мусор + autodetect не сработал → fallback на parsed/white', () => {
    expect(resolveOrientation('garbage', 1.0, '8/8/8/8/8/8/8/8')).toBe(
      'white',
    );
  });
  it('случай KS-3108: backend white-confidence 0.5, fen перевёрнут → black', () => {
    expect(resolveOrientation('white', 0.5, FLIPPED)).toBe('black');
  });
});

describe('recognizeBoard KS-3115 (response без fen/fenBoard)', () => {
  it('200 ответ без fen — бросает BoardNotDetectedError, НЕ TypeError', async () => {
    // Точный payload из жалобы пользователя — backend v2.0.0 на
    // нераспознанной картинке: bbox=[0,0,0,0], без fen/fenBoard.
    const realDegenerate = {
      orientationConfidence: 1,
      bbox: [0, 0, 0, 0],
      modelVersion: '2.0.0',
      lowConfidenceCells: [],
      warnings: [],
    };
    const fetchImpl = async () =>
      new Response(JSON.stringify(realDegenerate), { status: 200 });
    await expect(
      recognizeBoard(makeFile(), { fetchImpl: fetchImpl as typeof fetch }),
    ).rejects.toBeInstanceOf(BoardNotDetectedError);
  });

  it('200 с fenBoard но без fen — всё равно BoardNotDetectedError (требуем оба)', async () => {
    const payload = {
      fenBoard: '8/8/8/8/8/8/8/8',
      orientationConfidence: 0.5,
      bbox: [0, 0, 0, 0],
      lowConfidenceCells: [],
      warnings: [],
    };
    const fetchImpl = async () =>
      new Response(JSON.stringify(payload), { status: 200 });
    await expect(
      recognizeBoard(makeFile(), { fetchImpl: fetchImpl as typeof fetch }),
    ).rejects.toBeInstanceOf(BoardNotDetectedError);
  });
});

describe('normalizeBoards (KS-3117)', () => {
  const VALID = {
    fen: '8/4k3/8/8/8/8/4K3/8 w - - 0 1',
    fenBoard: '8/4k3/8/8/8/8/4K3/8',
    orientation: 'white' as const,
    orientationConfidence: 0.9,
    bbox: [10, 20, 100, 100],
    modelVersion: '2.0.0',
    lowConfidenceCells: [],
    warnings: [],
  };

  it('undefined / null / пустой массив → undefined (single-board режим)', () => {
    expect(normalizeBoards(undefined)).toBeUndefined();
    expect(normalizeBoards(null)).toBeUndefined();
    expect(normalizeBoards([])).toBeUndefined();
    expect(normalizeBoards('not-array')).toBeUndefined();
  });

  it('массив из 1 валидной доски → массив длины 1', () => {
    const out = normalizeBoards([VALID]);
    expect(out).toHaveLength(1);
    expect(out![0].fen).toBe(VALID.fen);
  });

  it('массив из N валидных досок → сохраняет все', () => {
    const out = normalizeBoards([VALID, { ...VALID, fen: VALID.fen + ' tag2' }, VALID]);
    expect(out).toHaveLength(3);
  });

  it('пропускает элементы без fen/fenBoard (KS-3115 guard)', () => {
    const partial = { ...VALID } as Partial<typeof VALID>;
    delete partial.fen;
    const out = normalizeBoards([VALID, partial, VALID]);
    expect(out).toHaveLength(2);
  });

  it('нормализует lowConfidenceCells внутри каждой доски (KS-3106)', () => {
    const boardWithCells = {
      ...VALID,
      lowConfidenceCells: [
        // Backend prod-формат {square, predicted}.
        { square: 'a8', predicted: 'wK', confidence: 0.5 },
      ],
    };
    const out = normalizeBoards([boardWithCells])!;
    expect(out[0].lowConfidenceCells).toHaveLength(1);
    // После normalize — наш формат {file, rank, piece, confidence}.
    expect(out[0].lowConfidenceCells[0]).toMatchObject({
      file: 0,
      rank: 0,
      piece: 'wK',
    });
  });

  it('пропускает мусор (string, null, {}, без fen) без падения', () => {
    const out = normalizeBoards([VALID, null, 'string', {}, { fen: 'x' }, VALID]);
    expect(out).toHaveLength(2);
  });
});

describe('recognizeBoard KS-3117 (multi-board)', () => {
  const BOARD_A = {
    fen: '8/4k3/8/8/8/8/4K3/8 w - - 0 1',
    fenBoard: '8/4k3/8/8/8/8/4K3/8',
    orientation: 'white' as const,
    orientationConfidence: 0.9,
    bbox: [10, 20, 100, 100],
    modelVersion: '2.0.0',
    lowConfidenceCells: [],
    warnings: [],
  };
  const BOARD_B = { ...BOARD_A, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1', fenBoard: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR' };

  it('200 с boards[2] — клиент сохраняет массив целиком', async () => {
    const payload = { ...BOARD_A, boards: [BOARD_A, BOARD_B] };
    const fetchImpl = async () =>
      new Response(JSON.stringify(payload), { status: 200 });
    const res = await recognizeBoard(makeFile(), {
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(res.boards).toBeDefined();
    expect(res.boards).toHaveLength(2);
    expect(res.boards![0].fen).toBe(BOARD_A.fen);
    expect(res.boards![1].fen).toBe(BOARD_B.fen);
  });

  it('200 без boards — single-board режим, res.boards undefined', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify(BOARD_A), { status: 200 });
    const res = await recognizeBoard(makeFile(), {
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(res.boards).toBeUndefined();
  });

  it('200 с boards: [] — клиент не хранит пустой массив (treats as single)', async () => {
    const payload = { ...BOARD_A, boards: [] };
    const fetchImpl = async () =>
      new Response(JSON.stringify(payload), { status: 200 });
    const res = await recognizeBoard(makeFile(), {
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(res.boards).toBeUndefined();
  });
});
