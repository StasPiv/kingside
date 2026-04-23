import type { LessonFixture } from '../../../fixture-types';

const BLOCK = 'rules';
const BASE = 'lessons.beginner';

/** Блок 1 — правила и фигуры (8 уроков). */
export const block01Rules: LessonFixture[] = [
  // 1.1 Доска, координаты
  {
    slug: 'board-coordinates',
    order: 0,
    blockKey: BLOCK,
    kind: 'theory',
    estMinutes: 8,
    titleKey: `${BASE}.board-coordinates.title`,
    summaryKey: `${BASE}.board-coordinates.summary`,
    isPublished: true,
    steps: [
      {
        id: 'intro',
        order: 0,
        payload: {
          type: 'text',
          bodyMarkdown: [
            'Шахматная доска — это квадрат из 64 клеток: 8 вертикалей и 8 горизонталей. Клетки чередуются светлыми и тёмными. Важное правило расстановки: **правый нижний угол у каждого игрока — светлый**.',
            '',
            'Вертикали обозначаются латинскими буквами слева направо: **a, b, c, d, e, f, g, h**. Горизонтали — цифрами снизу вверх с точки зрения белых: **1, 2, 3, 4, 5, 6, 7, 8**.',
            '',
            '{{diagram:0}}',
            '',
            'Каждая клетка имеет имя из буквы и цифры. Например, клетка в левом нижнем углу у белых — **a1**, в правом верхнем — **h8**. Клетка **e4** находится в центре доски.',
            '',
            'Белые фигуры в начальной позиции стоят на 1-й и 2-й горизонталях, чёрные — на 7-й и 8-й.',
          ].join('\n'),
          diagrams: [
            {
              fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
              caption: 'Начальная позиция. Запомни: правый угол у каждого игрока — светлый.',
              orientation: 'white',
            },
          ],
        },
      },
      {
        id: 'quiz',
        order: 1,
        payload: {
          type: 'quiz',
          questions: [
            {
              id: 'q1',
              promptI18nKey: `${BASE}.board-coordinates.quiz.q1.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.board-coordinates.quiz.q1.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.board-coordinates.quiz.q1.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.board-coordinates.quiz.q1.opt.c` },
                { id: 'd', labelI18nKey: `${BASE}.board-coordinates.quiz.q1.opt.d` },
              ],
              correctOptionIds: ['b'],
              explanationI18nKey: `${BASE}.board-coordinates.quiz.q1.explanation`,
            },
            {
              id: 'q2',
              promptI18nKey: `${BASE}.board-coordinates.quiz.q2.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.board-coordinates.quiz.q2.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.board-coordinates.quiz.q2.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.board-coordinates.quiz.q2.opt.c` },
                { id: 'd', labelI18nKey: `${BASE}.board-coordinates.quiz.q2.opt.d` },
              ],
              correctOptionIds: ['c'],
              explanationI18nKey: `${BASE}.board-coordinates.quiz.q2.explanation`,
            },
            {
              id: 'q3',
              promptI18nKey: `${BASE}.board-coordinates.quiz.q3.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.board-coordinates.quiz.q3.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.board-coordinates.quiz.q3.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.board-coordinates.quiz.q3.opt.c` },
                { id: 'd', labelI18nKey: `${BASE}.board-coordinates.quiz.q3.opt.d` },
              ],
              correctOptionIds: ['b'],
              explanationI18nKey: `${BASE}.board-coordinates.quiz.q3.explanation`,
            },
          ],
          passThreshold: 0.7,
        },
      },
    ],
  },

  // 1.2 Пешка
  {
    slug: 'pawn-moves',
    order: 1,
    blockKey: BLOCK,
    kind: 'theory',
    estMinutes: 10,
    titleKey: `${BASE}.pawn-moves.title`,
    summaryKey: `${BASE}.pawn-moves.summary`,
    isPublished: true,
    steps: [
      {
        id: 'intro',
        order: 0,
        payload: {
          type: 'text',
          bodyMarkdown: [
            'Пешка — единственная фигура, которая ходит не так, как бьёт.',
            '',
            '**Ход:** пешка двигается строго вперёд на одну клетку. С начальной позиции (2-я горизонталь для белых, 7-я — для чёрных) она может сделать двойной ход — сразу на две клетки вперёд, если обе пусты.',
            '',
            '**Взятие:** пешка бьёт по диагонали на одну клетку вперёд-влево или вперёд-вправо. Если прямо перед пешкой стоит фигура противника, пешка её **не** может взять — только обойти взятием сбоку.',
            '',
            '{{diagram:0}}',
            '',
            '**Взятие на проходе (en passant).** Если пешка противника сделала двойной ход и встала рядом с твоей пешкой (на соседней вертикали, на той же горизонтали), ты можешь взять её так, будто она сделала одинарный ход. Это правило работает **только на следующем ходу** — откажешься, право пропадает.',
            '',
            '{{diagram:1}}',
            '',
            'На диаграмме: чёрные только что сыграли d7-d5. Белая пешка e5 может взять пешку d5 «на проходе» — ходом exd6 (белая пешка встаёт на d6, чёрная пешка d5 уходит с доски).',
            '',
            '**Превращение.** Когда пешка доходит до последней горизонтали (8-й для белых, 1-й для чёрных), она обязательно превращается в любую фигуру своего цвета, кроме короля и пешки. Обычно выбирают ферзя — он сильнее всех.',
          ].join('\n'),
          diagrams: [
            {
              fen: '4k3/8/8/8/3p4/2P1P3/8/4K3 w - - 0 1',
              caption: 'Белая пешка c3 может бить пешку d4. Белая пешка e3 — нет, перед ней никого.',
              orientation: 'white',
            },
            {
              fen: '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1',
              caption: 'Чёрные только что сыграли d7-d5. Белые могут взять на проходе: exd6.',
              orientation: 'white',
            },
          ],
        },
      },
      {
        id: 'quiz',
        order: 1,
        payload: {
          type: 'quiz',
          questions: [
            {
              id: 'q1',
              promptI18nKey: `${BASE}.pawn-moves.quiz.q1.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.pawn-moves.quiz.q1.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.pawn-moves.quiz.q1.opt.b` },
              ],
              correctOptionIds: ['b'],
              explanationI18nKey: `${BASE}.pawn-moves.quiz.q1.explanation`,
            },
            {
              id: 'q2',
              promptI18nKey: `${BASE}.pawn-moves.quiz.q2.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.pawn-moves.quiz.q2.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.pawn-moves.quiz.q2.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.pawn-moves.quiz.q2.opt.c` },
                { id: 'd', labelI18nKey: `${BASE}.pawn-moves.quiz.q2.opt.d` },
              ],
              correctOptionIds: ['b'],
              explanationI18nKey: `${BASE}.pawn-moves.quiz.q2.explanation`,
            },
            {
              id: 'q3',
              promptI18nKey: `${BASE}.pawn-moves.quiz.q3.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.pawn-moves.quiz.q3.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.pawn-moves.quiz.q3.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.pawn-moves.quiz.q3.opt.c` },
                { id: 'd', labelI18nKey: `${BASE}.pawn-moves.quiz.q3.opt.d` },
              ],
              correctOptionIds: ['b'],
              explanationI18nKey: `${BASE}.pawn-moves.quiz.q3.explanation`,
            },
          ],
          passThreshold: 0.7,
        },
      },
    ],
  },

  // 1.3 Конь
  {
    slug: 'knight-moves',
    order: 2,
    blockKey: BLOCK,
    kind: 'theory',
    estMinutes: 10,
    titleKey: `${BASE}.knight-moves.title`,
    summaryKey: `${BASE}.knight-moves.summary`,
    isPublished: true,
    steps: [
      {
        id: 'intro',
        order: 0,
        payload: {
          type: 'text',
          bodyMarkdown: [
            'Конь ходит буквой **Г** (в английских источниках — буквой L): две клетки по вертикали или горизонтали плюс одна поперёк. Всего у коня в центре доски до **8 возможных полей**.',
            '',
            '{{diagram:0}}',
            '',
            'У коня есть особенность, которой нет ни у одной другой фигуры: **он перепрыгивает через любые фигуры** — свои и чужие. Препятствий для него нет, важна только целевая клетка — она должна быть пустой или занята фигурой противника.',
            '',
            '**Конь бьёт так же, как ходит.** Если на поле приземления стоит фигура противника — она снимается с доски, конь занимает её место.',
            '',
            '**Важное свойство:** конь каждым ходом меняет цвет поля. Если он стоит на светлом — следующий ход будет на тёмное, и наоборот. Это пригодится дальше, например, в матовании двумя слонами.',
            '',
            '{{diagram:1}}',
            '',
            'На краю доски возможностей у коня меньше: с угла (например, a1) ему доступны только 2 поля. Поэтому говорят: **«конь на краю — позор».**',
          ].join('\n'),
          diagrams: [
            {
              // KS-1779 / KS-1778: короли в h8/h1 (рекомендация chess-expert)
              fen: '7k/8/8/4N3/8/8/8/7K w - - 0 1',
              caption: 'Конь на e5 контролирует 8 полей: c4, c6, d3, d7, f3, f7, g4, g6.',
              orientation: 'white',
            },
            {
              // KS-1779 / KS-1778: короли в h8/h1
              fen: 'N6k/8/8/8/8/8/8/7K w - - 0 1',
              caption: 'Конь в углу a8: ему доступны всего 2 поля — b6 и c7.',
              orientation: 'white',
            },
          ],
        },
      },
      {
        id: 'quiz',
        order: 1,
        payload: {
          type: 'quiz',
          questions: [
            {
              id: 'q1',
              promptI18nKey: `${BASE}.knight-moves.quiz.q1.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.knight-moves.quiz.q1.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.knight-moves.quiz.q1.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.knight-moves.quiz.q1.opt.c` },
                { id: 'd', labelI18nKey: `${BASE}.knight-moves.quiz.q1.opt.d` },
              ],
              correctOptionIds: ['c'],
              explanationI18nKey: `${BASE}.knight-moves.quiz.q1.explanation`,
            },
            {
              id: 'q2',
              promptI18nKey: `${BASE}.knight-moves.quiz.q2.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.knight-moves.quiz.q2.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.knight-moves.quiz.q2.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.knight-moves.quiz.q2.opt.c` },
                { id: 'd', labelI18nKey: `${BASE}.knight-moves.quiz.q2.opt.d` },
              ],
              correctOptionIds: ['b'],
              explanationI18nKey: `${BASE}.knight-moves.quiz.q2.explanation`,
            },
            {
              id: 'q3',
              promptI18nKey: `${BASE}.knight-moves.quiz.q3.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.knight-moves.quiz.q3.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.knight-moves.quiz.q3.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.knight-moves.quiz.q3.opt.c` },
              ],
              correctOptionIds: ['b'],
              explanationI18nKey: `${BASE}.knight-moves.quiz.q3.explanation`,
            },
          ],
          passThreshold: 0.7,
        },
      },
    ],
  },

  // 1.4 Слон
  {
    slug: 'bishop-moves',
    order: 3,
    blockKey: BLOCK,
    kind: 'theory',
    estMinutes: 8,
    titleKey: `${BASE}.bishop-moves.title`,
    summaryKey: `${BASE}.bishop-moves.summary`,
    isPublished: true,
    steps: [
      {
        id: 'intro',
        order: 0,
        payload: {
          type: 'text',
          bodyMarkdown: [
            'Слон ходит по диагоналям на любое расстояние, пока не упрётся в свою фигуру (тогда встать нельзя) или фигуру противника (её можно взять, встав на её место).',
            '',
            '{{diagram:0}}',
            '',
            'У каждого игрока **два слона**: один стоит на светлом поле (**белопольный слон**), другой — на тёмном (**чернопольный слон**). Важная особенность: **слон никогда не меняет цвет поля.** Если он начал партию на светлом — будет ходить только по светлым клеткам до конца игры.',
            '',
            'Это значит, что два слона одного игрока «делят» работу: белопольный контролирует свою половину клеток, чернопольный — свою. Они никогда не дублируют друг друга.',
            '',
            '{{diagram:1}}',
            '',
            '**Сила слона зависит от открытости позиции.** Когда на доске много пешек, слон часто упирается в них и бездействует — такого называют **«плохой слон»**. Если диагонали открыты, слон может простреливать всю доску и становится очень сильным.',
          ].join('\n'),
          diagrams: [
            {
              fen: '4k3/8/8/8/3B4/8/8/4K3 w - - 0 1',
              caption: 'Слон на d4 контролирует две диагонали — всего 13 полей.',
              orientation: 'white',
            },
            {
              // KS-1779 / KS-1778: белый король на e2 (рекомендация chess-expert)
              fen: '4k3/8/8/8/8/2B5/1P2K3/B7 w - - 0 1',
              caption: 'Белопольный слон на c3 и чернопольный слон на a1: работают на разных цветах.',
              orientation: 'white',
            },
          ],
        },
      },
      {
        id: 'quiz',
        order: 1,
        payload: {
          type: 'quiz',
          questions: [
            {
              id: 'q1',
              promptI18nKey: `${BASE}.bishop-moves.quiz.q1.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.bishop-moves.quiz.q1.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.bishop-moves.quiz.q1.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.bishop-moves.quiz.q1.opt.c` },
                { id: 'd', labelI18nKey: `${BASE}.bishop-moves.quiz.q1.opt.d` },
              ],
              correctOptionIds: ['b'],
              explanationI18nKey: `${BASE}.bishop-moves.quiz.q1.explanation`,
            },
            {
              id: 'q2',
              promptI18nKey: `${BASE}.bishop-moves.quiz.q2.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.bishop-moves.quiz.q2.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.bishop-moves.quiz.q2.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.bishop-moves.quiz.q2.opt.c` },
              ],
              correctOptionIds: ['c'],
              explanationI18nKey: `${BASE}.bishop-moves.quiz.q2.explanation`,
            },
            {
              id: 'q3',
              promptI18nKey: `${BASE}.bishop-moves.quiz.q3.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.bishop-moves.quiz.q3.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.bishop-moves.quiz.q3.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.bishop-moves.quiz.q3.opt.c` },
                { id: 'd', labelI18nKey: `${BASE}.bishop-moves.quiz.q3.opt.d` },
              ],
              correctOptionIds: ['b'],
              explanationI18nKey: `${BASE}.bishop-moves.quiz.q3.explanation`,
            },
          ],
          passThreshold: 0.7,
        },
      },
    ],
  },

  // 1.5 Ладья
  {
    slug: 'rook-moves',
    order: 4,
    blockKey: BLOCK,
    kind: 'theory',
    estMinutes: 8,
    titleKey: `${BASE}.rook-moves.title`,
    summaryKey: `${BASE}.rook-moves.summary`,
    isPublished: true,
    steps: [
      {
        id: 'intro',
        order: 0,
        payload: {
          type: 'text',
          bodyMarkdown: [
            'Ладья ходит по вертикалям и горизонталям на любое расстояние. Перепрыгивать фигуры она не может: если на пути стоит своя фигура — встать нельзя, если чужая — её можно взять.',
            '',
            '{{diagram:0}}',
            '',
            'Ладья в центре пустой доски контролирует **14 полей** — больше, чем слон (13). Это одна из самых мощных фигур, её условная ценность — **5** (у слона и коня — 3).',
            '',
            'Ладьи особенно сильны на **открытых и полуоткрытых линиях** — вертикалях, где нет пешек или есть только пешки противника. В миттельшпиле и эндшпиле одна из главных задач — вывести ладью на такую линию.',
            '',
            '{{diagram:1}}',
            '',
            '**Две ладьи на одной вертикали или горизонтали** называются **«сдвоенными ладьями»**. Это очень сильная конструкция: они защищают друг друга и с удвоенной силой давят на линию.',
          ].join('\n'),
          diagrams: [
            {
              fen: '4k3/8/8/8/3R4/8/8/4K3 w - - 0 1',
              caption: 'Ладья на d4 контролирует 14 полей — всю вертикаль и горизонталь.',
              orientation: 'white',
            },
            {
              // KS-1779 / KS-1778: белый король на e3 (рекомендация chess-expert)
              fen: '4k3/8/8/8/8/4K3/8/R2R4 w - - 0 1',
              caption: 'Сдвоенные ладьи на 1-й горизонтали — сильная атакующая конструкция.',
              orientation: 'white',
            },
          ],
        },
      },
      {
        id: 'quiz',
        order: 1,
        payload: {
          type: 'quiz',
          questions: [
            {
              id: 'q1',
              promptI18nKey: `${BASE}.rook-moves.quiz.q1.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.rook-moves.quiz.q1.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.rook-moves.quiz.q1.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.rook-moves.quiz.q1.opt.c` },
                { id: 'd', labelI18nKey: `${BASE}.rook-moves.quiz.q1.opt.d` },
              ],
              correctOptionIds: ['c'],
              explanationI18nKey: `${BASE}.rook-moves.quiz.q1.explanation`,
            },
            {
              id: 'q2',
              promptI18nKey: `${BASE}.rook-moves.quiz.q2.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.rook-moves.quiz.q2.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.rook-moves.quiz.q2.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.rook-moves.quiz.q2.opt.c` },
              ],
              correctOptionIds: ['b'],
              explanationI18nKey: `${BASE}.rook-moves.quiz.q2.explanation`,
            },
          ],
          passThreshold: 0.7,
        },
      },
    ],
  },

  // 1.6 Ферзь
  {
    slug: 'queen-moves',
    order: 5,
    blockKey: BLOCK,
    kind: 'theory',
    estMinutes: 8,
    titleKey: `${BASE}.queen-moves.title`,
    summaryKey: `${BASE}.queen-moves.summary`,
    isPublished: true,
    steps: [
      {
        id: 'intro',
        order: 0,
        payload: {
          type: 'text',
          bodyMarkdown: [
            'Ферзь объединяет возможности ладьи и слона: ходит по вертикалям, горизонталям и диагоналям на любое расстояние. Перепрыгивать через фигуры не может.',
            '',
            '{{diagram:0}}',
            '',
            'Ферзь в центре пустой доски контролирует до **27 полей** — больше, чем любая другая фигура. Его условная ценность — **9** (больше ладьи и лёгкой фигуры вместе взятых).',
            '',
            'Но именно из-за своей силы ферзь — **уязвимая мишень**. На него легко нападают лёгкими фигурами и пешками, заставляя отступать и теряя темпы. Поэтому **не стоит рано выводить ферзя в дебюте**: его будут гонять, а сам он развития не помогает.',
            '',
            '{{diagram:1}}',
            '',
            'На диаграмме — характерный пример: белые рано вывели ферзя на h5, чёрные защитились и теперь ходом Кc6 или g6 прогоняют ферзя, при этом сами развивают фигуры. Белые потеряли время.',
            '',
            '**Правило:** сначала выводи лёгкие фигуры (кони, слоны), а ферзя — только когда найдёшь для него конкретную работу.',
          ].join('\n'),
          diagrams: [
            {
              // KS-1779 / KS-1778: ключевой случай — короли НЕ на d-вертикали,
              // не на 4-й горизонтали и не на диагоналях ферзя (a8/h1 — рек).
              fen: 'k7/8/8/8/3Q4/8/8/7K w - - 0 1',
              caption: 'Ферзь на d4 — 27 полей под контролем.',
              orientation: 'white',
            },
            {
              fen: 'rnbqkbnr/pppp1ppp/8/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 2 2',
              caption: 'Белые рано вывели ферзя на h5. Любой удар по нему — и чёрные получат темп на развитие.',
              orientation: 'white',
            },
          ],
        },
      },
      {
        id: 'quiz',
        order: 1,
        payload: {
          type: 'quiz',
          questions: [
            {
              id: 'q1',
              promptI18nKey: `${BASE}.queen-moves.quiz.q1.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.queen-moves.quiz.q1.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.queen-moves.quiz.q1.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.queen-moves.quiz.q1.opt.c` },
                { id: 'd', labelI18nKey: `${BASE}.queen-moves.quiz.q1.opt.d` },
              ],
              correctOptionIds: ['c'],
              explanationI18nKey: `${BASE}.queen-moves.quiz.q1.explanation`,
            },
            {
              id: 'q2',
              promptI18nKey: `${BASE}.queen-moves.quiz.q2.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.queen-moves.quiz.q2.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.queen-moves.quiz.q2.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.queen-moves.quiz.q2.opt.c` },
                { id: 'd', labelI18nKey: `${BASE}.queen-moves.quiz.q2.opt.d` },
              ],
              correctOptionIds: ['b'],
              explanationI18nKey: `${BASE}.queen-moves.quiz.q2.explanation`,
            },
            {
              id: 'q3',
              promptI18nKey: `${BASE}.queen-moves.quiz.q3.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.queen-moves.quiz.q3.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.queen-moves.quiz.q3.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.queen-moves.quiz.q3.opt.c` },
                { id: 'd', labelI18nKey: `${BASE}.queen-moves.quiz.q3.opt.d` },
              ],
              correctOptionIds: ['c'],
              explanationI18nKey: `${BASE}.queen-moves.quiz.q3.explanation`,
            },
          ],
          passThreshold: 0.7,
        },
      },
    ],
  },

  // 1.7 Король и рокировка
  {
    slug: 'king-and-castling',
    order: 6,
    blockKey: BLOCK,
    kind: 'theory',
    estMinutes: 12,
    titleKey: `${BASE}.king-and-castling.title`,
    summaryKey: `${BASE}.king-and-castling.summary`,
    isPublished: true,
    steps: [
      {
        id: 'intro',
        order: 0,
        payload: {
          type: 'text',
          bodyMarkdown: [
            'Король ходит на одну клетку в любом направлении: по вертикали, горизонтали или диагонали. Бьёт он так же, как ходит.',
            '',
            '{{diagram:0}}',
            '',
            '**Короля нельзя взять — цель шахмат в том, чтобы поставить ему мат.** Ход, после которого король оказывается под шахом, делать запрещено. Поэтому у короля всегда на один шаг меньше возможностей, чем кажется: поля, атакуемые фигурой противника, ему недоступны.',
            '',
            '**Рокировка** — особый ход, в котором одновременно двигаются король и ладья. Это единственный случай, когда фигура за один ход проходит две клетки (король), а ладья «перепрыгивает» через него.',
            '',
            '**Короткая рокировка (О-О):** король двигается на 2 клетки в сторону ладьи на h-линии, ладья становится рядом с королём с другой стороны. Для белых: король e1 → g1, ладья h1 → f1.',
            '',
            '**Длинная рокировка (О-О-О):** король двигается на 2 клетки в сторону ладьи на a-линии, ладья становится рядом с королём. Для белых: король e1 → c1, ладья a1 → d1.',
            '',
            '{{diagram:1}}',
            '',
            '**Условия рокировки (все должны быть соблюдены одновременно):**',
            '1. Король и выбранная ладья **ни разу** не ходили в партии.',
            '2. Между ними нет других фигур.',
            '3. Король **не под шахом** сейчас.',
            '4. Король **не проходит** через поле, атакованное противником.',
            '5. Король **не встаёт** на поле под шахом.',
            '',
            'Ладья при рокировке может проходить через атакованные поля — это касается только короля.',
            '',
            '**Зачем рокироваться?** Рокировка решает сразу две задачи: уводит короля из центра в безопасное место и выводит ладью на центральные вертикали. В дебюте к рокировке нужно стремиться как можно раньше.',
          ].join('\n'),
          diagrams: [
            {
              fen: '7k/8/8/8/3K4/8/8/8 w - - 0 1',
              caption: 'Король на d4 — 8 полей доступны.',
              orientation: 'white',
            },
            {
              fen: 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1',
              caption: 'Готовая позиция для рокировки (обе стороны). Между королём и ладьёй — пусто.',
              orientation: 'white',
            },
          ],
        },
      },
      {
        id: 'quiz',
        order: 1,
        payload: {
          type: 'quiz',
          questions: [
            {
              id: 'q1',
              promptI18nKey: `${BASE}.king-and-castling.quiz.q1.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.king-and-castling.quiz.q1.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.king-and-castling.quiz.q1.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.king-and-castling.quiz.q1.opt.c` },
                { id: 'd', labelI18nKey: `${BASE}.king-and-castling.quiz.q1.opt.d` },
              ],
              correctOptionIds: ['b'],
              explanationI18nKey: `${BASE}.king-and-castling.quiz.q1.explanation`,
            },
            {
              id: 'q2',
              promptI18nKey: `${BASE}.king-and-castling.quiz.q2.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.king-and-castling.quiz.q2.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.king-and-castling.quiz.q2.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.king-and-castling.quiz.q2.opt.c` },
                { id: 'd', labelI18nKey: `${BASE}.king-and-castling.quiz.q2.opt.d` },
              ],
              correctOptionIds: ['d'],
              explanationI18nKey: `${BASE}.king-and-castling.quiz.q2.explanation`,
            },
            {
              id: 'q3',
              promptI18nKey: `${BASE}.king-and-castling.quiz.q3.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.king-and-castling.quiz.q3.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.king-and-castling.quiz.q3.opt.b` },
              ],
              correctOptionIds: ['a'],
              explanationI18nKey: `${BASE}.king-and-castling.quiz.q3.explanation`,
            },
            {
              id: 'q4',
              promptI18nKey: `${BASE}.king-and-castling.quiz.q4.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.king-and-castling.quiz.q4.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.king-and-castling.quiz.q4.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.king-and-castling.quiz.q4.opt.c` },
                { id: 'd', labelI18nKey: `${BASE}.king-and-castling.quiz.q4.opt.d` },
              ],
              correctOptionIds: ['b'],
              explanationI18nKey: `${BASE}.king-and-castling.quiz.q4.explanation`,
            },
          ],
          passThreshold: 0.7,
        },
      },
    ],
  },

  // 1.8 Шах, мат, пат, ничья
  {
    slug: 'check-mate-draw',
    order: 7,
    blockKey: BLOCK,
    kind: 'theory',
    estMinutes: 12,
    titleKey: `${BASE}.check-mate-draw.title`,
    summaryKey: `${BASE}.check-mate-draw.summary`,
    isPublished: true,
    steps: [
      {
        id: 'intro',
        order: 0,
        payload: {
          type: 'text',
          bodyMarkdown: [
            '**Шах** — это ситуация, когда король находится под ударом фигуры противника. Игрок, чей король под шахом, **обязан** тем же ходом вывести его из-под удара. Есть три способа это сделать:',
            '',
            '1. **Уйти королём** на поле, где он больше не под ударом.',
            '2. **Закрыться** — поставить свою фигуру между атакующей и королём (не работает от шаха конём или пешкой — через них нельзя закрыться).',
            '3. **Взять атакующую фигуру** — самим королём (если это безопасно) или любой другой фигурой.',
            '',
            '**Мат** — это шах, от которого нет ни одного из трёх способов защиты. Партия заканчивается победой атакующего.',
            '',
            '{{diagram:0}}',
            '',
            'На диаграмме — классический детский мат: чёрный король f8 атакован ферзём f7, ни уйти, ни закрыться, ни взять ферзя — чёрные получают мат.',
            '',
            '**Пат** — это ситуация, когда у игрока на ходу **нет ни одного легального хода**, но при этом **его король НЕ под шахом**. Пат — это **ничья**. Важно отличать: нет ходов + король под шахом = мат, нет ходов + король в безопасности = пат.',
            '',
            '{{diagram:1}}',
            '',
            'Пат часто спасает проигрывающую сторону. Когда у тебя мало материала, не забывай искать шансы на пат.',
            '',
            '**Другие способы ничьей:**',
            '- **По соглашению.** Оба игрока согласны закончить партию вничью.',
            '- **Троекратное повторение позиции.** Если одна и та же позиция (с тем же ходом, теми же возможностями рокировки и взятия на проходе) повторилась три раза, можно требовать ничью.',
            '- **Правило 50 ходов.** Если 50 ходов подряд не было ни взятия, ни хода пешкой, позиция считается ничейной.',
            '- **Недостаток материала.** Если ни у одной стороны нет материала, достаточного для мата (например, только короли, или король и конь против короля) — автоматическая ничья.',
          ].join('\n'),
          diagrams: [
            {
              fen: 'r1bqkb1r/pppp1Qpp/2n5/4p3/2B1n3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4',
              caption: 'Чёрным мат. Ферзь f7 даёт шах, король f8 не имеет полей, закрыться нельзя, ферзя защищает слон c4.',
              orientation: 'white',
            },
            {
              fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1',
              caption: 'Ход чёрных. Король не под шахом, но ни одного легального хода нет — это пат, ничья.',
              orientation: 'white',
            },
          ],
        },
      },
      {
        id: 'quiz',
        order: 1,
        payload: {
          type: 'quiz',
          questions: [
            {
              id: 'q1',
              promptI18nKey: `${BASE}.check-mate-draw.quiz.q1.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.check-mate-draw.quiz.q1.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.check-mate-draw.quiz.q1.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.check-mate-draw.quiz.q1.opt.c` },
              ],
              correctOptionIds: ['a'],
              explanationI18nKey: `${BASE}.check-mate-draw.quiz.q1.explanation`,
            },
            {
              id: 'q2',
              promptI18nKey: `${BASE}.check-mate-draw.quiz.q2.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.check-mate-draw.quiz.q2.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.check-mate-draw.quiz.q2.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.check-mate-draw.quiz.q2.opt.c` },
              ],
              correctOptionIds: ['b'],
              explanationI18nKey: `${BASE}.check-mate-draw.quiz.q2.explanation`,
            },
            {
              id: 'q3',
              promptI18nKey: `${BASE}.check-mate-draw.quiz.q3.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.check-mate-draw.quiz.q3.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.check-mate-draw.quiz.q3.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.check-mate-draw.quiz.q3.opt.c` },
              ],
              correctOptionIds: ['b'],
              explanationI18nKey: `${BASE}.check-mate-draw.quiz.q3.explanation`,
            },
            {
              id: 'q4',
              promptI18nKey: `${BASE}.check-mate-draw.quiz.q4.prompt`,
              options: [
                { id: 'a', labelI18nKey: `${BASE}.check-mate-draw.quiz.q4.opt.a` },
                { id: 'b', labelI18nKey: `${BASE}.check-mate-draw.quiz.q4.opt.b` },
                { id: 'c', labelI18nKey: `${BASE}.check-mate-draw.quiz.q4.opt.c` },
              ],
              correctOptionIds: ['b'],
              explanationI18nKey: `${BASE}.check-mate-draw.quiz.q4.explanation`,
            },
          ],
          passThreshold: 0.7,
        },
      },
    ],
  },
];
