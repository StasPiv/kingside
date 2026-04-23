import type { LessonFixture } from '../../../fixture-types';

const BLOCK = 'basic-endgame';
const BASE = 'lessons.beginner';

export const block06BasicEndgame: LessonFixture[] = [
  // 6.1 Король и пешка против короля
  {
    slug: 'king-pawn-vs-king',
    order: 26,
    blockKey: BLOCK,
    kind: 'endgame_set',
    estMinutes: 15,
    titleKey: `${BASE}.king-pawn-vs-king.title`,
    summaryKey: `${BASE}.king-pawn-vs-king.summary`,
    isPublished: true,
    steps: [
      {
        id: 'intro',
        order: 0,
        payload: {
          type: 'text',
          bodyMarkdown: [
            '«Король и пешка против короля» — самый простой, но уже содержательный эндшпиль. Исход зависит от положения королей и расстояния пешки до поля превращения.',
            '',
            '**Правило квадрата.** Если пешка не поддержана своим королём, важно проверить, успеет ли вражеский король её догнать.',
            '',
            'Построй мысленный «квадрат»: от пешки до её поля превращения — это одна сторона. С этой же длиной стороны нарисуй квадрат в сторону вражеского короля. **Если король находится внутри квадрата или может войти в него своим ходом — он догонит пешку.** Если нет — пешка проходит в ферзи.',
            '',
            '{{diagram:0}}',
            '',
            'На диаграмме: белая пешка d5 идёт в ферзи. Квадрат от d5 до d8 и влево на 3 клетки — это c5-d5-e5...h5 нет, d5-a5-a8-d8. Чёрный король a7 вне квадрата — пешка проходит.',
            '',
            '**Оппозиция.** Когда король противника стоит у тебя на пути, нужно использовать **оппозицию** — позицию, когда два короля стоят через клетку на одной вертикали (или горизонтали), и ходит противник. Тот, кто вынужден уступить — проигрывает ключевые поля.',
            '',
            '{{diagram:1}}',
            '',
            'На диаграмме: белый король e6, чёрный e8, оппозиция. Ходят чёрные — они обязаны уйти на d8 или f8. После этого белые занимают полем впереди своей пешки, и чёрные не могут остановить превращение.',
            '',
            '**Главное правило.** В эндшпиле K+P vs K сторона с пешкой выигрывает, если:',
            '1. Её король находится **перед** пешкой (не рядом, а на клетке, ближе к полю превращения).',
            '2. Между королями — оппозиция в её пользу (на ходу противник, не она).',
            '',
            'Если король с пешкой **позади** пешки, а король противника стоит прямо перед пешкой — обычно ничья.',
            '',
            '**Исключение — ладейная пешка** (a- или h-). С ней выиграть очень сложно: король противника забивается в угол и не выходит. Часто ничья, даже если белый король «впереди» пешки.',
          ].join('\n'),
          diagrams: [
            { fen: '8/k7/8/3P4/8/8/8/4K3 w - - 0 1', caption: 'Правило квадрата: чёрный король a7 за пределами квадрата d5-a5-a8-d8. Пешка проходит.', orientation: 'white' },
            { fen: '4k3/8/4K3/4P3/8/8/8/8 b - - 0 1', caption: 'Оппозиция в пользу белых: ходят чёрные, обязаны уступить — белая пешка проходит.', orientation: 'white' },
          ],
        },
      },
      {
        id: 'quiz',
        order: 1,
        payload: {
          type: 'quiz',
          questions: [
            { id: 'q1', promptI18nKey: `${BASE}.king-pawn-vs-king.quiz.q1.prompt`,
              options: ['a','b','c'].map((o) => ({ id: o, labelI18nKey: `${BASE}.king-pawn-vs-king.quiz.q1.opt.${o}` })),
              correctOptionIds: ['a'], explanationI18nKey: `${BASE}.king-pawn-vs-king.quiz.q1.explanation` },
            { id: 'q2', promptI18nKey: `${BASE}.king-pawn-vs-king.quiz.q2.prompt`,
              options: ['a','b','c'].map((o) => ({ id: o, labelI18nKey: `${BASE}.king-pawn-vs-king.quiz.q2.opt.${o}` })),
              correctOptionIds: ['b'], explanationI18nKey: `${BASE}.king-pawn-vs-king.quiz.q2.explanation` },
            { id: 'q3', promptI18nKey: `${BASE}.king-pawn-vs-king.quiz.q3.prompt`,
              options: ['a','b','c'].map((o) => ({ id: o, labelI18nKey: `${BASE}.king-pawn-vs-king.quiz.q3.opt.${o}` })),
              correctOptionIds: ['b'], explanationI18nKey: `${BASE}.king-pawn-vs-king.quiz.q3.explanation` },
          ],
          passThreshold: 0.7,
        },
      },
      {
        id: 'practice',
        order: 2,
        payload: {
          type: 'puzzle',
          selection: { mode: 'filter', themes: ['pawnEndgame', 'endgame'], ratingMax: 1300, limit: 5 },
          minSolved: 3,
        },
      },
    ],
  },

  // 6.2 Превращение пешки
  {
    slug: 'pawn-promotion',
    order: 27,
    blockKey: BLOCK,
    kind: 'theory',
    estMinutes: 10,
    titleKey: `${BASE}.pawn-promotion.title`,
    summaryKey: `${BASE}.pawn-promotion.summary`,
    isPublished: true,
    steps: [
      {
        id: 'intro',
        order: 0,
        payload: {
          type: 'text',
          bodyMarkdown: [
            'Когда пешка доходит до последней горизонтали, её нужно превратить — это обязательно. Обычно выбирают ферзя (он самый сильный), но не всегда.',
            '',
            '**Когда превращать в ферзя.** В 95% случаев. Ферзь сильнее любой другой фигуры, и если партия уже выигрышная — ты доводишь её до мата.',
            '',
            '**Когда превращать в коня.** Редкий случай, но бывает. Если превращение в ферзя даёт пат или не даёт шаха, а в коня — шах с выигрышем фигуры, превращение в коня (**недопревращение**) может быть лучше.',
            '',
            '{{diagram:0}}',
            '',
            'На диаграмме: пешка e7 идёт на e8. Ход e8=Ф? — пат (у чёрного короля нет полей, шаха нет). Правильно e8=С! или любой другой ход, сохраняющий возможность выигрыша.',
            '',
            '{{diagram:1}}',
            '',
            'На диаграмме: пешка f7 идёт на f8. e8=Ф? — шаха нет, просто ферзь. e8=К+! — вилка: шах королю и нападение на ферзя d7. Чёрные уходят королём, белые берут ферзя.',
            '',
            '**Когда превращать в ладью.** Почти никогда. Но иногда — чтобы избежать пата. Ладья даёт меньше угроз, и у короля противника остаётся поле для хода.',
            '',
            '**Главное правило.** Перед превращением проверяй: не пат ли у противника после этого? Если пат — превращение в ферзя превращается в ничью. Выбирай ладью, слона или коня.',
          ].join('\n'),
          diagrams: [
            { fen: '7k/4P1K1/8/8/8/8/8/8 w - - 0 1', caption: 'Превращение в ферзя — пат. Лучше ладья или другой вариант, сохраняющий выигрыш.', orientation: 'white' },
            { fen: '8/3q1P2/8/8/8/8/8/4k1K1 w - - 0 1', caption: 'Превращение в коня с шахом и вилкой на ферзя — сильнее, чем в ферзя.', orientation: 'white' },
          ],
        },
      },
      {
        id: 'quiz',
        order: 1,
        payload: {
          type: 'quiz',
          questions: [
            { id: 'q1', promptI18nKey: `${BASE}.pawn-promotion.quiz.q1.prompt`,
              options: ['a','b','c','d'].map((o) => ({ id: o, labelI18nKey: `${BASE}.pawn-promotion.quiz.q1.opt.${o}` })),
              correctOptionIds: ['c'], explanationI18nKey: `${BASE}.pawn-promotion.quiz.q1.explanation` },
            { id: 'q2', promptI18nKey: `${BASE}.pawn-promotion.quiz.q2.prompt`,
              options: ['a','b','c'].map((o) => ({ id: o, labelI18nKey: `${BASE}.pawn-promotion.quiz.q2.opt.${o}` })),
              correctOptionIds: ['a'], explanationI18nKey: `${BASE}.pawn-promotion.quiz.q2.explanation` },
          ],
          passThreshold: 0.7,
        },
      },
      {
        id: 'practice',
        order: 2,
        payload: {
          type: 'puzzle',
          selection: { mode: 'filter', themes: ['promotion', 'endgame'], ratingMax: 1300, limit: 4 },
          minSolved: 2,
        },
      },
    ],
  },

  // 6.3 Активный король
  {
    slug: 'active-king-endgame',
    order: 28,
    blockKey: BLOCK,
    kind: 'theory',
    estMinutes: 10,
    titleKey: `${BASE}.active-king-endgame.title`,
    summaryKey: `${BASE}.active-king-endgame.summary`,
    isPublished: true,
    steps: [
      {
        id: 'intro',
        order: 0,
        payload: {
          type: 'text',
          bodyMarkdown: [
            'В дебюте и миттельшпиле король прячется за пешками и рокируется — это главная защита. Но в эндшпиле, когда на доске мало фигур и риск мата меньше, **король сам становится боевой единицей**.',
            '',
            '**Король в эндшпиле — сильная фигура.** Он контролирует 8 полей вокруг себя, умеет держать оппозицию, защищать пешки, нападать на вражеские. По «боевой силе» в эндшпиле король часто сравнивают с лёгкой фигурой.',
            '',
            '**Куда идёт король:**',
            '- В **центр** — оттуда он быстро достаёт до любой точки.',
            '- **Поддерживать свою проходную пешку** — без короля проходная часто застревает.',
            '- **Атаковать вражеские пешки** — особенно пешки на слабых полях или отсталые.',
            '',
            '{{diagram:0}}',
            '',
            'На диаграмме: белый король e4 активно вышел в центр. Он защищает пешку d5, нападает на пешку e5 и готов поддержать любую проходную. Чёрный король f7 запаздывает.',
            '',
            '**Правило.** Как только ты видишь, что партия переходит в эндшпиль (фигуры меняются, ферзей уже нет), **двигай короля к центру**. Даже один или два выигранных темпа с королём решают исход.',
            '',
            '**Ошибка новичков:** держать короля в углу после рокировки, как в миттельшпиле. В эндшпиле такой король — пассивен и бесполезен. Если на доске остались только ладьи и пешки или эндшпиль «фигуры против фигур», король должен участвовать.',
          ].join('\n'),
          diagrams: [
            { fen: '8/5k2/8/3Pp3/4K3/8/8/8 w - - 0 1', caption: 'Белый король активен в центре: защищает d5, атакует e5, поддержит проходную. Чёрный король пассивен.', orientation: 'white' },
          ],
        },
      },
      {
        id: 'quiz',
        order: 1,
        payload: {
          type: 'quiz',
          questions: [
            { id: 'q1', promptI18nKey: `${BASE}.active-king-endgame.quiz.q1.prompt`,
              options: ['a','b','c'].map((o) => ({ id: o, labelI18nKey: `${BASE}.active-king-endgame.quiz.q1.opt.${o}` })),
              correctOptionIds: ['a'], explanationI18nKey: `${BASE}.active-king-endgame.quiz.q1.explanation` },
            { id: 'q2', promptI18nKey: `${BASE}.active-king-endgame.quiz.q2.prompt`,
              options: ['a','b','c'].map((o) => ({ id: o, labelI18nKey: `${BASE}.active-king-endgame.quiz.q2.opt.${o}` })),
              correctOptionIds: ['a'], explanationI18nKey: `${BASE}.active-king-endgame.quiz.q2.explanation` },
          ],
          passThreshold: 0.7,
        },
      },
      {
        id: 'practice',
        order: 2,
        payload: {
          type: 'puzzle',
          selection: { mode: 'filter', themes: ['endgame', 'pawnEndgame'], ratingMax: 1400, limit: 4 },
          minSolved: 2,
        },
      },
    ],
  },

  // 6.4 Пат и ловушки
  {
    slug: 'stalemate-tricks',
    order: 29,
    blockKey: BLOCK,
    kind: 'theory',
    estMinutes: 10,
    titleKey: `${BASE}.stalemate-tricks.title`,
    summaryKey: `${BASE}.stalemate-tricks.summary`,
    isPublished: true,
    steps: [
      {
        id: 'intro',
        order: 0,
        payload: {
          type: 'text',
          bodyMarkdown: [
            'Ты играешь партию без фигуры, противник имеет явный перевес. Что делать? **Не сдаваться и искать шансы.** На уровне начинающего большинство «проигранных» партий ещё выигрываются или делаются ничьей — потому что противник ошибается или потому что есть скрытые спасения.',
            '',
            '**Главное оружие проигрывающего — пат.** Если у тебя почти нечего ставить под удар и король зажат, ищи позицию, в которой противник своими сильными фигурами «нечаянно» отнимет у тебя все ходы, не дав шаха. Это ничья.',
            '',
            '{{diagram:0}}',
            '',
            'На диаграмме: у чёрных только король h1, а у белых — ферзь и король. Ход белых. Неаккуратный 1.Фg2?? — пат (король на h1 не имеет ходов, шаха нет). Ничья. Белые должны ходить аккуратно: сначала подтянуть короля, потом оттеснить.',
            '',
            '**Вторая стратегия — ловушки.** Создавай сложные позиции, в которых противник может ошибиться. Не упрощай, не разменивай фигуры, не играй «технично» — это на руку сильному. Путай, угрожай, провоцируй жадность.',
            '',
            '{{diagram:1}}',
            '',
            'На диаграмме: у белых «мёртвый» эндшпиль без пешки. Но ход Кe4 создаёт угрозу вилки на с5 и g5 (если чёрные пойдут в ложную сторону). Противник может ошибиться и подставить фигуру.',
            '',
            '**Третья стратегия — тянуть до 50 ходов.** Если у противника мало материала и нет пешек, а ты король + фигура или пешка — он обязан двигаться. Если 50 ходов прошло без взятий и ходов пешками — ничья по правилу.',
            '',
            '**Правило.** На уровне начинающего **никогда не сдавайся, пока не видишь неизбежного мата или пока не потерян огромный материал (минус ферзь и ладья, без компенсации)**. Даже в безнадёжной позиции противник часто сам разваливает победу. Твоя задача — помогать этому, не сдаваться.',
          ].join('\n'),
          diagrams: [
            { fen: '4k3/8/8/8/8/8/5Q2/7K w - - 0 1', caption: 'Неаккуратный ход Фg2 привёл бы к пату (если бы чёрный король стоял на h1) — нужно подтягивать своего короля аккуратно.', orientation: 'white' },
            { fen: '4k3/8/8/8/4N3/8/8/4K3 w - - 0 1', caption: 'Даже в «мёртвой» позиции создавай угрозы. Ход Кe4 с идеей вилки держит напряжение.', orientation: 'white' },
          ],
        },
      },
      {
        id: 'quiz',
        order: 1,
        payload: {
          type: 'quiz',
          questions: [
            { id: 'q1', promptI18nKey: `${BASE}.stalemate-tricks.quiz.q1.prompt`,
              options: ['a','b','c'].map((o) => ({ id: o, labelI18nKey: `${BASE}.stalemate-tricks.quiz.q1.opt.${o}` })),
              correctOptionIds: ['a'], explanationI18nKey: `${BASE}.stalemate-tricks.quiz.q1.explanation` },
            { id: 'q2', promptI18nKey: `${BASE}.stalemate-tricks.quiz.q2.prompt`,
              options: ['a','b','c'].map((o) => ({ id: o, labelI18nKey: `${BASE}.stalemate-tricks.quiz.q2.opt.${o}` })),
              correctOptionIds: ['b'], explanationI18nKey: `${BASE}.stalemate-tricks.quiz.q2.explanation` },
            { id: 'q3', promptI18nKey: `${BASE}.stalemate-tricks.quiz.q3.prompt`,
              options: ['a','b','c'].map((o) => ({ id: o, labelI18nKey: `${BASE}.stalemate-tricks.quiz.q3.opt.${o}` })),
              correctOptionIds: ['c'], explanationI18nKey: `${BASE}.stalemate-tricks.quiz.q3.explanation` },
          ],
          passThreshold: 0.7,
        },
      },
      {
        id: 'practice',
        order: 2,
        payload: {
          type: 'puzzle',
          // chess-expert указал ['endgame', 'stalemate'], но Lichess puzzle
          // themes не содержат 'stalemate' — оставляем только 'endgame'.
          selection: { mode: 'filter', themes: ['endgame'], ratingMax: 1300, limit: 4 },
          minSolved: 2,
        },
      },
    ],
  },
];
