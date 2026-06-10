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
import { Logger } from '@nestjs/common';
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
    // KS-3814: эти проверки заточены под расширенную (long) версию
    // инструкции с эталонными KS-3686/KS-3697/KS-3700/KS-3727
    // формулировками. Long-вариант оставлен под ENV
    // `AI_PROMPT_VARIANT=long` как страховка стиля.
    const svc = new PositionCommentService(
      makeConfigService({ AI_PROMPT_VARIANT: 'long' }),
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

    it('KS-3721 RU: упоминает sf18_eval как главный источник, sf18_pv в инструкции не фигурирует', () => {
      const p = svc.buildSystemPrompt('ru');
      expect(p).toContain('sf18_eval');
      expect(p).toContain('Stockfish 18');
      // Тип cp и mate должны быть упомянуты с пояснением.
      expect(p).toContain('cp');
      expect(p).toContain('mate');
      // KS-3702: знак всегда со стороны белых.
      expect(p).toContain('с точки зрения белых');
      expect(p).not.toContain('side_to_move');
      expect(p).toMatch(/независимо от того, чей ход/);
      // KS-3721: sf18_pv больше не упоминается — модель не должна
      // опираться на pv-линию как на источник манёвров.
      expect(p).not.toContain('sf18_pv');
      expect(p).not.toContain('UCI');
      expect(p).not.toContain('ОБЯЗАТЕЛЬНО');
      // Главный источник истины — sf18_eval.
      expect(p).toMatch(/Главный источник истины/);
      expect(p).toMatch(/Вердикт.*следует за sf18_eval/);
    });

    it('KS-3721 RU: явный запрет на конкретные ходы, манёвры и планы фигурами', () => {
      const p = svc.buildSystemPrompt('ru');
      expect(p).toMatch(/Это СТАТИЧЕСКАЯ оценка/);
      expect(p).toMatch(/Запрещено выдумывать конкретные ходы, манёвры и планы/);
      // Перечень типовых формулировок-выдумок.
      expect(p).toContain('перевод коня');
      expect(p).toContain('прорыв пешкой');
      expect(p).toContain('диагонали');
      expect(p).toContain('вскрытие линии');
      // Конкретные ходы запрещены.
      expect(p).toMatch(/Конкретные ходы.*нельзя/);
      // Square — только если из подкомпоненты.
      expect(p).toMatch(/square самой подкомпоненты/);
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
        ['bishop_pawns', /много своих пешек на цвете слона/],
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

    it('KS-3721 RU: иерархия sf18_eval → тенденция → статика, без сверки с sf18_pv', () => {
      const p = svc.buildSystemPrompt('ru');
      expect(p).toMatch(/Иерархия:/);
      expect(p).toContain('формально');
      expect(p).toContain('Stockfish не считает это преимуществом');
      // KS-3721: сверки с sf18_pv больше нет — модель не должна
      // строить нарратив вокруг конкретных ходов pv.
      expect(p).not.toContain('Сверка с sf18_pv');
      expect(p).not.toContain('Порядок приоритетов');
      // Тенденция остаётся.
      expect(p).toContain('тенденция факторов');
      // Шаблон формального описания без рассказа о ходах сверху.
      expect(p).toMatch(/формально у X есть Y.*Stockfish не считает.*исчезает/);
      expect(p).toMatch(/КАК именно.*не пиши/);
    });

    it('KS-3721 EN: упоминает sf18_eval как главный источник, sf18_pv в инструкции не фигурирует', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toContain('sf18_eval');
      expect(p).toContain('Stockfish 18');
      expect(p).toContain('cp');
      expect(p).toContain('mate');
      // KS-3702: знак всегда со стороны белых.
      expect(p).toContain("White's point of view");
      expect(p).not.toContain('side_to_move');
      expect(p).toContain('regardless of whose move');
      // KS-3721: sf18_pv удалён из инструкции.
      expect(p).not.toContain('sf18_pv');
      expect(p).not.toContain('UCI');
      expect(p).not.toMatch(/MUST reflect both/);
      // Главный источник истины — sf18_eval.
      expect(p).toMatch(/Main source of truth/);
      expect(p).toMatch(/verdict.*ALWAYS follows sf18_eval/);
    });

    it('KS-3721 EN: explicit ban on concrete moves, manoeuvres and plans by named pieces', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toMatch(/STATIC evaluation/);
      expect(p).toMatch(/Forbidden — inventing concrete moves, manoeuvres and plans/);
      expect(p).toContain('transferring the knight');
      expect(p).toContain('pawn break');
      expect(p).toContain('diagonal');
      expect(p).toContain('file');
      expect(p).toMatch(/Concrete moves.*forbidden in any form/);
      expect(p).toMatch(/square field of a subterm/);
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
        ['bishop_pawns', /many own pawns on the bishop's colour/],
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

    it('KS-3721 EN: hierarchy sf18_eval → trend → static, no sf18_pv check step', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toMatch(/Hierarchy:/);
      expect(p).toContain('Nominally');
      expect(p).toContain('Stockfish does not see this as an advantage');
      // KS-3721: правило сверки с sf18_pv удалено.
      expect(p).not.toContain('Check sf18_pv');
      expect(p).not.toContain('Order of priority');
      // Тенденция остаётся.
      expect(p).toContain('factor trend');
      // Шаблон формального описания без рассказа о ходах.
      expect(p).toMatch(/Nominally Side X has Y.*Stockfish does not see this as an advantage.*dissolves soon/);
      expect(p).toMatch(/Do NOT spell out how exactly/);
    });

    it('KS-3721 RU: вердикт всегда за sf18_eval, terminal_value остаётся как тенденция', () => {
      const p = svc.buildSystemPrompt('ru');
      expect(p).toContain('Вердикт о стороне с перевесом ВСЕГДА следует за sf18_eval');
      expect(p).toContain('terminal_value');
      // Тенденция value → terminal_value сохранена.
      expect(p).toMatch(/рост от value к terminal/);
    });

    it('KS-3721 EN: verdict always follows sf18_eval, terminal_value preserved as trend', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toContain('verdict on which side stands better ALWAYS follows sf18_eval');
      expect(p).toContain('terminal_value');
      expect(p).toMatch(/growth from value to terminal/);
    });

    it('KS-3727 RU: шкала cp → вердикт и запрет «у белых перевес» при отрицательном sf18_eval', () => {
      const p = svc.buildSystemPrompt('ru');
      // Карта порогов cp → словесная оценка (все диапазоны и обе стороны).
      expect(p).toContain('Соответствие sf18_eval → вердикт');
      expect(p).toMatch(/cp от -30 до \+30.*«примерное равенство»/);
      expect(p).toMatch(/cp от \+30 до \+100.*небольшой перевес белых/);
      expect(p).toMatch(/cp от -30 до -100.*небольшой перевес чёрных/);
      expect(p).toMatch(/cp от \+100 до \+300.*заметное преимущество белых/);
      expect(p).toMatch(/cp от -100 до -300.*заметное преимущество чёрных/);
      expect(p).toMatch(/cp ≥ \+300.*решающее преимущество белых/);
      expect(p).toMatch(/cp ≤ -300.*решающее преимущество чёрных/);
      expect(p).toMatch(/mate.*положительным N.*за белых/);
      expect(p).toMatch(/mate.*отрицательным N.*за чёрных/);
      // Прямой запрет на «у белых …» при отрицательном eval.
      expect(p).toContain('ЗАПРЕЩЕНО');
      expect(p).toContain('«у белых перевес»');
      expect(p).toContain('«у белых преимущество»');
      expect(p).toContain('«заметное преимущество белых»');
      expect(p).toContain('«решающее преимущество белых»');
      expect(p).toMatch(/sf18_eval\.cp\s*<\s*0/);
      expect(p).toMatch(/Симметричный запрет для чёрных/);
      // Материал не отменяет знак eval.
      expect(p).toMatch(/Материальный перевес.*не отменяет знак sf18_eval/);
      // Конкретный пример из жалобы пользователя.
      expect(p).toMatch(/cp=-665.*лишняя фигура.*решающее преимущество чёрных.*а не «у белых перевес»/);
    });

    it('KS-3727 EN: cp → verdict mapping and ban on "White is better" at negative sf18_eval', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toContain('Mapping sf18_eval → verdict');
      expect(p).toMatch(/cp from -30 to \+30.*"roughly equal"/);
      expect(p).toMatch(/cp from \+30 to \+100.*slight edge for White/);
      expect(p).toMatch(/cp from -30 to -100.*slight edge for Black/);
      expect(p).toMatch(/cp from \+100 to \+300.*clear advantage for White/);
      expect(p).toMatch(/cp from -100 to -300.*clear advantage for Black/);
      expect(p).toMatch(/cp ≥ \+300.*decisive advantage for White/);
      expect(p).toMatch(/cp ≤ -300.*decisive advantage for Black/);
      expect(p).toMatch(/mate.*positive N.*for White/);
      expect(p).toMatch(/mate.*negative N.*for Black/);
      // Прямой запрет на "White is better" при отрицательном eval.
      expect(p).toContain('FORBIDDEN');
      expect(p).toContain('"White is better"');
      expect(p).toContain('"clear advantage for White"');
      expect(p).toContain('"decisive advantage for White"');
      expect(p).toMatch(/sf18_eval\.cp\s*<\s*0/);
      expect(p).toMatch(/Symmetric ban for Black/);
      // Material does not override.
      expect(p).toMatch(/override the sign of sf18_eval/);
      // Конкретный пример из жалобы пользователя.
      expect(p).toMatch(/cp=-665.*extra piece.*decisive advantage for Black.*not "White is better"/);
    });

    it('обе версии — без преамбул в стиле CRITICAL RULES / few-shot / ELO', () => {
      const ru = svc.buildSystemPrompt('ru');
      const en = svc.buildSystemPrompt('en');
      for (const p of [ru, en]) {
        expect(p).not.toContain('CRITICAL RULES');
        expect(p).not.toContain('few-shot');
        expect(p).not.toContain('ELO');
        // KS-3727: слова FORBIDDEN/ЗАПРЕЩЕНО используются как
        // точечные запреты на конкретные формулировки (а не как
        // преамбула в стиле V2-промпта), поэтому проверки на их
        // отсутствие сняты.
        // KS-3721: блоки про sf18_pv (формат, инструкция отразить,
        // сверка с pv, порядок приоритетов, пример с проходной)
        // удалены, добавлены явные запреты на манёвры/планы.
        // KS-3727: добавлена шкала cp → вердикт и явный пример
        // расхождения материала и sf18_eval. Верхняя граница 9500
        // символов сохранена.
        expect(p.length).toBeLessThan(9500);
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
      // KS-3814: дефолт — short-вариант, начинается с
      // «Comment on this chess position from the given facts».
      expect(captured.systemPrompt).toMatch(
        /^Comment on this chess position from the given facts/,
      );
      expect(captured.systemPrompt).toContain('sf18_eval');
      // KS-3721: sf18_pv больше не упоминается в инструкции модели.
      expect(captured.systemPrompt).not.toContain('sf18_pv');
    });

    it('language=ru → systemPrompt в payload — RU (содержит sf18_eval-инструкцию)', async () => {
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
      // KS-3814: short-вариант начинается с «Прокомментируй позицию по фактам».
      expect(captured.systemPrompt).toMatch(
        /^Прокомментируй позицию по фактам/,
      );
      expect(captured.systemPrompt).toContain('sf18_eval');
      // KS-3721: sf18_pv больше не упоминается в инструкции модели.
      expect(captured.systemPrompt).not.toContain('sf18_pv');
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
      // KS-3814: дефолт по языку — RU, short-вариант начинается
      // с «Прокомментируй позицию по фактам».
      expect(captured.systemPrompt).toMatch(
        /^Прокомментируй позицию по фактам/,
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

    it('KS-3721: sf18_pv вырезается из factors перед отправкой в модель, остальные факторы сохраняются', async () => {
      const svc = new PositionCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      let captured: any = null;
      global.fetch = jest.fn(async (_url: any, init: any) => {
        captured = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            response: JSON.stringify({ comment: 'ok' }),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as any;

      const dto = makeDto({
        factors: [
          { id: 'sf18_eval', score: { type: 'cp', value: 120 } },
          { id: 'sf18_pv', moves: ['g2g3', 'e7e5', 'g1f3'] },
          { id: 'material', color: 'w', value_mg: 1, value_eg: 1 },
          {
            id: 'mobility_rook',
            value_mg: 0.1,
            value_eg: 0.05,
            terminal_value_mg: 0.3,
            terminal_value_eg: 0.2,
          },
        ],
      });
      await svc.comment('user-1', dto);

      const m = String(captured.message).match(
        /Исходные данные \(JSON\):\n([\s\S]+)$/,
      );
      expect(m).not.toBeNull();
      const data = JSON.parse((m as RegExpMatchArray)[1]);
      const ids = (data.factors as Array<{ id: string }>).map((f) => f.id);
      // sf18_pv вырезан, остальные остались, порядок сохранён.
      expect(ids).toEqual(['sf18_eval', 'material', 'mobility_rook']);
      // terminal_value_* у статической подкомпоненты сохраняется —
      // тенденция остаётся доступной модели без знания самой линии.
      expect(JSON.stringify(data.factors)).toContain('terminal_value_mg');
      // В подаваемых данных от модели sf18_pv нет полностью.
      expect(JSON.stringify(data.factors)).not.toContain('sf18_pv');
      expect(JSON.stringify(data.factors)).not.toContain('g2g3');
    });
  });

  describe('KS-3813: сжатие словаря расшифровок до пришедших id', () => {
    it('buildSystemPrompt без usedIds — словарь полный (backward-compat для прямых вызовов)', () => {
      const svc = new PositionCommentService(
        makeConfigService({}),
        makeRedisStub(),
      );
      const p = svc.buildSystemPrompt('ru');
      // Полный словарь содержит строки «- <id> →» для ключевых id.
      expect(p).toMatch(/^-\s+king_danger\s+→/m);
      expect(p).toMatch(/^-\s+outpost_knight\s+→/m);
      expect(p).toMatch(/^-\s+mobility_rook\s+→/m);
      expect(p).toMatch(/^-\s+rook_on_open_file\s+→/m);
      expect(p).toMatch(/^-\s+bishop_pawns\s+→/m);
      expect(p).toMatch(/^-\s+material\s+→/m);
    });

    it('buildSystemPrompt c usedIds — оставляет в словаре только пересечение с SUBTERM_LABELS', () => {
      const svc = new PositionCommentService(
        makeConfigService({}),
        makeRedisStub(),
      );
      const used = new Set(['material', 'mobility_rook', 'sf18_eval']);
      const p = svc.buildSystemPrompt('ru', used);
      // Только material и mobility_rook — id из SUBTERM_LABELS,
      // присутствующие в usedIds.
      expect(p).toMatch(/^-\s+material\s+→/m);
      expect(p).toMatch(/^-\s+mobility_rook\s+→/m);
      // Остальные id из SUBTERM_LABELS отсутствуют в словаре.
      // Проверка по строке «- <id> →»: id могут фигурировать в самой
      // инструкции как пример запрета писать технические id в ответе.
      expect(p).not.toMatch(/^-\s+king_danger\s+→/m);
      expect(p).not.toMatch(/^-\s+outpost_knight\s+→/m);
      expect(p).not.toMatch(/^-\s+rook_on_open_file\s+→/m);
      expect(p).not.toMatch(/^-\s+bishop_pawns\s+→/m);
      expect(p).not.toMatch(/^-\s+passed_rank\s+→/m);
      // sf18_eval — не из SUBTERM_LABELS, в словаре его нет, но в
      // инструкции он по-прежнему упоминается как «главный источник».
      expect(p).not.toMatch(/^-\s+sf18_eval\s+→/m);
      expect(p).toContain('sf18_eval');
    });

    it('comment(): в payload модели уходит только сжатый словарь — без неиспользуемых id', async () => {
      const svc = new PositionCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      let captured: any = null;
      global.fetch = jest.fn(async (_url: any, init: any) => {
        captured = JSON.parse(init.body);
        return new Response(
          JSON.stringify({ response: JSON.stringify({ comment: 'ok' }) }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as any;

      const dto = makeDto({
        factors: [
          { id: 'sf18_eval', score: { type: 'cp', value: 20 } },
          { id: 'sf18_pv', moves: ['e2e4'] },
          { id: 'material', color: 'w', value_mg: 0.3, value_eg: 0.2 },
          { id: 'mobility_rook', value_mg: 0.1, value_eg: 0.05 },
        ],
      });
      await svc.comment('user-1', dto);

      // В systemPrompt — строки словаря только для material и mobility_rook.
      expect(captured.systemPrompt).toMatch(/^-\s+material\s+→/m);
      expect(captured.systemPrompt).toMatch(/^-\s+mobility_rook\s+→/m);
      // Неиспользуемые id из SUBTERM_LABELS отсутствуют как строки словаря.
      expect(captured.systemPrompt).not.toMatch(/^-\s+king_danger\s+→/m);
      expect(captured.systemPrompt).not.toMatch(/^-\s+outpost_knight\s+→/m);
      expect(captured.systemPrompt).not.toMatch(/^-\s+rook_on_open_file\s+→/m);
      expect(captured.systemPrompt).not.toMatch(/^-\s+bishop_pawns\s+→/m);
      expect(captured.systemPrompt).not.toMatch(/^-\s+passed_rank\s+→/m);
      // То же — в message (KS-3694: инструкция дублируется в сообщении).
      expect(captured.message).not.toMatch(/^-\s+king_danger\s+→/m);
      expect(captured.message).not.toMatch(/^-\s+outpost_knight\s+→/m);
    });

    it('comment() со sf18_pv в factors не оставляет sf18_pv в словаре (он не из SUBTERM_LABELS)', async () => {
      const svc = new PositionCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      let captured: any = null;
      global.fetch = jest.fn(async (_url: any, init: any) => {
        captured = JSON.parse(init.body);
        return new Response(
          JSON.stringify({ response: JSON.stringify({ comment: 'ok' }) }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as any;

      await svc.comment(
        'user-1',
        makeDto({
          factors: [
            { id: 'sf18_eval', score: { type: 'cp', value: 0 } },
            { id: 'sf18_pv', moves: ['e2e4'] },
            { id: 'space', value_mg: 0.05, value_eg: 0 },
          ],
        }),
      );

      // space — единственная подкомпонента в словаре.
      expect(captured.systemPrompt).toMatch(/^-\s+space\s+→/m);
      // sf18_pv как строки «- sf18_pv →» в словаре нет.
      expect(captured.systemPrompt).not.toMatch(/^-\s+sf18_pv\s+→/m);
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
    // KS-3814: тесты заточены под long-вариант — там цветовая
    // конвенция вынесена отдельным заголовком и пробелами вокруг «/».
    const svc = new PositionCommentService(
      makeConfigService({ AI_PROMPT_VARIANT: 'long' }),
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

  // ─────────────────────────────────────────────────────────────────
  describe('KS-3814: сжатая (short) системная инструкция — по умолчанию', () => {
    const svc = new PositionCommentService(
      makeConfigService({}), // без переменной → short
      makeRedisStub(),
    );

    it('short — ≤80 строк после join (без словаря)', () => {
      const empty = new Set<string>();
      const ru = svc.buildSystemPrompt('ru', empty);
      const en = svc.buildSystemPrompt('en', empty);
      expect(ru.split('\n').length).toBeLessThanOrEqual(80);
      expect(en.split('\n').length).toBeLessThanOrEqual(80);
    });

    it('short — RU содержит все обязательные блоки (cp→вердикт, иерархия, запреты, JSON)', () => {
      const p = svc.buildSystemPrompt('ru');
      // Соответствие cp → вердикт.
      expect(p).toMatch(/Соответствие cp → вердикт/);
      expect(p).toMatch(/равенство/);
      expect(p).toMatch(/небольшой перевес/);
      expect(p).toMatch(/заметное преимущество/);
      expect(p).toMatch(/решающее преимущество/);
      expect(p).toMatch(/мат в N/);
      // Иерархия достоверности.
      expect(p).toMatch(/Иерархия/);
      expect(p).toContain('sf18_eval');
      expect(p).toContain('terminal_value');
      // Запреты.
      expect(p).toMatch(/ЗАПРЕЩЕНО/);
      expect(p).toContain('перевод коня на');
      expect(p).toContain('слайдер');
      expect(p).toContain('фигуры дальнего боя');
      // Формат JSON.
      expect(p).toContain('Формат ответа — ОДИН JSON-объект');
      expect(p).toContain('"comment"');
      expect(p).toContain('"highlights"');
      expect(p).toContain('"arrows"');
    });

    it('short — EN содержит mapping, hierarchy, forbidden, JSON', () => {
      const p = svc.buildSystemPrompt('en');
      expect(p).toMatch(/Mapping sf18_eval → verdict/);
      expect(p).toMatch(/roughly equal/);
      expect(p).toMatch(/slight edge/);
      expect(p).toMatch(/clear advantage/);
      expect(p).toMatch(/decisive advantage/);
      expect(p).toMatch(/mate in N/);
      expect(p).toMatch(/Hierarchy/);
      expect(p).toMatch(/FORBIDDEN/);
      expect(p).toContain('long-range pieces');
      expect(p).toContain('Output format — ONE JSON object');
    });

    it('short — не содержит обучающий пример cp=-665 (он перенесён в JSDoc)', () => {
      const ru = svc.buildSystemPrompt('ru');
      const en = svc.buildSystemPrompt('en');
      for (const p of [ru, en]) {
        expect(p).not.toContain('cp=-665');
        expect(p).not.toContain('лишняя фигура');
        expect(p).not.toContain('extra piece');
      }
    });

    it('AI_PROMPT_VARIANT=long → возвращается прежняя расширенная инструкция', () => {
      const longSvc = new PositionCommentService(
        makeConfigService({ AI_PROMPT_VARIANT: 'long' }),
        makeRedisStub(),
      );
      const p = longSvc.buildSystemPrompt('ru');
      expect(p).toContain('Цветовая конвенция');
      expect(p).toContain('Прокомментируй пожалуйста позицию человеческим языком');
      expect(p).toContain('Соответствие sf18_eval → вердикт');
    });
  });

  describe('comment — KS-3700 diagnostic-лог', () => {
    function okFetch() {
      return jest.fn(async () =>
        new Response(
          JSON.stringify({
            response: JSON.stringify({
              comment: 'ok',
              highlights: [],
              arrows: [],
            }),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ) as any;
    }

    it('POSITION_COMMENT_DEBUG=true → logger.log с метаданными (fen, ids, has_sf18_eval/pv, terminal_count)', async () => {
      const svc = new PositionCommentService(
        makeConfigService({
          AI_CHAT_WEBHOOK_URL: 'http://wh.test',
          POSITION_COMMENT_DEBUG: 'true',
        }),
        makeRedisStub(),
      );
      global.fetch = okFetch();
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

      await svc.comment(
        'user-abcdef12345',
        makeDto({
          fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
          factors: [
            { id: 'sf18_eval', score: { type: 'cp', value: 470 } },
            { id: 'sf18_pv', moves: ['g2g3'] },
            {
              id: 'material',
              color: 'w',
              value_mg: 1,
              value_eg: 1,
              terminal_value_mg: 2,
              terminal_value_eg: 2,
            },
            { id: 'mobility_rook', value_mg: 0.1, value_eg: 0.05 },
          ],
          eval: { mg: 470, eg: 470, v: 470 },
        }),
      );

      expect(logSpy).toHaveBeenCalledTimes(1);
      const payload = logSpy.mock.calls[0][0] as string;
      expect(payload).toContain('debug:');
      // user id обрезан до 8 символов (как в остальных логах сервиса).
      expect(payload).toContain('user=user-abc');
      expect(payload).toContain('"fen":"4k3/8/8/8/8/8/8/4K3 w - - 0 1"');
      expect(payload).toContain('"factors_length":4');
      expect(payload).toContain('"ids":["sf18_eval","sf18_pv","material","mobility_rook"]');
      expect(payload).toContain('"has_sf18_eval":true');
      expect(payload).toContain('"has_sf18_pv":true');
      expect(payload).toContain('"terminal_count":1');
      expect(payload).toContain('"eval":{"mg":470,"eg":470,"v":470}');
      // Значения подкомпонент (value_mg, terminal_value_mg) в лог НЕ
      // попадают — только метаданные.
      expect(payload).not.toContain('value_mg');
      expect(payload).not.toContain('terminal_value_mg');
    });

    it('POSITION_COMMENT_DEBUG отсутствует → logger.log НЕ вызывается', async () => {
      const svc = new PositionCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      global.fetch = okFetch();
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

      await svc.comment('user-1', makeDto());

      expect(logSpy).not.toHaveBeenCalled();
    });

    it('POSITION_COMMENT_DEBUG=false → logger.log НЕ вызывается', async () => {
      const svc = new PositionCommentService(
        makeConfigService({
          AI_CHAT_WEBHOOK_URL: 'http://wh.test',
          POSITION_COMMENT_DEBUG: 'false',
        }),
        makeRedisStub(),
      );
      global.fetch = okFetch();
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

      await svc.comment('user-1', makeDto());

      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  // ─── KS-4049: metrics + phase ──────────────────────────────────────

  describe('KS-4049: metrics + phase из тела запроса', () => {
    function makeMetricsDto(): PositionCommentDto {
      return makeDto({
        metrics: {
          material:        { value_cp: -0.5 },
          pawn_structure:  { value_cp: 0.2 },
          king_safety:     { value_cp: 1.3 },
          pieces:          { value_cp: 0.8 },
          mobility:        { value_cp: 0.4 },
          threats:         { value_cp: -0.2 },
          passed_pawns:    { value_cp: 0.0 },
        },
        phase: 200,
      });
    }

    it('comment(): когда есть metrics — systemPrompt содержит дополнение про агрегаты', async () => {
      const svc = new PositionCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      const fetchSpy = jest.fn().mockResolvedValue({
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ response: '{"comment":"x"}' }),
        text: async () => '',
      });
      global.fetch = fetchSpy as never;

      await svc.comment('user-1', makeMetricsDto());

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.systemPrompt).toContain('metrics');
      expect(body.systemPrompt).toContain('7 групп');
      expect(body.message).toContain('"metrics"');
      expect(body.message).toContain('"phase":200');
    });

    it('comment(): без metrics — systemPrompt НЕ содержит дополнения, message без metrics/phase', async () => {
      const svc = new PositionCommentService(
        makeConfigService({ AI_CHAT_WEBHOOK_URL: 'http://wh.test' }),
        makeRedisStub(),
      );
      const fetchSpy = jest.fn().mockResolvedValue({
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ response: '{"comment":"x"}' }),
        text: async () => '',
      });
      global.fetch = fetchSpy as never;

      await svc.comment('user-1', makeDto());

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.systemPrompt).not.toContain('7 групп');
      expect(body.message).not.toContain('"metrics"');
      expect(body.message).not.toContain('"phase"');
    });

    it('buildSystemPrompt(hasMetrics=true) — добавляет блок про агрегаты в RU', () => {
      const svc = new PositionCommentService(
        makeConfigService({}),
        makeRedisStub(),
      );
      const withMetrics = svc.buildSystemPrompt('ru', undefined, true);
      const withoutMetrics = svc.buildSystemPrompt('ru', undefined, false);
      expect(withMetrics.length).toBeGreaterThan(withoutMetrics.length);
      expect(withMetrics).toContain('metrics');
      expect(withMetrics).toContain('фазовой свёртки');
      // Запрет на цифры остаётся.
      expect(withMetrics).toContain('value_cp');
    });

    it('buildSystemPrompt(hasMetrics=true) — добавляет блок про агрегаты в EN', () => {
      const svc = new PositionCommentService(
        makeConfigService({}),
        makeRedisStub(),
      );
      const p = svc.buildSystemPrompt('en', undefined, true);
      expect(p).toContain('`metrics`');
      expect(p).toContain('tapered by');
      expect(p).toContain('sf18_eval');
    });

    it('POSITION_COMMENT_DEBUG=true: extractDebugMeta содержит has_metrics + phase', async () => {
      const svc = new PositionCommentService(
        makeConfigService({
          AI_CHAT_WEBHOOK_URL: 'http://wh.test',
          POSITION_COMMENT_DEBUG: 'true',
        }),
        makeRedisStub(),
      );
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ response: '{"comment":"x"}' }),
        text: async () => '',
      }) as never;
      const logSpy = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => {});

      await svc.comment('user-1', makeMetricsDto());

      const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('"has_metrics":true');
      expect(logged).toContain('"phase":200');
    });
  });
});
