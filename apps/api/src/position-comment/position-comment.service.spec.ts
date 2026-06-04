/**
 * KS-3681 / ADR-108 §11 B1. Unit-тесты PositionCommentService.
 *
 * Покрытие:
 *  - buildSystemPrompt: две короткие версии (RU/EN) и дефолт RU при
 *    отсутствии поля `language`.
 *  - comment: при `factors.length === 0` — мгновенный пустой ответ
 *    без обращения к webhook'у (early-return, ADR-108 §5.3).
 *  - comment: при наличии факторов — webhook вызывается, получает
 *    инструкцию в нужной локали.
 *  - graceful degradation: webhook не настроен → пустой ответ.
 *
 * Webhook'овые вызовы делаются через глобальный `fetch` — мокаем
 * `global.fetch` напрямую. RedisService — stub (не задействован
 * в этих тестах, т.к. rate-limit вызывается из контроллера).
 */
import { ConfigService } from '@nestjs/config';
import { PositionCommentService } from './position-comment.service';
import type { PositionCommentDto } from './dto/position-comment.dto';

type ConfigMap = Record<string, string>;

function makeConfigService(values: ConfigMap = {}): ConfigService {
  return {
    get: (key: string, fallback?: unknown) =>
      values[key] !== undefined ? values[key] : fallback,
  } as unknown as ConfigService;
}

function makeRedisStub() {
  return {
    get: jest.fn(async () => null),
    set: jest.fn(),
    pipeline: jest.fn(() => ({
      incr: () => ({} as any),
      expire: () => ({} as any),
      exec: async () => [],
    })),
  } as any;
}

function makeDto(overrides: Partial<PositionCommentDto> = {}): PositionCommentDto {
  return {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    factors: [{ id: 'material', color: 'w', value_mg: 0.34, value_eg: 0.19 }],
    ...overrides,
  };
}

describe('PositionCommentService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  describe('buildSystemPrompt (KS-3681 / ADR-108 §8.2 + KS-3686)', () => {
    const svc = new PositionCommentService(
      makeConfigService({}),
      makeRedisStub(),
    );

    it('RU при вызове без аргумента — дефолт', () => {
      const p = svc.buildSystemPrompt();
      expect(p).toMatch(
        /^Прокомментируй пожалуйста позицию человеческим языком на основании факторов\./,
      );
    });

    it('RU при явном language=ru — то же что без аргумента', () => {
      expect(svc.buildSystemPrompt('ru')).toBe(svc.buildSystemPrompt());
    });

    it('EN при language=en начинается с инструкции на английском', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toMatch(
        /^Please comment on this chess position in plain language using the given positional factors\./,
      );
    });

    it('KS-3686 RU: упоминает sf18_eval и sf18_pv, их формат и обязательность отразить', () => {
      const p = svc.buildSystemPrompt('ru');
      expect(p).toContain('sf18_eval');
      expect(p).toContain('sf18_pv');
      expect(p).toContain('Stockfish 18');
      // Тип cp и mate должны быть упомянуты с пояснением.
      expect(p).toContain('cp');
      expect(p).toContain('mate');
      expect(p).toContain('side_to_move');
      expect(p).toContain('UCI');
      // Обязательность отразить + перевод в слова + план.
      expect(p).toContain('ОБЯЗАТЕЛЬНО');
      expect(p).toContain('план');
      // Backward-compat подсказка.
      expect(p).toMatch(/Если их нет/);
    });

    it('KS-3686 RU: явный запрет числовой оценки + словесные шаблоны', () => {
      const p = svc.buildSystemPrompt('ru');
      // Запрет на численное значение общей оценки.
      expect(p).toContain('никогда не приводи численное значение общей оценки');
      expect(p).toContain('сантипешки');
      // Перечень разрешённых словесных формул.
      expect(p).toContain('примерное равенство');
      expect(p).toContain('небольшой перевес');
      expect(p).toContain('заметное преимущество');
      expect(p).toContain('решающее преимущество');
      expect(p).toContain('мат в N');
    });

    it('KS-3689 RU: словарь расшифровок (≥5 ключевых id) + запрет технических id', () => {
      const p = svc.buildSystemPrompt('ru');
      // Заголовок словаря и общее правило про запрет id в тексте.
      expect(p).toContain('Словарь расшифровок');
      expect(p).toContain('Никогда не пиши технический id в ответе');
      // 5+ ключевых строк-расшифровок: маркер + id + стрелка + RU-имя.
      const sample: Array<[string, RegExp]> = [
        ['king_danger', /общая опасность королю/],
        ['outpost_knight', /конь на форпосте/],
        ['mobility_rook', /мобильность ладьи/],
        ['king_attackers_count', /количество фигур, атакующих короля/],
        ['king_attackers_weight', /суммарный вес атакующих короля фигур/],
        ['rook_on_open_file', /ладья на открытой или полу-открытой линии/],
        ['bishop_pawns', /плохой слон/],
      ];
      for (const [id, ru] of sample) {
        expect(p).toMatch(new RegExp(`-\\s+${id}\\s+→\\s+${ru.source}`));
      }
    });

    it('KS-3689 RU: запрет сырых чисел подкомпонент и словесные замены', () => {
      const p = svc.buildSystemPrompt('ru');
      expect(p).toContain('Никогда не приводи сырые числовые значения подкомпонент');
      // Технические имена полей подкомпонент должны быть упомянуты в запрете.
      expect(p).toContain('value_mg');
      expect(p).toContain('value_eg');
      // Словесные шаблоны замены.
      expect(p).toContain('едва заметно');
      expect(p).toContain('заметно');
      expect(p).toContain('резко вырос');
      expect(p).toContain('стал максимальным в позиции');
      expect(p).toContain('больше всего');
    });

    it('KS-3689 RU: запрет «слайдер» и предложенные замены', () => {
      const p = svc.buildSystemPrompt('ru');
      expect(p).toContain('Запрещённые слова');
      expect(p).toContain('слайдер');
      expect(p).toContain('фигуры дальнего боя');
      expect(p).toContain('тяжёлые фигуры');
      expect(p).toContain('лёгкие фигуры');
    });

    it('KS-3697 RU: блок иерархии достоверности sf18_eval/sf18_pv vs статика', () => {
      const p = svc.buildSystemPrompt('ru');
      expect(p).toContain('Иерархия достоверности');
      expect(p).toContain('главнее всего остального');
      expect(p).toContain('тактически опровергнут');
      // Перечень разрешённых оговорок.
      expect(p).toContain('формально');
      expect(p).toContain('структурно');
      expect(p).toContain('на первый взгляд');
      expect(p).toContain('Stockfish не считает это преимуществом');
      // Правило сверки с sf18_pv.
      expect(p).toContain('Сверка с sf18_pv');
      expect(p).toMatch(/соперник.*забирает/);
      // Порядок приоритетов.
      expect(p).toContain('Порядок приоритетов');
      // Конкретный пример с проходной (как в задаче пользователя).
      expect(p).toMatch(/проходная.*равную.*забирают/);
    });

    it('KS-3686 EN: упоминает sf18_eval и sf18_pv, формат и обязательность отразить', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toContain('sf18_eval');
      expect(p).toContain('sf18_pv');
      expect(p).toContain('Stockfish 18');
      expect(p).toContain('cp');
      expect(p).toContain('mate');
      expect(p).toContain('side_to_move');
      expect(p).toContain('UCI');
      expect(p).toMatch(/MUST reflect both/);
      expect(p).toContain('plan');
      expect(p).toMatch(/When they are absent/);
    });

    it('KS-3686 EN: явный запрет числовой оценки + словесные шаблоны', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toContain('Never quote the numeric evaluation');
      expect(p).toContain('centipawns');
      expect(p).toContain('roughly equal');
      expect(p).toContain('slight edge');
      expect(p).toContain('clear advantage');
      expect(p).toContain('decisive advantage');
      expect(p).toContain('mate in N');
    });

    it('KS-3689 EN: словарь расшифровок (≥5 ключевых id) + запрет технических id', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toContain('Glossary');
      expect(p).toContain('Never put a technical id in the answer');
      const sample: Array<[string, RegExp]> = [
        ['king_danger', /overall king danger/],
        ['outpost_knight', /knight on an outpost/],
        ['mobility_rook', /rook mobility/],
        ['king_attackers_count', /count of pieces attacking the king/],
        ['king_attackers_weight', /total weight of pieces attacking the king/],
        ['rook_on_open_file', /rook on \(semi-\)open file/],
        ['bishop_pawns', /bad bishop/],
      ];
      for (const [id, en] of sample) {
        expect(p).toMatch(new RegExp(`-\\s+${id}\\s+→\\s+${en.source}`));
      }
    });

    it('KS-3689 EN: запрет сырых чисел подкомпонент и словесные замены', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toContain('Never quote raw numeric values of subterms');
      expect(p).toContain('value_mg');
      expect(p).toContain('value_eg');
      expect(p).toContain('barely noticeable');
      expect(p).toContain('sharply increased');
      expect(p).toContain('the highest in the position');
      expect(p).toContain('the most');
    });

    it('KS-3689 EN: запрет «slider» и предложенные замены', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toContain('Forbidden word');
      expect(p).toContain('slider');
      expect(p).toContain('long-range pieces');
      expect(p).toContain('major pieces');
      expect(p).toContain('minor pieces');
    });

    it('KS-3697 EN: блок иерархии достоверности sf18_eval/sf18_pv vs static', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toContain('Hierarchy of truth');
      expect(p).toContain('main source of truth');
      expect(p).toContain('tactically refuted');
      // Перечень разрешённых оговорок.
      expect(p).toContain('nominally');
      expect(p).toContain('structurally');
      expect(p).toContain('on the surface');
      expect(p).toContain('Stockfish does not see this as an advantage');
      // Правило сверки с sf18_pv.
      expect(p).toContain('Check sf18_pv');
      expect(p).toMatch(/opponent.*captures/);
      // Порядок приоритетов.
      expect(p).toContain('Order of priority');
      // Конкретный пример.
      expect(p).toMatch(/passed pawn.*equal.*takes that pawn/);
    });

    it('обе версии — без преамбул в стиле CRITICAL RULES / FORBIDDEN / few-shot', () => {
      const ru = svc.buildSystemPrompt('ru');
      const en = svc.buildSystemPrompt('en');
      for (const p of [ru, en]) {
        expect(p).not.toContain('CRITICAL RULES');
        expect(p).not.toContain('FORBIDDEN');
        expect(p).not.toContain('ЗАПРЕЩЕНО');
        expect(p).not.toContain('few-shot');
        expect(p).not.toContain('ELO');
        // KS-3689: словарь расшифровок ~3.3 КБ. KS-3697: блок про
        // иерархию достоверности добавил ещё ~1.3 КБ. Верхнюю границу
        // подняли до 7.5 КБ. Это всё ещё короче, чем V2-prompt'ы из
        // старого review-comment (~10 КБ с few-shot).
        expect(p.length).toBeLessThan(7500);
      }
    });
  });

  describe('comment — пустой factors (KS-3681 / ADR-108 §5.3, KS-3690 шейп)', () => {
    it('factors=[] → возвращает шейп с пустым comment без вызова webhook', async () => {
      const svc = new PositionCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      const spy = jest.fn();
      global.fetch = spy as any;

      const result = await svc.comment(
        'user-1',
        makeDto({ factors: [] }),
      );
      expect(result).toEqual({ comment: '', highlights: [], arrows: [] });
      expect(spy).not.toHaveBeenCalled();
    });

    it('factors=[] и без webhookUrl → тот же шейп без вызова', async () => {
      const svc = new PositionCommentService(
        makeConfigService({}),
        makeRedisStub(),
      );
      const spy = jest.fn();
      global.fetch = spy as any;

      const result = await svc.comment(
        'user-1',
        makeDto({ factors: [] }),
      );
      expect(result).toEqual({ comment: '', highlights: [], arrows: [] });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('comment — webhook получает инструкцию в нужной локали', () => {
    it('language=en → systemPrompt в payload — EN (содержит sf18_eval/pv-инструкцию)', async () => {
      const svc = new PositionCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      let captured: any = null;
      global.fetch = jest.fn(async (_url: any, init: any) => {
        captured = JSON.parse(init.body);
        // KS-3690: модель отдаёт JSON-шейп; сервис парсит и возвращает.
        return new Response(
          JSON.stringify({
            response: JSON.stringify({
              comment: 'comment text',
              highlights: [],
              arrows: [],
            }),
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }) as any;

      const result = await svc.comment(
        'user-1',
        makeDto({ language: 'en' }),
      );
      expect(result).toEqual({
        comment: 'comment text',
        highlights: [],
        arrows: [],
      });
      expect(captured.systemPrompt).toMatch(
        /^Please comment on this chess position in plain language/,
      );
      expect(captured.systemPrompt).toContain('sf18_eval');
      expect(captured.systemPrompt).toContain('sf18_pv');
    });

    it('language=ru → systemPrompt в payload — RU (содержит sf18_eval/pv-инструкцию)', async () => {
      const svc = new PositionCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      let captured: any = null;
      global.fetch = jest.fn(async (_url: any, init: any) => {
        captured = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            response: JSON.stringify({ comment: 'комментарий' }),
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }) as any;

      await svc.comment('user-1', makeDto({ language: 'ru' }));
      expect(captured.systemPrompt).toMatch(
        /^Прокомментируй пожалуйста позицию человеческим языком/,
      );
      expect(captured.systemPrompt).toContain('sf18_eval');
      expect(captured.systemPrompt).toContain('sf18_pv');
    });

    it('без поля language → RU (backward-compat)', async () => {
      const svc = new PositionCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      let captured: any = null;
      global.fetch = jest.fn(async (_url: any, init: any) => {
        captured = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            response: JSON.stringify({ comment: 'комментарий' }),
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }) as any;

      const dto = makeDto();
      delete dto.language;
      await svc.comment('user-1', dto);
      expect(captured.systemPrompt).toMatch(
        /^Прокомментируй пожалуйста позицию человеческим языком/,
      );
    });

    it('KS-3686 backward-compat: factors без sf18_* — запрос уходит как раньше', async () => {
      const svc = new PositionCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      let captured: any = null;
      global.fetch = jest.fn(async (_url: any, init: any) => {
        captured = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            response: JSON.stringify({ comment: 'без линии' }),
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }) as any;

      // Только классические факторы без sf18_eval/sf18_pv.
      const dto = makeDto({
        factors: [{ id: 'space', value_mg: 0.05, value_eg: 0 }],
      });
      const result = await svc.comment('user-1', dto);
      expect(result).toEqual({
        comment: 'без линии',
        highlights: [],
        arrows: [],
      });
      // В payload нет sf18_*, но инструкция всё равно содержит описание —
      // модель сама поймёт что этих факторов нет и комментирует по
      // остальным (см. фразу «Если их нет — комментируй только…»).
      // KS-3694: message теперь — это «инструкция + JSON-блок данных».
      // Чтобы проверить состав factors, выдёргиваем JSON-блок после
      // «Исходные данные (JSON):». В нём не должно быть sf18_*.
      const m = String(captured.message).match(
        /Исходные данные \(JSON\):\n([\s\S]+)$/,
      );
      expect(m).not.toBeNull();
      const data = JSON.parse((m as RegExpMatchArray)[1]);
      expect(JSON.stringify(data.factors)).not.toContain('sf18_eval');
      expect(JSON.stringify(data.factors)).not.toContain('sf18_pv');
    });
  });

  describe('comment — JSON-шейп с overlay (KS-3690)', () => {
    it('модель отдала JSON с highlights и arrows → распарсены и возвращены', async () => {
      const svc = new PositionCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      global.fetch = jest.fn(async () =>
        new Response(
          JSON.stringify({
            response: JSON.stringify({
              comment: 'Слон сильный, ферзь под боем.',
              highlights: [
                { square: 'd5', color: 'yellow' },
                { square: 'c5', color: 'red' },
              ],
              arrows: [{ from: 'e2', to: 'e4', color: 'green' }],
            }),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ) as any;

      const result = await svc.comment('user-1', makeDto());
      expect(result.comment).toBe('Слон сильный, ферзь под боем.');
      expect(result.highlights).toEqual([
        { square: 'd5', color: 'yellow' },
        { square: 'c5', color: 'red' },
      ]);
      expect(result.arrows).toEqual([
        { from: 'e2', to: 'e4', color: 'green' },
      ]);
    });

    it('модель отдала чистый текст без JSON → comment = raw, массивы пустые', async () => {
      const svc = new PositionCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      global.fetch = jest.fn(async () =>
        new Response(
          JSON.stringify({ response: 'просто текст без структуры' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ) as any;

      const result = await svc.comment('user-1', makeDto());
      expect(result).toEqual({
        comment: 'просто текст без структуры',
        highlights: [],
        arrows: [],
      });
    });
  });

  describe('comment — graceful degradation (KS-3690 шейп)', () => {
    it('webhookUrl пуст → шейп с пустым comment без обращения', async () => {
      const svc = new PositionCommentService(
        makeConfigService({}),
        makeRedisStub(),
      );
      const spy = jest.fn();
      global.fetch = spy as any;
      const result = await svc.comment('user-1', makeDto());
      expect(result).toEqual({ comment: '', highlights: [], arrows: [] });
      expect(spy).not.toHaveBeenCalled();
    });

    it('webhook 5xx → шейп с пустым comment (fallback)', async () => {
      const svc = new PositionCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      global.fetch = jest.fn(async () =>
        new Response('upstream broken', {
          status: 502,
          headers: { 'content-type': 'text/plain' },
        }),
      ) as any;
      const result = await svc.comment('user-1', makeDto());
      expect(result).toEqual({ comment: '', highlights: [], arrows: [] });
    });
  });

  describe('buildSystemPrompt (KS-3690 ADR-108b §5.1) — JSON-формат ответа', () => {
    const svc = new PositionCommentService(
      makeConfigService({}),
      makeRedisStub(),
    );

    it('RU: содержит блок про JSON-формат, цветовую конвенцию и лимиты', () => {
      const p = svc.buildSystemPrompt('ru');
      expect(p).toContain('Формат ответа — ОДИН JSON-объект');
      expect(p).toContain('"comment"');
      expect(p).toContain('"highlights"');
      expect(p).toContain('"arrows"');
      expect(p).toContain('0–4 элемента');
      expect(p).toContain('0–2 элемента');
      expect(p).toContain('Цветовая конвенция');
      expect(p).toContain('red — слабость / угроза');
      expect(p).toContain('green — рекомендуемый план');
      expect(p).toContain('yellow — ключевая идея');
      expect(p).toContain('blue — резерв пользователя');
      expect(p).toContain('Не оборачивай JSON в код-fences');
    });

    it('EN: содержит блок про JSON-формат, цветовую конвенцию и лимиты', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toContain('Output format — ONE JSON object');
      expect(p).toContain('"comment"');
      expect(p).toContain('"highlights"');
      expect(p).toContain('"arrows"');
      expect(p).toContain('0–4 items');
      expect(p).toContain('0–2 items');
      expect(p).toContain('Color convention');
      expect(p).toContain('red — weakness / threat');
      expect(p).toContain('green — recommended plan');
      expect(p).toContain('yellow — key idea');
      expect(p).toContain('blue — reserved for the user');
      expect(p).toContain('Do not wrap the JSON in code fences');
    });
  });
});
