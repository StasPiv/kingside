/**
 * KS-4981 / ADR-167 §2, §5.1: Vision-тренажёр «зрения доски» (board vision).
 * Фундамент (задача 1/7): типы режимов, челленджей и результата сессии.
 *
 * Генерация и оценка — на клиенте (ADR-167 §5): сервер хранит только итог
 * (`VisionResult`). Челлендж — атомарный вопрос одного режима с уже
 * вычисленным правильным ответом (`answer`), проверяемым `validateChallenge`.
 *
 * Геометрия (режимы relation/geometry) считается на существующих утилитах
 * `utils/blind-board/move-gen.ts` — новый движок НЕ вводится (ADR-167 §4, §8).
 */
import type { BlindBoardPieceType, BlindBoardSquare } from './api-contracts.js';

/** Игровой режим тренажёра. `mixed` — случайная смесь конкретных режимов. */
export type VisionMode =
  | 'color'
  | 'find'
  | 'name'
  | 'relation'
  | 'geometry'
  | 'mixed';

/** Конкретный режим челленджа (без `mixed` — это лобби-настройка). */
export type VisionConcreteMode = Exclude<VisionMode, 'mixed'>;

/** Длительность Sprint-сессии (ADR-167 §3). */
export type VisionTimeMode = '30s' | '60s' | '120s';

/** Цвет клетки. Правило ADR-167 §1: `(file+rank)` чётная → тёмная. */
export type VisionSquareColor = 'light' | 'dark';

/** Вид отношения двух клеток (режим 4, ADR-167 §2). */
export type VisionRelationKind = 'diagonal' | 'file' | 'rank' | 'color';

// --- Челленджи (дискриминированный union по `mode`) ------------------------

/** Режим 1: цвет клетки. Показана координата/подсветка → светлая/тёмная. */
export interface VisionColorChallenge {
  mode: 'color';
  square: BlindBoardSquare;
  answer: VisionSquareColor;
}

/** Режим 2: найди клетку. Показана координата → клик по пустой доске. */
export interface VisionFindChallenge {
  mode: 'find';
  /** Координата-вопрос (текст). */
  square: BlindBoardSquare;
  /** Верная клетка (== `square`). */
  answer: BlindBoardSquare;
}

/** Режим 3: назови клетку. Подсвечена клетка → ввод координаты. */
export interface VisionNameChallenge {
  mode: 'name';
  /** Подсвеченная клетка. */
  square: BlindBoardSquare;
  /** Верная координата (== `square`). */
  answer: BlindBoardSquare;
}

/** Режим 4: отношение двух клеток. Да/Нет по виду `relation`. */
export interface VisionRelationChallenge {
  mode: 'relation';
  a: BlindBoardSquare;
  b: BlindBoardSquare;
  relation: VisionRelationKind;
  /** Верно ли, что `a` и `b` в отношении `relation`. */
  answer: boolean;
}

/** Режим 5: геометрия фигуры. «Бьёт ли `piece` с `from` клетку `target`?» */
export interface VisionGeometryChallenge {
  mode: 'geometry';
  piece: BlindBoardPieceType;
  from: BlindBoardSquare;
  target: BlindBoardSquare;
  /** Атакует ли `piece` с `from` клетку `target` (на пустой доске). */
  answer: boolean;
}

/** Любой конкретный челлендж тренажёра. */
export type VisionChallenge =
  | VisionColorChallenge
  | VisionFindChallenge
  | VisionNameChallenge
  | VisionRelationChallenge
  | VisionGeometryChallenge;

/** Ответ пользователя по каждому режиму (для `checkAnswer`). */
export type VisionAnswerValue<M extends VisionConcreteMode> =
  M extends 'color' ? VisionSquareColor :
  M extends 'find' ? BlindBoardSquare :
  M extends 'name' ? BlindBoardSquare :
  M extends 'relation' ? boolean :
  M extends 'geometry' ? boolean :
  never;

// --- Результат сессии (ADR-167 §5.1, модель VisionScore) -------------------

/**
 * Итог одной Sprint-сессии — тело `POST /vision/results` (backend 2/7).
 * Отражает поля модели `VisionScore` (ADR-167 §5.1), без БД-мета.
 */
export interface VisionResult {
  mode: VisionMode;
  timeMode: VisionTimeMode;
  /** Уровень сложности 1..N (ADR-167 §2.1). */
  difficulty: number;
  /** Верных ответов. */
  score: number;
  /** Всего вопросов. */
  total: number;
  /** Точность 0..1. */
  accuracy: number;
  maxStreak: number;
  avgResponseMs: number;
}

/** Все режимы (whitelist для валидации DTO). */
export const VISION_MODES: readonly VisionMode[] = [
  'color',
  'find',
  'name',
  'relation',
  'geometry',
  'mixed',
];

/** Все длительности Sprint (whitelist). */
export const VISION_TIME_MODES: readonly VisionTimeMode[] = [
  '30s',
  '60s',
  '120s',
];

// --- Контракты API /vision/* (ADR-167 §5) ----------------------------------

/** Ответ `POST /vision/results`. Гость → `saved:false, scoreId:null`. */
export interface VisionSubmitResultResponse {
  saved: boolean;
  scoreId: string | null;
}

/** Запись лидерборда (лучший результат пользователя для mode+timeMode). */
export interface VisionLeaderboardEntry {
  userId: string;
  username: string;
  mode: VisionMode;
  timeMode: VisionTimeMode;
  score: number;
  accuracy: number;
  createdAt: string;
}

/** Ответ `GET /vision/leaderboard`. */
export interface VisionLeaderboardResponse {
  mode: VisionMode;
  timeMode: VisionTimeMode;
  entries: VisionLeaderboardEntry[];
}

/** Ответ `GET /vision/stats/me`. */
export interface VisionStatsResponse {
  totalSessions: number;
  bestScore: number;
  /** Средняя точность по всем сессиям, 0..1. */
  avgAccuracy: number;
  bestMaxStreak: number;
  /** Среднее время ответа (мс) по всем сессиям. */
  avgResponseMs: number;
  byMode: Array<{ mode: VisionMode; sessions: number; bestScore: number }>;
}

/** Элемент истории `GET /vision/history`. */
export interface VisionHistoryItem {
  id: string;
  mode: VisionMode;
  timeMode: VisionTimeMode;
  difficulty: number;
  score: number;
  total: number;
  accuracy: number;
  maxStreak: number;
  avgResponseMs: number;
  createdAt: string;
}

/** Ответ `GET /vision/history` (курсорная пагинация). */
export interface VisionHistoryResponse {
  items: VisionHistoryItem[];
  nextCursor: string | null;
  hasMore: boolean;
}
