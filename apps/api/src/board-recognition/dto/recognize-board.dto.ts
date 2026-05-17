import { IsIn, IsOptional, IsString } from 'class-validator';

/**
 * Body для POST /api/board-recognition (KS-2363, ADR-040 §5.1).
 *
 * Файл доски передаётся как multipart-field `image`; этот DTO покрывает только
 * текстовые поля multipart-form. `profile` управляет выбором стратегии
 * распознавания в `recognizeUniversal()` (см. packages/board-image-to-fen).
 */
export type BoardRecognitionProfile =
  | 'auto'
  | 'maizelis'
  | 'dvoretsky'
  | 'generic';

export const BOARD_RECOGNITION_PROFILES: BoardRecognitionProfile[] = [
  'auto',
  'maizelis',
  'dvoretsky',
  'generic',
];

export class RecognizeBoardDto {
  @IsOptional()
  @IsString()
  @IsIn(BOARD_RECOGNITION_PROFILES, {
    message:
      "profile must be one of 'auto', 'maizelis', 'dvoretsky', 'generic'",
  })
  profile?: BoardRecognitionProfile;
}

/** Cell с низкой уверенностью — попадает в `lowConfidenceCells[]` ответа. */
export interface LowConfidenceCell {
  /** Алгебраическая координата (`e4`, `a1`, ...) с учётом ориентации. */
  square: string;
  /** Предсказанная метка: `empty` / `wK` / ... / `bP`. */
  predicted: string;
  /** Top-1 softmax probability ∈ [0, 1]. */
  confidence: number;
  /** Top-3 предсказаний (для UI «исправить вручную»). */
  top3: Array<{ label: string; prob: number }>;
}

/** Ответ POST /api/board-recognition по ADR-040 §5.1. */
export interface BoardRecognitionResponse {
  /** Полный FEN (board + ` w - - 0 1`). */
  fen: string;
  /** Только board-часть FEN (`8/8/...`). */
  fenBoard: string;
  /** Эффективная ориентация (`white` — белые внизу, `black` — чёрные). */
  orientation: 'white' | 'black';
  /**
   * Уверенность в определённой ориентации ∈ [0, 1]. Для эвристики по
   * королям — 1.0 если оба короля найдены однозначно; для fallback'а
   * (баланс по цветам) — доля «правильной» стороны.
   */
  orientationConfidence: number;
  /** Bbox доски в координатах исходного изображения `[x0, y0, x1, y1]`. */
  bbox: [number, number, number, number];
  /**
   * Версия модели (`v<MAJOR>.<MINOR>[.<PATCH>]`) или `null` в disabled-режиме
   * (модель не загружена, ответ — мок стартовой позиции).
   */
  modelVersion: string | null;
  /** Клетки с уверенностью ниже порога. Можно показать пользователю как «проверить вручную». */
  lowConfidenceCells: LowConfidenceCell[];
  /**
   * Предупреждения, не блокирующие ответ. Примеры:
   *   - `"model not loaded — returning starting position"` (graceful disable);
   *   - `"sanity: white king count = 0 (expected 1)"`;
   *   - `"low confidence: 8 cells"`.
   */
  warnings: string[];
}
