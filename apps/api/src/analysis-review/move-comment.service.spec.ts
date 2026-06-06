/**
 * KS-3711. Unit-тесты MoveCommentService для нового эндпоинта
 * `POST /analyses/review/move-comment`.
 *
 * Покрытие:
 *  - buildSystemPrompt: RU/EN, иерархия достоверности
 *    (`sf18_eval` → `sf18_pv` → статика), блок про комментирование
 *    сыгранного хода с обязательной констатацией ошибки, запрет
 *    шаблонных зачинов («По форме», «На доске типичная»), словарь
 *    расшифровок.
 *  - comment(): graceful degradation без `AI_CHAT_WEBHOOK_URL`, payload
 *    в webhook (move + before + after), интеграция с
 *    `parseModelOutput` (контракт `{comment, highlights, arrows}`),
 *    обработка ошибок (пустой ответ при сбое).
 *  - rate-limit: отдельные ключи `review-move:rate:*`, корректные
 *    пороги (60/мин, 600/день per user, 5000/день global).
 */
import { ConfigService } from '@nestjs/config';
import { HttpException, HttpStatus } from '@nestjs/common';
import { MoveCommentService } from './move-comment.service';
import type { MoveCommentDto } from './dto/move-comment.dto';

type ConfigMap = Record<string, string>;

function makeConfigService(values: ConfigMap = {}): ConfigService {
  return {
    get: (key: string, fallback?: unknown) =>
      values[key] !== undefined ? values[key] : fallback,
  } as unknown as ConfigService;
}

function makeRedisStub(values: Record<string, string | null> = {}) {
  return {
    get: jest.fn(async (key: string) => values[key] ?? null),
    set: jest.fn(),
    pipeline: jest.fn(() => ({
      incr: () => ({} as any),
      expire: () => ({} as any),
      exec: async () => [],
    })),
  } as any;
}

function makeDto(overrides: Partial<MoveCommentDto> = {}): MoveCommentDto {
  return {
    move: {
      san: 'Be6',
      uci: 'c8e6',
      capture: null,
      check: false,
      mate: null,
      castling: null,
      promotion: null,
      classification: 'blunder',
    },
    before: {
      fen: 'r1bqkb1r/ppp2ppp/2n2n2/3PQ3/4P3/8/PPP2PPP/RNB1KBNR b KQkq - 1 5',
      factors: [
        { id: 'sf18_eval', score: { type: 'cp', value: 25 } },
        { id: 'sf18_pv', moves: ['c8e6', 'd5e6', 'f7e6'] },
        { id: 'material', value_mg: 0.5, value_eg: 0.5 },
      ],
    },
    after: {
      fen: 'r2qkb1r/ppp2ppp/2n1bn2/3PQ3/4P3/8/PPP2PPP/RNB1KBNR w KQkq - 2 6',
      factors: [
        { id: 'sf18_eval', score: { type: 'cp', value: 320 } },
        { id: 'sf18_pv', moves: ['d5e6', 'f7e6', 'e5e6'] },
        { id: 'material', value_mg: 0.5, value_eg: 0.5 },
      ],
    },
    language: 'ru',
    ...overrides,
  };
}

describe('MoveCommentService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────
  describe('buildSystemPrompt — RU', () => {
    // KS-3814: проверки полной инструкции — на long-варианте, который
    // оставлен под ENV `AI_PROMPT_VARIANT=long` как страховка стиля.
    const svc = new MoveCommentService(
      makeConfigService({ AI_PROMPT_VARIANT: 'long' }),
      makeRedisStub(),
    );

    it('по умолчанию (без аргумента) — RU и начинается с роли «комментируешь ОДИН сыгранный шахматный ход»', () => {
      const p = svc.buildSystemPrompt();
      expect(p).toMatch(
        /^Ты комментируешь ОДИН сыгранный шахматный ход/,
      );
    });

    it('явно language="ru" — то же, что без аргумента', () => {
      expect(svc.buildSystemPrompt('ru')).toBe(svc.buildSystemPrompt());
    });

    it('акцент на сравнении ДО и ПОСЛЕ — два снимка, какие факторы выросли/растворились, как поменялась оценка', () => {
      const p = svc.buildSystemPrompt('ru');
      expect(p).toContain('ДВА снимка позиции');
      expect(p).toContain('ДО хода');
      expect(p).toContain('ПОСЛЕ хода');
      expect(p).toContain('сравни ДО и ПОСЛЕ');
      expect(p).toMatch(/факторы выросли.*растворились/);
      expect(p).toMatch(/как поменялась оценка/);
    });

    it('иерархия достоверности sf18_eval → sf18_pv → статика', () => {
      const p = svc.buildSystemPrompt('ru');
      expect(p).toContain('Иерархия достоверности');
      expect(p).toContain('sf18_eval');
      expect(p).toContain('sf18_pv');
      expect(p).toContain('главнее всего остального');
      expect(p).toContain('Порядок приоритетов');
    });

    it('обязательная констатация ошибки при mistake/blunder/inaccuracy ИЛИ hanging-фигуре ИЛИ резком ухудшении sf18_eval', () => {
      const p = svc.buildSystemPrompt('ru');
      expect(p).toContain('classification` = mistake/blunder/inaccuracy');
      expect(p).toContain('висящая фигура');
      expect(p).toMatch(/sf18_eval в ПОСЛЕ резко хуже/);
      expect(p).toContain('ОБЯЗАН открываться чёткой констатацией ошибки');
      expect(p).toContain('sf_best');
      expect(p).toContain('threats_missed');
    });

    it('блок про взятие/шах/мат/рокировку/превращение/создание угрозы', () => {
      const p = svc.buildSystemPrompt('ru');
      expect(p).toMatch(/взятие.*шах.*мат.*рокировк.*превращени/);
      expect(p).toContain('threats_created');
      expect(p).toContain('mate_threat_after');
      expect(p).toContain('material_change');
    });

    it('запрет шаблонных зачинов «По форме» / «На доске типичная»', () => {
      const p = svc.buildSystemPrompt('ru');
      expect(p).toContain('Запрещённые шаблонные зачины');
      expect(p).toContain('«По форме позиции»');
      expect(p).toContain('«На доске типичная»');
      expect(p).toContain('«По форме»');
      expect(p).toMatch(/Открывай комментарий конкретикой/);
    });

    it('запрет числовой оценки + словесные шаблоны (как в position-comment)', () => {
      const p = svc.buildSystemPrompt('ru');
      expect(p).toMatch(/Никогда не приводи численное значение общей оценки/);
      expect(p).toContain('сантипешки');
      expect(p).toContain('примерное равенство');
      expect(p).toContain('небольшой перевес');
      expect(p).toContain('заметное преимущество');
      expect(p).toContain('решающее преимущество');
      expect(p).toContain('мат в N');
    });

    it('запрет «слайдер» и предложенные замены', () => {
      const p = svc.buildSystemPrompt('ru');
      expect(p).toContain('Запрещённые слова');
      expect(p).toContain('слайдер');
      expect(p).toContain('фигуры дальнего боя');
      expect(p).toContain('тяжёлые фигуры');
      expect(p).toContain('лёгкие фигуры');
    });

    it('словарь расшифровок (≥5 ключевых id) + запрет технических id', () => {
      const p = svc.buildSystemPrompt('ru');
      expect(p).toContain('Словарь расшифровок');
      expect(p).toContain('Никогда не пиши технический id в ответе');
      const sample: Array<[string, RegExp]> = [
        ['king_danger', /общая опасность королю/],
        ['outpost_knight', /конь на форпосте/],
        ['mobility_rook', /мобильность ладьи/],
        ['rook_on_open_file', /ладья на открытой или полу-открытой линии/],
        ['bishop_pawns', /плохой слон/],
      ];
      for (const [id, ru] of sample) {
        expect(p).toMatch(new RegExp(`-\\s+${id}\\s+→\\s+${ru.source}`));
      }
    });

    it('формат ответа — JSON с comment/highlights/arrows + палитра + ограничения 0..4 / 0..2', () => {
      const p = svc.buildSystemPrompt('ru');
      expect(p).toContain('Формат ответа — ОДИН JSON-объект');
      expect(p).toContain('"comment"');
      expect(p).toContain('"highlights"');
      expect(p).toContain('"arrows"');
      expect(p).toContain('0–4 элемента');
      expect(p).toContain('0–2 элемента');
      expect(p).toContain('red');
      expect(p).toContain('green');
      expect(p).toContain('yellow');
      expect(p).toContain('blue');
      expect(p).toMatch(/blue.*резерв пользователя/);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('buildSystemPrompt — EN', () => {
    const svc = new MoveCommentService(
      makeConfigService({ AI_PROMPT_VARIANT: 'long' }),
      makeRedisStub(),
    );

    it('language="en" — начинается с английской роли', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toMatch(/^You comment on a single played chess move/);
    });

    it('акцент на сравнении BEFORE и AFTER', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toContain('TWO position snapshots');
      expect(p).toContain('BEFORE the move');
      expect(p).toContain('AFTER the move');
      expect(p).toContain('compare BEFORE vs AFTER');
      expect(p).toMatch(/factors grew.*dissolved/);
    });

    it('иерархия достоверности sf18_eval → sf18_pv → статика', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toContain('Hierarchy of truth');
      expect(p).toContain('main source of truth');
      expect(p).toContain('Order of priority');
    });

    it('обязательная констатация ошибки при classification mistake/blunder/inaccuracy / hanging / sharp eval drop', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toContain('classification` is mistake/blunder/inaccuracy');
      expect(p).toContain('hanging piece');
      expect(p).toMatch(/sf18_eval in AFTER is sharply worse/);
      expect(p).toContain('MUST open with a clear statement of the mistake');
      expect(p).toContain('sf_best');
      expect(p).toContain('threats_missed');
    });

    it('блок про capture/check/mate/castling/promotion/creating threat', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toMatch(/capture.*check.*mate.*castling.*promotion/);
      expect(p).toContain('threats_created');
      expect(p).toContain('mate_threat_after');
      expect(p).toContain('material_change');
    });

    it('запрет шаблонных зачинов «By the form» / «A typical position»', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toContain('Forbidden template openings');
      expect(p).toContain('"By the form of the position"');
      expect(p).toContain('"A typical position"');
      expect(p).toMatch(/Open with concrete content tied to THIS move/);
    });

    it('запрет числовой оценки + словесные шаблоны', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toContain('Never quote the numeric evaluation');
      expect(p).toContain('centipawns');
      expect(p).toContain('roughly equal');
      expect(p).toContain('slight edge');
      expect(p).toContain('clear advantage');
      expect(p).toContain('decisive advantage');
      expect(p).toContain('mate in N');
    });

    it('запрет «slider» и предложенные замены', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toContain('Forbidden words');
      expect(p).toContain('slider');
      expect(p).toContain('long-range pieces');
      expect(p).toContain('major pieces');
      expect(p).toContain('minor pieces');
    });

    it('словарь расшифровок (≥5 ключевых id)', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toContain('Glossary');
      const sample: Array<[string, RegExp]> = [
        ['king_danger', /overall king danger/],
        ['outpost_knight', /knight on an outpost/],
        ['mobility_rook', /rook mobility/],
        ['rook_on_open_file', /rook on \(semi-\)open file/],
        ['bishop_pawns', /bad bishop/],
      ];
      for (const [id, en] of sample) {
        expect(p).toMatch(new RegExp(`-\\s+${id}\\s+→\\s+${en.source}`));
      }
    });

    it('формат ответа — JSON + палитра', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toContain('Output format — ONE JSON object');
      expect(p).toContain('"comment"');
      expect(p).toContain('"highlights"');
      expect(p).toContain('"arrows"');
      expect(p).toContain('0–4 items');
      expect(p).toContain('0–2 items');
      expect(p).toContain('blue — reserved for the user');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('buildSystemPrompt — общие проверки', () => {
    const svc = new MoveCommentService(
      makeConfigService({ AI_PROMPT_VARIANT: 'long' }),
      makeRedisStub(),
    );

    it('без преамбул в стиле CRITICAL RULES / FORBIDDEN / few-shot / ELO', () => {
      const ru = svc.buildSystemPrompt('ru');
      const en = svc.buildSystemPrompt('en');
      for (const p of [ru, en]) {
        expect(p).not.toContain('CRITICAL RULES');
        expect(p).not.toContain('few-shot');
        expect(p).not.toContain('ELO');
        // KS-3711: с учётом словаря (~3.3 КБ) и иерархии (~1.3 КБ) +
        // блок про комментирование сыгранного хода — общий объём
        // близок к position-comment'у. Верхнюю границу ставим 12 КБ
        // с запасом.
        expect(p.length).toBeLessThan(12000);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('KS-3814: сжатая (short) системная инструкция — по умолчанию', () => {
    const svc = new MoveCommentService(
      makeConfigService({}), // без переменной → short
      makeRedisStub(),
    );

    it('short — ≤80 строк после join (без словаря)', () => {
      // Считаем строки на пустом словаре — usedIds=пустой Set даёт
      // glossary='', чтобы измерить именно текст инструкции.
      const empty = new Set<string>();
      const ru = svc.buildSystemPrompt('ru', empty);
      const en = svc.buildSystemPrompt('en', empty);
      // Каждая строка после join = строка инструкции (включая пустые
      // разделители). Цель KS-3814 — ≤80 строк инструкции.
      expect(ru.split('\n').length).toBeLessThanOrEqual(80);
      expect(en.split('\n').length).toBeLessThanOrEqual(80);
    });

    it('short — содержит все обязательные блоки (cp→вердикт, иерархия, запреты, JSON)', () => {
      const p = svc.buildSystemPrompt('ru');
      // Соответствие cp → вердикт.
      expect(p).toMatch(/Соответствие cp → вердикт/);
      expect(p).toMatch(/равенство/);
      expect(p).toMatch(/небольшой перевес/);
      expect(p).toMatch(/заметное преимущество/);
      expect(p).toMatch(/решающее преимущество/);
      expect(p).toMatch(/мат в N/);
      // Иерархия.
      expect(p).toMatch(/Иерархия/);
      expect(p).toContain('sf18_eval');
      // Запреты.
      expect(p).toMatch(/ЗАПРЕЩЕНО/);
      expect(p).toContain('перевод коня на');
      expect(p).toContain('слайдер');
      expect(p).toMatch(/По форме позиции/);
      // Блок про комментирование хода — обязательная констатация ошибки.
      expect(p).toContain('classification` = mistake/blunder/inaccuracy');
      expect(p).toContain('висящая фигура');
      expect(p).toContain('ОБЯЗАН открываться');
      // Формат JSON.
      expect(p).toContain('Формат ответа — ОДИН JSON-объект');
      expect(p).toContain('"comment"');
      expect(p).toContain('"highlights"');
      expect(p).toContain('"arrows"');
    });

    it('short EN — содержит соответствие cp→verdict, иерархию, запреты, JSON', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toMatch(/Mapping sf18_eval → verdict/);
      expect(p).toMatch(/roughly equal/);
      expect(p).toMatch(/slight edge/);
      expect(p).toMatch(/clear advantage/);
      expect(p).toMatch(/decisive advantage/);
      expect(p).toMatch(/mate in N/);
      expect(p).toMatch(/Hierarchy/);
      expect(p).toMatch(/FORBIDDEN/);
      expect(p).toContain("classification` is mistake/blunder/inaccuracy");
      expect(p).toContain('hanging piece');
      expect(p).toContain('MUST open with a clear statement');
      expect(p).toContain('Output format — ONE JSON object');
    });

    it('short — не содержит обучающий пример cp=-665 (он в JSDoc, не в инструкции для модели)', () => {
      const ru = svc.buildSystemPrompt('ru');
      const en = svc.buildSystemPrompt('en');
      for (const p of [ru, en]) {
        expect(p).not.toContain('cp=-665');
        expect(p).not.toContain('лишняя фигура');
        expect(p).not.toContain('extra piece');
      }
    });

    it('short — sf18_pv в инструкции не упоминается (фактор вырезан в payload, KS-3809)', () => {
      const ru = svc.buildSystemPrompt('ru');
      const en = svc.buildSystemPrompt('en');
      for (const p of [ru, en]) {
        expect(p).not.toContain('sf18_pv');
      }
    });

    it('AI_PROMPT_VARIANT=long → возвращается прежняя расширенная инструкция', () => {
      const longSvc = new MoveCommentService(
        makeConfigService({ AI_PROMPT_VARIANT: 'long' }),
        makeRedisStub(),
      );
      const p = longSvc.buildSystemPrompt('ru');
      // Long-вариант сохранил блок «Иерархия достоверности» и
      // эталонные KS-3711 формулировки про sf18_pv (он там был).
      expect(p).toContain('Иерархия достоверности');
      expect(p).toContain('sf18_pv');
      expect(p).toContain('Порядок приоритетов');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('comment() — graceful degradation', () => {
    it('без AI_CHAT_WEBHOOK_URL → пустой ответ, fetch не вызывается', async () => {
      const svc = new MoveCommentService(
        makeConfigService({}),
        makeRedisStub(),
      );
      const spy = jest.fn();
      global.fetch = spy as any;

      const result = await svc.comment('user-1', makeDto());
      expect(result).toEqual({ comment: '', highlights: [], arrows: [] });
      expect(spy).not.toHaveBeenCalled();
    });

    it('webhook 5xx → пустой ответ, без 5xx наружу', async () => {
      const svc = new MoveCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      global.fetch = jest.fn(async () => ({
        status: 502,
        headers: { get: () => 'text/plain' },
        text: async () => 'upstream broken',
        json: async () => null,
      })) as any;

      const result = await svc.comment('user-1', makeDto());
      expect(result).toEqual({ comment: '', highlights: [], arrows: [] });
    });

    it('webhook невалидный JSON в comment → fallback на raw в comment', async () => {
      const svc = new MoveCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      global.fetch = jest.fn(async () => ({
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ response: 'просто текстовый ответ' }),
        text: async () => '',
      })) as any;

      const result = await svc.comment('user-1', makeDto());
      // parseModelOutput пускает raw в comment, если JSON.parse упал.
      expect(result.comment).toBe('просто текстовый ответ');
      expect(result.highlights).toEqual([]);
      expect(result.arrows).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('comment() — webhook payload (KS-3711)', () => {
    it('payload содержит move, before, after — целиком и в том же порядке полей', async () => {
      const svc = new MoveCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      const captured: { body?: string } = {};
      global.fetch = jest.fn(async (_url: string, init: any) => {
        captured.body = init.body;
        return {
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({
            response:
              '{"comment":"5...Be6 — слон уходит под удар пешки d5; после dxe6 чёрные просто теряют фигуру.","highlights":[{"square":"e6","color":"red"}],"arrows":[]}',
          }),
          text: async () => '',
        };
      }) as any;

      const result = await svc.comment('user-1', makeDto());
      expect(result.comment).toMatch(/Be6/);
      expect(result.highlights).toEqual([{ square: 'e6', color: 'red' }]);

      // payload-уровень — поля присутствуют и идут через webhook.
      const body = JSON.parse(captured.body!);
      expect(body.userId).toBe('user-1');
      expect(body.noMcp).toBe(true);
      // Системная инструкция дублируется в message (KS-3694).
      expect(body.message).toMatch(/^Ты комментируешь ОДИН сыгранный/);
      // Данные сериализуются в JSON в конце сообщения.
      expect(body.message).toContain('"move"');
      expect(body.message).toContain('"before"');
      expect(body.message).toContain('"after"');
      expect(body.message).toContain('Be6');
      expect(body.message).toContain('blunder');
    });

    it('KS-3809: sf18_pv вырезается из before.factors и after.factors перед отправкой модели; остальные факторы и terminal_value_* сохраняются', async () => {
      const svc = new MoveCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      const captured: { body?: string } = {};
      global.fetch = jest.fn(async (_url: string, init: any) => {
        captured.body = init.body;
        return {
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({
            response: '{"comment":"ok","highlights":[],"arrows":[]}',
          }),
          text: async () => '',
        };
      }) as any;

      const dto = makeDto({
        before: {
          fen: 'r1bqkb1r/ppp2ppp/2n2n2/3PQ3/4P3/8/PPP2PPP/RNB1KBNR b KQkq - 1 5',
          factors: [
            { id: 'sf18_eval', score: { type: 'cp', value: 25 } },
            { id: 'sf18_pv', moves: ['c8e6', 'd5e6', 'f7e6'] },
            { id: 'material', value_mg: 0.5, value_eg: 0.5 },
            {
              id: 'mobility_rook',
              value_mg: 0.1,
              value_eg: 0.05,
              terminal_value_mg: 0.3,
              terminal_value_eg: 0.2,
            },
          ],
        },
        after: {
          fen: 'r2qkb1r/ppp2ppp/2n1bn2/3PQ3/4P3/8/PPP2PPP/RNB1KBNR w KQkq - 2 6',
          factors: [
            { id: 'sf18_eval', score: { type: 'cp', value: 320 } },
            { id: 'sf18_pv', moves: ['d5e6', 'f7e6', 'e5e6'] },
            { id: 'material', value_mg: 0.5, value_eg: 0.5 },
          ],
        },
      });
      await svc.comment('user-1', dto);

      const body = JSON.parse(captured.body!);
      const m = String(body.message).match(
        /Исходные данные \(JSON\):\n([\s\S]+)$/,
      );
      expect(m).not.toBeNull();
      const data = JSON.parse((m as RegExpMatchArray)[1]);

      // sf18_pv вырезан в обоих снимках, порядок остальных сохранён.
      const beforeIds = (data.before.factors as Array<{ id: string }>).map(
        (f) => f.id,
      );
      const afterIds = (data.after.factors as Array<{ id: string }>).map(
        (f) => f.id,
      );
      expect(beforeIds).toEqual(['sf18_eval', 'material', 'mobility_rook']);
      expect(afterIds).toEqual(['sf18_eval', 'material']);

      // terminal_value_* у статической подкомпоненты сохраняется —
      // тенденция остаётся доступной модели без знания самой линии.
      expect(JSON.stringify(data.before.factors)).toContain('terminal_value_mg');

      // В подаваемых данных от модели sf18_pv нет полностью —
      // ни id, ни UCI-ходов из ни одного снимка.
      const factorsJson =
        JSON.stringify(data.before.factors) +
        JSON.stringify(data.after.factors);
      expect(factorsJson).not.toContain('sf18_pv');
      expect(factorsJson).not.toContain('c8e6');
      expect(factorsJson).not.toContain('d5e6');
      expect(factorsJson).not.toContain('f7e6');
      expect(factorsJson).not.toContain('e5e6');
    });

    it('KS-3813: в systemPrompt уходит словарь только из id, реально пришедших в before/after factors', async () => {
      const svc = new MoveCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      const captured: { body?: string } = {};
      global.fetch = jest.fn(async (_url: string, init: any) => {
        captured.body = init.body;
        return {
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({
            response: '{"comment":"ok","highlights":[],"arrows":[]}',
          }),
          text: async () => '',
        };
      }) as any;

      const dto = makeDto({
        before: {
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          factors: [
            { id: 'sf18_eval', score: { type: 'cp', value: 0 } },
            { id: 'sf18_pv', moves: ['e2e4'] },
            { id: 'material', value_mg: 0.3, value_eg: 0.2 },
          ],
        },
        after: {
          fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
          factors: [
            { id: 'sf18_eval', score: { type: 'cp', value: 18 } },
            { id: 'space', value_mg: 0.05, value_eg: 0 },
          ],
        },
      });
      await svc.comment('user-1', dto);

      const body = JSON.parse(captured.body!);
      // Объединение пришедших id из SUBTERM_LABELS — material и space.
      expect(body.systemPrompt).toMatch(/^-\s+material\s+→/m);
      expect(body.systemPrompt).toMatch(/^-\s+space\s+→/m);
      // Неиспользуемые id из SUBTERM_LABELS отсутствуют как строки словаря.
      // Проверка по строке «- <id> →»: id могут встретиться в инструкции
      // как пример запрета писать технические id в ответе.
      expect(body.systemPrompt).not.toMatch(/^-\s+king_danger\s+→/m);
      expect(body.systemPrompt).not.toMatch(/^-\s+outpost_knight\s+→/m);
      expect(body.systemPrompt).not.toMatch(/^-\s+rook_on_open_file\s+→/m);
      expect(body.systemPrompt).not.toMatch(/^-\s+bishop_pawns\s+→/m);
      expect(body.systemPrompt).not.toMatch(/^-\s+passed_rank\s+→/m);
      // sf18_eval / sf18_pv не из SUBTERM_LABELS — в словаре их нет.
      expect(body.systemPrompt).not.toMatch(/^-\s+sf18_eval\s+→/m);
      expect(body.systemPrompt).not.toMatch(/^-\s+sf18_pv\s+→/m);
    });

    it('KS-3813: buildSystemPrompt без usedIds — полный словарь (backward-compat)', () => {
      const svc = new MoveCommentService(
        makeConfigService({}),
        makeRedisStub(),
      );
      const p = svc.buildSystemPrompt('ru');
      // Полный словарь — все ключевые id видны как строки «- <id> →».
      expect(p).toMatch(/^-\s+king_danger\s+→/m);
      expect(p).toMatch(/^-\s+outpost_knight\s+→/m);
      expect(p).toMatch(/^-\s+mobility_rook\s+→/m);
      expect(p).toMatch(/^-\s+rook_on_open_file\s+→/m);
      expect(p).toMatch(/^-\s+bishop_pawns\s+→/m);
      expect(p).toMatch(/^-\s+material\s+→/m);
    });

    it('KS-3813: buildSystemPrompt с usedIds — только пересечение с SUBTERM_LABELS', () => {
      const svc = new MoveCommentService(
        makeConfigService({}),
        makeRedisStub(),
      );
      const p = svc.buildSystemPrompt(
        'ru',
        new Set(['material', 'space', 'sf18_eval']),
      );
      expect(p).toMatch(/^-\s+material\s+→/m);
      expect(p).toMatch(/^-\s+space\s+→/m);
      expect(p).not.toMatch(/^-\s+king_danger\s+→/m);
      expect(p).not.toMatch(/^-\s+outpost_knight\s+→/m);
      // sf18_eval в SUBTERM_LABELS нет — в словаре отсутствует.
      expect(p).not.toMatch(/^-\s+sf18_eval\s+→/m);
    });

    it('language=en → инструкция на английском', async () => {
      const svc = new MoveCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      const captured: { body?: string } = {};
      global.fetch = jest.fn(async (_url: string, init: any) => {
        captured.body = init.body;
        return {
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({
            response:
              '{"comment":"5...Be6 hangs the bishop.","highlights":[],"arrows":[]}',
          }),
          text: async () => '',
        };
      }) as any;

      await svc.comment('user-1', makeDto({ language: 'en' }));
      const body = JSON.parse(captured.body!);
      expect(body.message).toMatch(/^You comment on a single played chess move/);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  describe('Rate-limit (KS-3711 — отдельные ключи review-move:rate:*)', () => {
    it('checkRateLimit использует ключи review-move:rate:* и не бросает при пустом счётчике', async () => {
      const redis = makeRedisStub();
      const svc = new MoveCommentService(makeConfigService({}), redis);

      await expect(svc.checkRateLimit('user-1')).resolves.toBeUndefined();
      const usedKeys = redis.get.mock.calls.map((call: any[]) => call[0]);
      expect(usedKeys).toEqual(
        expect.arrayContaining([
          'review-move:rate:min:user-1',
          'review-move:rate:day:user-1',
        ]),
      );
      expect(
        usedKeys.some((k: string) => k.startsWith('review-move:rate:global:')),
      ).toBe(true);
    });

    it('per-minute лимит 60 → 60-й запрос проходит, 61-й бросает 429', async () => {
      const overLimit = makeRedisStub({
        'review-move:rate:min:user-1': '60',
      });
      const svc = new MoveCommentService(makeConfigService({}), overLimit);
      await expect(svc.checkRateLimit('user-1')).rejects.toMatchObject({
        getStatus: expect.any(Function),
      });
      await expect(svc.checkRateLimit('user-1')).rejects.toBeInstanceOf(
        HttpException,
      );
      try {
        await svc.checkRateLimit('user-1');
      } catch (e) {
        const httpEx = e as HttpException;
        expect(httpEx.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        const body = httpEx.getResponse() as Record<string, unknown>;
        expect(body.error).toBe('rate_limit');
      }
    });

    it('per-day лимит 600 — лимит виден в конструкторе', () => {
      const svc = new MoveCommentService(makeConfigService({}), makeRedisStub());
      expect(svc.rateLimitPerMin).toBe(60);
      expect(svc.rateLimitPerDay).toBe(600);
      expect(svc.globalDailyLimit).toBe(5000);
    });

    it('конфиг через env переопределяет дефолтные значения', () => {
      const svc = new MoveCommentService(
        makeConfigService({
          MOVE_COMMENT_RATE_LIMIT_PER_MIN: '120',
          MOVE_COMMENT_RATE_LIMIT_PER_DAY: '1200',
          MOVE_COMMENT_GLOBAL_DAILY_LIMIT: '10000',
        }),
        makeRedisStub(),
      );
      expect(svc.rateLimitPerMin).toBe(120);
      expect(svc.rateLimitPerDay).toBe(1200);
      expect(svc.globalDailyLimit).toBe(10000);
    });
  });
});
