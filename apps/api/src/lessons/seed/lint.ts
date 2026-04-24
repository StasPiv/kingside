/**
 * Линтер seed-фикстур раздела «Уроки» (ADR-024 §2.2).
 *
 * Проверки:
 *  1. Shape `payload` соответствует дискриминированному union'у
 *     `StepPayload` из `@kingside/shared` (валидация через class-validator
 *     на `StepPayloadDto`).
 *  2. Все `fen` (TextStep.diagrams, PuzzleStep.selection, PositionStep,
 *     QuizQuestion) валидны — грузим `chess.js` и проверяем `.load(fen)`.
 *  3. PGN в `GameReviewStepPayload.pgn` — парсится `chess.js`.
 *  4. Для `PuzzleStep` с `mode='ids'` — каждый `puzzleId` существует в
 *     таблице `puzzles` (используется PrismaClient, если передан).
 *  5. Уникальность `course.slug` и `(course.slug, lesson.slug)` и
 *     `step.id` в рамках урока.
 *
 * Запускается:
 *  - автономно: `npm run seed:lessons:lint` (без БД — проверки 1–3, 5).
 *  - из `seed:lessons`-скрипта перед upsert'ом (с БД — все 5 проверок).
 *
 * Ошибки собираются в массив `LinterError[]` и выводятся в stderr;
 * процесс завершает `exitCode = 1` при любой.
 */

import 'reflect-metadata';
import { Chess } from 'chess.js';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import type { PrismaClient } from '@kingside/db';
import type { StepPayload } from '@kingside/shared';
import type { CourseFixture, LessonFixture, StepFixture } from './fixture-types';
import {
  TextStepPayloadDto,
  PuzzleStepPayloadDto,
  QuizStepPayloadDto,
  PositionStepPayloadDto,
  GameReviewStepPayloadDto,
  VideoStepPayloadDto,
} from '../dto/step-payload.dto';
import { isValidFen, isLegalUciOnFen } from '../dto/position-step.validators';
import { ALLOWED_VIDEO_HOSTS, isAllowedVideoUrl } from '@kingside/shared';

export interface LinterError {
  path: string; // напр. "beginner-basics/how-knight-moves/step-2/payload.fen"
  message: string;
}

const PAYLOAD_DTO_BY_TYPE = {
  text: TextStepPayloadDto,
  puzzle: PuzzleStepPayloadDto,
  quiz: QuizStepPayloadDto,
  position: PositionStepPayloadDto,
  game_review: GameReviewStepPayloadDto,
  video: VideoStepPayloadDto,
} as const;

export interface LintOptions {
  /** Если передан — линтер проверит существование `puzzleId` в БД. */
  prisma?: PrismaClient;
}

export async function lintFixtures(
  courses: CourseFixture[],
  options: LintOptions = {},
): Promise<LinterError[]> {
  const errors: LinterError[] = [];

  // ── Уникальность course.slug ─────────────────────────────────────
  const courseSlugs = new Set<string>();
  for (const course of courses) {
    if (courseSlugs.has(course.slug)) {
      errors.push({ path: `courses`, message: `Duplicate course.slug "${course.slug}"` });
    }
    courseSlugs.add(course.slug);
  }

  // ── Собираем puzzleId для одного запроса к БД ────────────────────
  const puzzleIds = new Set<string>();

  for (const course of courses) {
    const lessonSlugs = new Set<string>();
    for (const lesson of course.lessons) {
      const lessonPath = `${course.slug}/${lesson.slug}`;

      if (lessonSlugs.has(lesson.slug)) {
        errors.push({
          path: course.slug,
          message: `Duplicate lesson.slug "${lesson.slug}" in course "${course.slug}"`,
        });
      }
      lessonSlugs.add(lesson.slug);

      await lintLesson(lesson, course.slug, errors, puzzleIds);
    }
  }

  // ── Проверяем существование puzzleId ─────────────────────────────
  if (options.prisma && puzzleIds.size > 0) {
    const ids = Array.from(puzzleIds);
    const found = await options.prisma.puzzle.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const foundIds = new Set(found.map((p) => p.id));
    for (const id of ids) {
      if (!foundIds.has(id)) {
        errors.push({
          path: `puzzles`,
          message: `puzzleId "${id}" not found in puzzles table`,
        });
      }
    }
  }

  return errors;
}

async function lintLesson(
  lesson: LessonFixture,
  courseSlug: string,
  errors: LinterError[],
  puzzleIds: Set<string>,
): Promise<void> {
  const stepIds = new Set<string>();
  for (const step of lesson.steps) {
    const stepPath = `${courseSlug}/${lesson.slug}/${step.id}`;
    if (stepIds.has(step.id)) {
      errors.push({ path: stepPath, message: `Duplicate step.id "${step.id}"` });
    }
    stepIds.add(step.id);

    await lintStep(step, stepPath, errors, puzzleIds);
  }
}

async function lintStep(
  step: StepFixture,
  stepPath: string,
  errors: LinterError[],
  puzzleIds: Set<string>,
): Promise<void> {
  const payload = step.payload;
  const dtoClass = PAYLOAD_DTO_BY_TYPE[payload.type as keyof typeof PAYLOAD_DTO_BY_TYPE];
  if (!dtoClass) {
    errors.push({ path: stepPath, message: `Unknown payload.type "${payload.type}"` });
    return;
  }

  // 1. class-validator по дискриминированному union
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instance = plainToInstance(dtoClass as any, payload);
  const validationErrors = await validate(instance as object, {
    whitelist: true,
    forbidUnknownValues: false,
  });
  for (const ve of validationErrors) {
    for (const constraint of Object.values(ve.constraints ?? {})) {
      errors.push({
        path: `${stepPath}.payload.${ve.property}`,
        message: constraint,
      });
    }
  }

  // 2. FEN / PGN / puzzleIds — доменные проверки
  collectChessChecks(payload, stepPath, errors, puzzleIds);
}

function collectChessChecks(
  payload: StepPayload,
  stepPath: string,
  errors: LinterError[],
  puzzleIds: Set<string>,
): void {
  switch (payload.type) {
    case 'text': {
      if (!payload.bodyI18nKey && !payload.bodyMarkdown) {
        errors.push({
          path: `${stepPath}.payload`,
          message: `TextStep must have either bodyI18nKey or bodyMarkdown`,
        });
      }
      for (const [i, d] of (payload.diagrams ?? []).entries()) {
        checkFen(d.fen, `${stepPath}.payload.diagrams[${i}].fen`, errors);
      }
      break;
    }
    case 'puzzle': {
      if (payload.selection.mode === 'ids') {
        for (const id of payload.selection.puzzleIds) {
          puzzleIds.add(id);
        }
      }
      if (payload.selection.mode === 'filter') {
        if (
          payload.selection.ratingMin !== undefined &&
          payload.selection.ratingMax !== undefined &&
          payload.selection.ratingMin > payload.selection.ratingMax
        ) {
          errors.push({
            path: `${stepPath}.payload.selection`,
            message: `ratingMin (${payload.selection.ratingMin}) > ratingMax (${payload.selection.ratingMax})`,
          });
        }
      }
      break;
    }
    case 'position': {
      // Доменная проверка payload.fen / payload.expectedMoves — через общие
      // хелперы (те же, что и в `PositionStepPayloadDto`), чтобы линтер
      // и рантайм-валидация API репортили одни и те же ошибки.
      const fenOk = isValidFen(payload.fen);
      if (!fenOk) {
        errors.push({
          path: `${stepPath}.payload.fen`,
          message: `Invalid FEN`,
        });
      }
      if (!Array.isArray(payload.expectedMoves) || payload.expectedMoves.length === 0) {
        errors.push({
          path: `${stepPath}.payload.expectedMoves`,
          message: `expectedMoves must be a non-empty array of UCI moves`,
        });
      } else if (fenOk) {
        for (const [i, uci] of payload.expectedMoves.entries()) {
          if (!isLegalUciOnFen(payload.fen, uci)) {
            errors.push({
              path: `${stepPath}.payload.expectedMoves[${i}]`,
              message: `Move "${uci}" is not legal from the given FEN`,
            });
          }
        }
      }
      break;
    }
    case 'quiz': {
      for (const [qi, q] of payload.questions.entries()) {
        if (q.fen) {
          checkFen(q.fen, `${stepPath}.payload.questions[${qi}].fen`, errors);
        }
        const optionIds = new Set(q.options.map((o) => o.id));
        for (const cid of q.correctOptionIds) {
          if (!optionIds.has(cid)) {
            errors.push({
              path: `${stepPath}.payload.questions[${qi}].correctOptionIds`,
              message: `Unknown option id "${cid}"`,
            });
          }
        }
        if (!q.multi && q.correctOptionIds.length !== 1) {
          errors.push({
            path: `${stepPath}.payload.questions[${qi}]`,
            message: `Single-answer question must have exactly 1 correctOptionIds entry`,
          });
        }
      }
      break;
    }
    case 'game_review': {
      if (payload.pgn) {
        const chess = new Chess();
        try {
          chess.loadPgn(payload.pgn);
        } catch (e) {
          errors.push({
            path: `${stepPath}.payload.pgn`,
            message: `PGN parse failed: ${(e as Error).message}`,
          });
        }
      }
      break;
    }
    case 'video': {
      // KS-1808: URL должен быть http(s) и host — в shared-whitelist
      // (`ALLOWED_VIDEO_HOSTS`). Тот же helper использует DTO — словарь
      // поддерживаемых embed-хостов один и не расходится между
      // рантайм-валидацией и pre-seed-линтером.
      if (!isAllowedVideoUrl(payload.url)) {
        errors.push({
          path: `${stepPath}.payload.url`,
          message: `Invalid video URL "${payload.url}": must be http(s) and host in {${ALLOWED_VIDEO_HOSTS.join(', ')}}`,
        });
      }
      break;
    }
  }
}

function checkFen(fen: string, path: string, errors: LinterError[]): void {
  const chess = new Chess();
  try {
    chess.load(fen);
  } catch (e) {
    errors.push({ path, message: `Invalid FEN: ${(e as Error).message}` });
  }
}

