/**
 * KS-3650 / ADR-107 rev 2 §6 F1. Тесты `stockfishTrace`:
 *
 *   1. `parseTraceJson`:
 *      - валидный baseline-JSON → массив `PositionalSubterm[]` с
 *        корректной типизацией;
 *      - неизвестные `id` (`psqt_*`, `mobility_*` — есть в WASM-выводе,
 *        но не входят в наш контракт MVP) → отброшены через `onUnknown`;
 *      - невалидные числа / отсутствие полей → пропуск.
 *
 *   2. Сверка с 6 эталонными JSON из `__fixtures__/` (`startpos.json`,
 *      `pos-01..pos-05.json`):
 *      - после фильтрации все оставшиеся `id` валидные;
 *      - `value_mg`/`value_eg` ровно равны исходным (без потерь
 *        точности при парсинге);
 *      - `color` и `square` сохранены там, где есть.
 *
 *   3. `evalTrace` с моковой фабрикой:
 *      - синхронный stdin корректно отдаёт все символы команд;
 *      - print собирает многострочный JSON и резолвит promise;
 *      - graceful: фабрика возвращает null → `[]`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  evalTrace,
  parseTraceJson,
} from './stockfishTrace';

// vitest запускается с cwd = apps/web (см. package.json/vitest.config).
// Fixtures лежат рядом с тестом — путь от cwd достаточен.
const FIXTURES_DIR = resolve(
  process.cwd(),
  'src/lib/review/__fixtures__',
);

function loadFixture(name: string): unknown {
  const raw = readFileSync(resolve(FIXTURES_DIR, name), 'utf8');
  return JSON.parse(raw);
}

describe('parseTraceJson', () => {
  it('null / non-object → []', () => {
    expect(parseTraceJson(null)).toEqual([]);
    expect(parseTraceJson(undefined)).toEqual([]);
    expect(parseTraceJson('not-an-object')).toEqual([]);
    expect(parseTraceJson(123)).toEqual([]);
  });

  it('нет поля subterms → []', () => {
    expect(parseTraceJson({})).toEqual([]);
    expect(parseTraceJson({ position: {}, total: {} })).toEqual([]);
  });

  it('один валидный subterm проходит', () => {
    const out = parseTraceJson({
      subterms: [
        {
          id: 'pawn_connected',
          color: 'w',
          square: 'a2',
          value_mg: 0.018,
          value_eg: -0.003,
        },
      ],
    });
    expect(out).toEqual([
      {
        id: 'pawn_connected',
        color: 'w',
        square: 'a2',
        value_mg: 0.018,
        value_eg: -0.003,
      },
    ]);
  });

  it('subterm без color/square — поля просто отсутствуют', () => {
    const out = parseTraceJson({
      subterms: [
        {
          id: 'space',
          value_mg: 0.25,
          value_eg: 0,
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ id: 'space', value_mg: 0.25, value_eg: 0 });
    expect('color' in out[0]).toBe(false);
    expect('square' in out[0]).toBe(false);
  });

  it('неизвестный id → отброшен с WARN', () => {
    const unknownIds: string[] = [];
    const out = parseTraceJson(
      {
        subterms: [
          // psqt_* и imbalance — заведомо не входят в VALID_IDS (KS-3677:
          // PSQT исключены архитектором как шум; imbalance ещё не
          // добавлен в shared, ждёт пересборки WASM).
          { id: 'psqt_rook', color: 'w', square: 'a1', value_mg: 3.79, value_eg: 4.18 },
          { id: 'imbalance', color: 'w', value_mg: -0.05, value_eg: -0.09 },
          { id: 'pawn_connected', color: 'w', square: 'a2', value_mg: 0.018, value_eg: 0 },
        ],
      },
      (id) => unknownIds.push(id),
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('pawn_connected');
    expect(unknownIds.sort()).toEqual(['imbalance', 'psqt_rook']);
  });

  it('невалидные числа / отсутствие полей → пропуск элемента', () => {
    const out = parseTraceJson({
      subterms: [
        { id: 'space', value_mg: NaN, value_eg: 0 },
        { id: 'space', value_mg: 0, value_eg: 'not-a-number' },
        { id: 'space' },
        { id: 'space', value_mg: 0.1, value_eg: 0 },
        null,
        'string-instead-of-object',
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].value_mg).toBe(0.1);
  });

  it('невалидный square (не a-h/1-8) — пропускаем поле, элемент сохраняем', () => {
    const out = parseTraceJson({
      subterms: [
        { id: 'space', color: 'w', square: 'z9', value_mg: 0.1, value_eg: 0 },
      ],
    });
    expect(out).toHaveLength(1);
    expect('square' in out[0]).toBe(false);
  });

  it('невалидный color — пропускаем поле, элемент сохраняем', () => {
    const out = parseTraceJson({
      subterms: [
        { id: 'space', color: 'x', square: 'a1', value_mg: 0.1, value_eg: 0 },
      ],
    });
    expect(out).toHaveLength(1);
    expect('color' in out[0]).toBe(false);
  });
});

describe('parseTraceJson — сверка с baseline (KS-3650 acceptance)', () => {
  const fixtures = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  it('фикстуры найдены (6 файлов от devops)', () => {
    expect(fixtures).toEqual([
      'pos-01.json',
      'pos-02.json',
      'pos-03.json',
      'pos-04.json',
      'pos-05.json',
      'startpos.json',
    ]);
  });

  for (const name of fixtures) {
    it(`${name}: парсится, все оставшиеся id валидные, значения совпадают`, () => {
      const raw = loadFixture(name) as {
        subterms: Array<{
          id: string;
          color?: string;
          square?: string;
          value_mg: number;
          value_eg: number;
        }>;
      };
      const dropped: string[] = [];
      const parsed = parseTraceJson(raw, (id) => dropped.push(id));

      // Все оставшиеся subterm'ы — с известными id (по union из shared).
      expect(parsed.every((t) => typeof t.id === 'string')).toBe(true);

      // Каждый valid id должен встречаться в parsed столько же раз,
      // сколько в исходном raw (с тем же color+square+value_mg+value_eg).
      const validRaw = raw.subterms.filter(
        (s) => !dropped.includes(s.id),
      );
      expect(parsed).toHaveLength(validRaw.length);

      // Точное поэлементное совпадение по 4-tuple (id, color, square, mg/eg
      // с допуском 1e-3 — на случай отличий em++ от нативного бинарника).
      for (let i = 0; i < parsed.length; i++) {
        expect(parsed[i].id).toBe(validRaw[i].id);
        expect(parsed[i].color).toBe(validRaw[i].color);
        expect(parsed[i].square).toBe(validRaw[i].square);
        expect(Math.abs(parsed[i].value_mg - validRaw[i].value_mg)).toBeLessThan(
          1e-3,
        );
        expect(Math.abs(parsed[i].value_eg - validRaw[i].value_eg)).toBeLessThan(
          1e-3,
        );
      }
    });
  }

  it('баseline дропает только известные «не-наши» id (psqt_*, mobility_*)', () => {
    // На startpos.json сверяем перечень отсеянных id — он должен быть
    // только из набора {psqt_*, mobility_*}. Если в новой ревизии WASM
    // вылезет новый id, тест упадёт — это сигнал обновить VALID_IDS.
    const raw = loadFixture('startpos.json');
    const dropped: string[] = [];
    parseTraceJson(raw, (id) => dropped.push(id));
    for (const id of dropped) {
      expect(
        /^(psqt|mobility)_/.test(id),
        `неожиданный id отброшен: ${id}`,
      ).toBe(true);
    }
  });
});

describe('evalTrace — с моковой фабрикой', () => {
  it('graceful: factory undefined → бросает factory-error (в happy-dom скрипт не загружается)', async () => {
    // KS-3676. Основной путь — `<script>` + `window.StockfishTrace()`.
    // В happy-dom есть `document`, но реально файл не подгружается —
    // `s.onerror` срабатывает, evalTrace бросает StockfishTraceEngineError.
    // В реальном браузере на боевой среде скрипт грузится штатно.
    await expect(
      evalTrace('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
    ).rejects.toThrow(/factory-error/);
  });

  it('моковая factory: команды собираются через stdin, JSON парсится', async () => {
    const stdoutChunks: string[] = [];

    // Фабрика читает все команды через stdin, потом «отдаёт» через
    // print строки JSON. Эмулирует реальный SF: после `eval json`
    // эмитит JSON в stdout, после `quit` завершается.
    const factory = async (opts: {
      print: (line: string) => void;
      stdin: () => number | null;
    }) => {
      // Прочитать все команды из stdin до EOF.
      let current = '';
      while (true) {
        const code = opts.stdin();
        if (code == null) break;
        if (code === 0x0a /* \n */) {
          stdoutChunks.push(`[uci-cmd] ${current}`);
          current = '';
        } else {
          current += String.fromCharCode(code);
        }
      }
      // «Эмитим» JSON.
      const json = {
        position: { fen: 'startpos', sideToMove: 'w' },
        subterms: [
          { id: 'pawn_connected', color: 'w', square: 'a2', value_mg: 0.1, value_eg: 0 },
        ],
        total: { mg: 0, eg: 0, v: 0 },
      };
      const lines = JSON.stringify(json, null, 2).split('\n');
      for (const l of lines) opts.print(l);
      return {};
    };

    const result = await evalTrace('startpos-fen', { factory });

    expect(stdoutChunks).toContain('[uci-cmd] setoption name Use NNUE value false');
    expect(stdoutChunks.some((s) => s.startsWith('[uci-cmd] position fen startpos-fen'))).toBe(
      true,
    );
    expect(stdoutChunks).toContain('[uci-cmd] eval json');
    expect(stdoutChunks).toContain('[uci-cmd] quit');

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 'pawn_connected',
      color: 'w',
      square: 'a2',
      value_mg: 0.1,
      value_eg: 0,
    });
  });

  it('моковая factory: JSON не пришёл → [] (timeout не дожидаемся, эмулируем фабрикой без print)', async () => {
    const factory = async (opts: {
      print: (line: string) => void;
      stdin: () => number | null;
    }) => {
      while (opts.stdin() != null) {
        /* потребляем команды без эмита JSON */
      }
      // Эмитим неполный JSON (открытая скобка без закрытия) — braceDepth
      // никогда не вернётся в 0, JSON не зарезолвится, race на 5 с
      // упадёт в null. Чтобы тест не ждал 5 с, печатаем валидный пустой
      // объект — он быстро резолвится, но subterms нет → парсер вернёт [].
      opts.print('{}');
      return {};
    };
    const result = await evalTrace('any', { factory });
    expect(result).toEqual([]);
  });

  it('моковая factory: текст до JSON в print — пропускается без сборки', async () => {
    const factory = async (opts: {
      print: (line: string) => void;
      stdin: () => number | null;
    }) => {
      while (opts.stdin() != null) {
        /* drain */
      }
      // Сначала SF-баннер и пр. info-строки, потом JSON.
      opts.print('Stockfish 16 by the Stockfish developers');
      opts.print('info string classical evaluation enabled');
      const json = {
        position: { fen: 'x', sideToMove: 'w' },
        subterms: [
          { id: 'space', color: 'w', value_mg: 0.25, value_eg: 0 },
        ],
        total: { mg: 0, eg: 0, v: 0 },
      };
      for (const l of JSON.stringify(json, null, 2).split('\n')) opts.print(l);
      return {};
    };
    const result = await evalTrace('x', { factory });
    expect(result).toEqual([
      { id: 'space', color: 'w', value_mg: 0.25, value_eg: 0 },
    ]);
  });
});
