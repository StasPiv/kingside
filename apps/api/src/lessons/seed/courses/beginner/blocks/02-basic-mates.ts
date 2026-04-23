import type { LessonFixture } from '../../../fixture-types';

const BLOCK = 'basic-mates';
const BASE = 'lessons.beginner';

/**
 * Подсказка для читающего: во многих диаграммах chess-expert'а на доске
 * остался только изучаемый элемент (ферзь/ладья против одинокого короля).
 * Для прохождения валидации FEN (`chess.js` требует королей обеих сторон)
 * в дополнительные фен-позиции добавлены короли в углу, где это не меняло
 * идею диаграммы.
 */
export const block02BasicMates: LessonFixture[] = [
  // 2.1 Мат ферзём
  {
    slug: 'mate-queen-king',
    order: 8,
    blockKey: BLOCK,
    kind: 'theory',
    estMinutes: 12,
    titleKey: `${BASE}.mate-queen-king.title`,
    summaryKey: `${BASE}.mate-queen-king.summary`,
    isPublished: true,
    steps: [
      {
        id: 'intro',
        order: 0,
        payload: {
          type: 'text',
          bodyMarkdown: [
            'Король и ферзь против одинокого короля — один из первых матов, которые нужно уметь ставить. Принцип **«оттеснения»**: ферзь не даёт вражескому королю уйти с края доски, а свой король подходит на помощь, чтобы поставить финальный мат.',
            '',
            '**Ключевая идея:** держи ферзя **на ходе коня** от короля противника. Это значит, что ферзь стоит в позиции, в которую конь мог бы прыгнуть с клетки короля. При этом ферзь отнимает у короля половину доски и не даёт ему приблизиться.',
            '',
            '{{diagram:0}}',
            '',
            'На диаграмме: чёрный король на e4, белый ферзь на d6 (ход конём с e4 на d6). Ферзь перекрывает все клетки, куда король мог бы убежать «вверх», оставляя ему только нижнюю половину.',
            '',
            '**Алгоритм (работает всегда):**',
            '1. Ставь ферзя на ход коня от короля.',
            '2. Король идёт — ты идёшь своим королём тоже, сохраняя расстояние коня до чужого.',
            '3. Одинокий король постепенно окажется прижат к краю.',
            '4. Когда король на краю, **не давай шах с расстояния, если у тебя нет короля рядом** — получится пат.',
            '5. Приведи своего короля на 2-ю (или 7-ю для чёрных) горизонталь рядом с его королём и ставь мат.',
            '',
            '{{diagram:1}}',
            '',
            'Классическая финальная позиция: чёрный король a8, белый король c7, белый ферзь даёт мат с a7 (или b8, b7).',
            '',
            '**Опасность пата!** Самая частая ошибка новичков — загнать короля в угол и шаховать ферзём, не подведя своего короля. Король противника не может ходить, шаха нет → пат и ничья. Перед каждым шахом проверь: **есть ли у короля противника хотя бы одно легальное поле?** Если нет — не шахуй, а подтяни своего короля.',
          ].join('\n'),
          diagrams: [
            { fen: '8/8/3Q4/8/4k3/8/8/4K3 w - - 0 1', caption: 'Ферзь d6 на ходе коня от чёрного короля e4 — король зажат в нижней половине.', orientation: 'white' },
            { fen: 'k7/Q7/2K5/8/8/8/8/8 b - - 0 1', caption: 'Финальная позиция: чёрному королю a8 мат от Qa7 (или Qb7/Qb8). Белый король c6 поддерживает.', orientation: 'white' },
          ],
        },
      },
      {
        id: 'quiz',
        order: 1,
        payload: {
          type: 'quiz',
          questions: [
            { id: 'q1', promptI18nKey: `${BASE}.mate-queen-king.quiz.q1.prompt`,
              options: ['a','b','c'].map((o) => ({ id: o, labelI18nKey: `${BASE}.mate-queen-king.quiz.q1.opt.${o}` })),
              correctOptionIds: ['b'], explanationI18nKey: `${BASE}.mate-queen-king.quiz.q1.explanation` },
            { id: 'q2', promptI18nKey: `${BASE}.mate-queen-king.quiz.q2.prompt`,
              options: ['a','b','c'].map((o) => ({ id: o, labelI18nKey: `${BASE}.mate-queen-king.quiz.q2.opt.${o}` })),
              correctOptionIds: ['b'], explanationI18nKey: `${BASE}.mate-queen-king.quiz.q2.explanation` },
            { id: 'q3', promptI18nKey: `${BASE}.mate-queen-king.quiz.q3.prompt`,
              options: ['a','b','c'].map((o) => ({ id: o, labelI18nKey: `${BASE}.mate-queen-king.quiz.q3.opt.${o}` })),
              correctOptionIds: ['a'], explanationI18nKey: `${BASE}.mate-queen-king.quiz.q3.explanation` },
          ],
          passThreshold: 0.7,
        },
      },
      {
        id: 'practice',
        order: 2,
        payload: {
          type: 'puzzle',
          selection: { mode: 'filter', themes: ['mate', 'endgame', 'queenEndgame'], ratingMax: 1100, limit: 5 },
          minSolved: 3,
        },
      },
    ],
  },

  // 2.2 Мат ладьёй
  {
    slug: 'mate-rook-king',
    order: 9,
    blockKey: BLOCK,
    kind: 'theory',
    estMinutes: 15,
    titleKey: `${BASE}.mate-rook-king.title`,
    summaryKey: `${BASE}.mate-rook-king.summary`,
    isPublished: true,
    steps: [
      {
        id: 'intro',
        order: 0,
        payload: {
          type: 'text',
          bodyMarkdown: [
            'Мат одной ладьёй сложнее, чем ферзём: ладья может отсекать только по одной линии. Нужна точная работа своего короля.',
            '',
            '**Ключевая идея — «противостояние королей».** Два короля стоят друг напротив друга через одну клетку на одной вертикали или горизонтали. В этой конфигурации ходящий королём вынужден отступить. Твой король **держит** поля, ладья **отсекает** полосу доски.',
            '',
            '{{diagram:0}}',
            '',
            'На диаграмме: белый король d6, чёрный король d8 — противостояние через одну клетку. У чёрных на ходу — король обязан отойти на c8 или e8 (ходить на 7-ю горизонталь нельзя из-за ладьи). После этого ладья перейдёт на h8 или свою подходящую клетку и даст мат.',
            '',
            '**Алгоритм оттеснения:**',
            '1. Ладья «строит забор» — отсекает короля на оставшиеся горизонтали или вертикали.',
            '2. Свой король подходит и становится напротив чужого через клетку.',
            '3. Вражеский король вынужден отойти.',
            '4. Ладья делает «шаг» вслед, сжимая пространство.',
            '5. Когда король дойдёт до края — ставится мат.',
            '',
            '{{diagram:1}}',
            '',
            'Финальная матовая позиция: чёрный король a8, белый король c7, ладья даёт мат с h8 или с a-линии.',
            '',
            '**Частая ошибка.** Преждевременные шахи ладьёй на дальней дистанции: король просто подходит ближе к ладье, ты вынужден отступать ладьёй, и оттеснение срывается. **Не шахуй, пока свой король не на месте.**',
          ].join('\n'),
          diagrams: [
            { fen: '3k4/8/3K4/8/8/8/R7/8 b - - 0 1', caption: 'Противостояние королей d6-d8. Чёрный король вынужден отойти в сторону.', orientation: 'white' },
            { fen: 'k6R/8/2K5/8/8/8/8/8 b - - 0 1', caption: 'Финальная позиция: мат ладьёй h8, король c6 контролирует поля b7 и b8.', orientation: 'white' },
          ],
        },
      },
      {
        id: 'quiz',
        order: 1,
        payload: {
          type: 'quiz',
          questions: [
            { id: 'q1', promptI18nKey: `${BASE}.mate-rook-king.quiz.q1.prompt`,
              options: ['a','b','c'].map((o) => ({ id: o, labelI18nKey: `${BASE}.mate-rook-king.quiz.q1.opt.${o}` })),
              correctOptionIds: ['b'], explanationI18nKey: `${BASE}.mate-rook-king.quiz.q1.explanation` },
            { id: 'q2', promptI18nKey: `${BASE}.mate-rook-king.quiz.q2.prompt`,
              options: ['a','b','c'].map((o) => ({ id: o, labelI18nKey: `${BASE}.mate-rook-king.quiz.q2.opt.${o}` })),
              correctOptionIds: ['b'], explanationI18nKey: `${BASE}.mate-rook-king.quiz.q2.explanation` },
          ],
          passThreshold: 0.7,
        },
      },
      {
        id: 'practice',
        order: 2,
        payload: {
          type: 'puzzle',
          selection: { mode: 'filter', themes: ['mate', 'endgame', 'rookEndgame'], ratingMax: 1200, limit: 5 },
          minSolved: 3,
        },
      },
    ],
  },

  // 2.3 Мат двумя ладьями
  {
    slug: 'mate-two-rooks',
    order: 10,
    blockKey: BLOCK,
    kind: 'theory',
    estMinutes: 10,
    titleKey: `${BASE}.mate-two-rooks.title`,
    summaryKey: `${BASE}.mate-two-rooks.summary`,
    isPublished: true,
    steps: [
      {
        id: 'intro',
        order: 0,
        payload: {
          type: 'text',
          bodyMarkdown: [
            'Две ладьи матуют одинокого короля очень просто — «лесенкой». Свой король вообще не участвует, если стоит в безопасности.',
            '',
            '**Принцип:** одна ладья «режет» короля противника на горизонтали (или вертикали), вторая объявляет шах и гонит его на край. При шахе король отходит, а «режущая» ладья переходит следом, и новая горизонталь становится недоступной.',
            '',
            '{{diagram:0}}',
            '',
            'Ладья на a2 отрезает чёрного короля от 2-й горизонтали и ниже. Ладья на b3 готовится шахнуть: ход Rb8+ гонит короля на 7-ю. Затем ладья a2 переходит на a7 (отрезая 7-ю), Rb8 → Rb7+ и так далее. На каждом этапе горизонталь сужается, пока мат не ставится на 8-й.',
            '',
            '{{diagram:1}}',
            '',
            'Финальная позиция: шах ладьёй на горизонтали, король зажат на 8-й линии, отходить некуда.',
            '',
            '**Главная опасность — не потерять ладью.** Не подставляй шахующую ладью под короля противника. Если его король подходит близко, временно убери ладью на безопасную клетку, потом возобнови гонку.',
          ].join('\n'),
          diagrams: [
            { fen: '8/8/3k4/8/8/1R6/R7/4K3 w - - 0 1', caption: 'Ладьи a2 и b3 готовы начать «лесенку». Белый король участия не принимает.', orientation: 'white' },
            { fen: 'R6k/1R6/8/8/8/8/8/4K3 b - - 0 1', caption: 'Финальная позиция «лесенки»: шах по 8-й, король зажат, мат.', orientation: 'white' },
          ],
        },
      },
      {
        id: 'quiz',
        order: 1,
        payload: {
          type: 'quiz',
          questions: [
            { id: 'q1', promptI18nKey: `${BASE}.mate-two-rooks.quiz.q1.prompt`,
              options: ['a','b','c'].map((o) => ({ id: o, labelI18nKey: `${BASE}.mate-two-rooks.quiz.q1.opt.${o}` })),
              correctOptionIds: ['b'], explanationI18nKey: `${BASE}.mate-two-rooks.quiz.q1.explanation` },
            { id: 'q2', promptI18nKey: `${BASE}.mate-two-rooks.quiz.q2.prompt`,
              options: ['a','b','c'].map((o) => ({ id: o, labelI18nKey: `${BASE}.mate-two-rooks.quiz.q2.opt.${o}` })),
              correctOptionIds: ['a'], explanationI18nKey: `${BASE}.mate-two-rooks.quiz.q2.explanation` },
          ],
          passThreshold: 0.7,
        },
      },
      {
        id: 'practice',
        order: 2,
        payload: {
          type: 'puzzle',
          selection: { mode: 'filter', themes: ['mate', 'mateIn2', 'endgame'], ratingMax: 1000, limit: 4 },
          minSolved: 2,
        },
      },
    ],
  },

  // 2.4 Типовые маты
  {
    slug: 'mate-patterns-recognition',
    order: 11,
    blockKey: BLOCK,
    kind: 'quiz',
    estMinutes: 12,
    titleKey: `${BASE}.mate-patterns-recognition.title`,
    summaryKey: `${BASE}.mate-patterns-recognition.summary`,
    isPublished: true,
    steps: [
      {
        id: 'intro',
        order: 0,
        payload: {
          type: 'text',
          bodyMarkdown: [
            'Кроме «учебных» матов, есть типовые картинки, которые снова и снова встречаются в реальных партиях. Умея их узнавать, ты и поставишь их сам, и не попадёшься на них.',
            '',
            '**Линейный мат** — мат двумя тяжёлыми фигурами (ладьи или ферзь+ладья) по соседним линиям, когда король зажат на краю. Классическая «лесенка» из предыдущего урока — разновидность линейного мата.',
            '',
            '{{diagram:0}}',
            '',
            '**Детский мат (мат Школьника)** — мат ферзём на f7 (для чёрных — f2) при поддержке слона на c4. Получается в 4 хода от начальной позиции, если соперник не защищается. Новички любят его пробовать, но против любого внимательного противника он не проходит.',
            '',
            '{{diagram:1}}',
            '',
            '**Защита от детского мата:** главное — защитить пункт f7/f2. Типовые ходы: 1...Кc6 (защищает пешку e5 и развивает фигуру), 2...g6 (прогоняет ферзя h5 и не даёт ему на f7), 2...Фe7 (прямая защита f7). Не стремись контратаковать, сначала защитись.',
            '',
            '**Мат на последней горизонтали** — ладья или ферзь даёт мат по 8-й (1-й) горизонтали королю, зажатому своими же пешками. Профилактика: после рокировки сделай «форточку» — подвинь пешку g, h или f на одну клетку, чтобы у короля было поле для бегства.',
            '',
            '{{diagram:2}}',
            '',
            'На диаграмме: чёрные пешки f7, g7, h7 заперли короля. Белая ладья приходит на 8-ю — мат. Простейшая профилактика: h7-h6 или g7-g6.',
          ].join('\n'),
          diagrams: [
            { fen: 'R5rk/5p1p/8/8/8/8/8/6K1 w - - 0 1', caption: 'Мат по 8-й ладьёй — чёрный король на h8 заперт своими пешками.', orientation: 'white' },
            { fen: 'r1bqkb1r/pppp1Qpp/2n5/4p3/2B1n3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4', caption: 'Детский мат: ферзь f7 под защитой слона c4. Чёрным мат.', orientation: 'white' },
            { fen: '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', caption: 'Мат на последней горизонтали: пешки f7, g7, h7 не дают королю уйти с 8-й.', orientation: 'white' },
          ],
        },
      },
      {
        id: 'quiz',
        order: 1,
        payload: {
          type: 'quiz',
          questions: [
            { id: 'q1', promptI18nKey: `${BASE}.mate-patterns-recognition.quiz.q1.prompt`,
              options: ['a','b','c','d'].map((o) => ({ id: o, labelI18nKey: `${BASE}.mate-patterns-recognition.quiz.q1.opt.${o}` })),
              correctOptionIds: ['b'], explanationI18nKey: `${BASE}.mate-patterns-recognition.quiz.q1.explanation` },
            { id: 'q2', promptI18nKey: `${BASE}.mate-patterns-recognition.quiz.q2.prompt`,
              options: ['a','b','c'].map((o) => ({ id: o, labelI18nKey: `${BASE}.mate-patterns-recognition.quiz.q2.opt.${o}` })),
              correctOptionIds: ['a'], explanationI18nKey: `${BASE}.mate-patterns-recognition.quiz.q2.explanation` },
            { id: 'q3', promptI18nKey: `${BASE}.mate-patterns-recognition.quiz.q3.prompt`,
              options: ['a','b','c','d'].map((o) => ({ id: o, labelI18nKey: `${BASE}.mate-patterns-recognition.quiz.q3.opt.${o}` })),
              correctOptionIds: ['b'], explanationI18nKey: `${BASE}.mate-patterns-recognition.quiz.q3.explanation` },
            { id: 'q4', promptI18nKey: `${BASE}.mate-patterns-recognition.quiz.q4.prompt`,
              options: ['a','b','c'].map((o) => ({ id: o, labelI18nKey: `${BASE}.mate-patterns-recognition.quiz.q4.opt.${o}` })),
              correctOptionIds: ['a'], explanationI18nKey: `${BASE}.mate-patterns-recognition.quiz.q4.explanation` },
          ],
          passThreshold: 0.7,
        },
      },
      {
        id: 'practice',
        order: 2,
        payload: {
          type: 'puzzle',
          selection: { mode: 'filter', themes: ['backRankMate', 'mateIn1', 'mateIn2'], ratingMax: 1300, limit: 6 },
          minSolved: 4,
        },
      },
    ],
  },
];
