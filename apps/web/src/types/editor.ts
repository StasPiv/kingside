import type {
  CourseLevel,
  EndgameDrillStepPayload,
  GameReviewStepPayload,
  LessonKind,
  LessonStepType,
  PositionStepPayload,
  PuzzleStepPayload,
  QuizStepPayload,
  StepPayload,
  TextStepPayload,
  VideoStepPayload,
} from '@kingside/shared';

/**
 * Структуры, используемые редактором уроков (L-27 / KS-1805). Повторяют
 * форму seed-фикстур backend'а (`apps/api/src/lessons/seed/fixture-types.ts`)
 * — полные тексты статей/вопросов пишутся прямо в payload'ах в виде
 * inline-строк (i18n-ключи в seed'ах — это уже задача автора перед
 * коммитом файла; редактор выдаёт starter-шаблон).
 *
 * Фактическая строковая форма экспорта формируется в `utils/exportFixture.ts`.
 */

export interface StepFixture {
  /** Стабильный client-side id для списков React; в экспорт не попадает. */
  id: string;
  order: number;
  type: LessonStepType;
  payload: StepPayload;
}

export interface LessonFixture {
  id: string;
  slug: string;
  order: number;
  blockKey: string;
  kind: LessonKind;
  titleI18nKey: string;
  summaryI18nKey: string;
  estMinutes: number;
  steps: StepFixture[];
}

export interface CourseFixture {
  slug: string;
  level: CourseLevel;
  titleI18nKey: string;
  descriptionI18nKey: string;
  order: number;
  isPublished: boolean;
  lessons: LessonFixture[];
}

// ─── Factories ───────────────────────────────────────────────────────

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

export function createEmptyCourse(): CourseFixture {
  return {
    slug: '',
    level: 'beginner',
    titleI18nKey: '',
    descriptionI18nKey: '',
    order: 1,
    isPublished: false,
    lessons: [],
  };
}

export function createEmptyLesson(order: number): LessonFixture {
  return {
    id: nextId('lesson'),
    slug: '',
    order,
    blockKey: 'other',
    kind: 'theory',
    titleI18nKey: '',
    summaryI18nKey: '',
    estMinutes: 5,
    steps: [],
  };
}

/**
 * Пустой payload под каждый тип шага. Минимальные дефолты, чтобы форма
 * сразу была валидна типом (без `any`), а автор дозаполнил нужные поля.
 */
export function emptyStepPayload(type: LessonStepType): StepPayload {
  switch (type) {
    case 'text':
      return {
        type: 'text',
        bodyMarkdown: '',
        diagrams: [],
      } satisfies TextStepPayload;
    case 'puzzle':
      // KS-1873: backend DTO `UserPuzzleStepPayloadDto` (BE-3 / KS-1830)
      // требует и непустой `puzzleIds` (mode=ids), и непустые `themes`
      // (mode=filter) — иначе 400 «should not be empty». Дефолтим на
      // `filter` с одной популярной темой (`middlegame` — широкая,
      // гарантированно есть задачи в lichess-датасете) и узким
      // рейтинговым окном. Автор сразу видит рабочий шаг и может
      // переключить темы / рейтинг / limit (1..20 по DTO).
      return {
        type: 'puzzle',
        selection: {
          mode: 'filter',
          themes: ['middlegame'],
          ratingMin: 1200,
          ratingMax: 1600,
          limit: 3,
        },
      } satisfies PuzzleStepPayload;
    case 'quiz':
      return {
        type: 'quiz',
        questions: [],
      } satisfies QuizStepPayload;
    case 'position':
      return {
        type: 'position',
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        expectedMoves: [],
      } satisfies PositionStepPayload;
    case 'game_review':
      return { type: 'game_review' } satisfies GameReviewStepPayload;
    case 'video':
      return { type: 'video', url: '' } satisfies VideoStepPayload;
    case 'endgame_drill':
      return {
        type: 'endgame_drill',
        fen: '8/8/8/8/4k3/8/3P4/3K4 w - - 0 1',
        playerSide: 'white',
        skillLevel: 5,
        winCondition: { kind: 'promote' },
      } satisfies EndgameDrillStepPayload;
  }
}

export function createEmptyStep(order: number, type: LessonStepType = 'text'): StepFixture {
  return {
    id: nextId('step'),
    order,
    type,
    payload: emptyStepPayload(type),
  };
}
