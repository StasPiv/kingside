import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

/** Полка рейтинга из rating-shelves.json (ADR-160 §2.2 / ADR-162 §3.2). */
export interface RatingShelf {
  key: string;
  label: { en: string; ru: string };
  minRating: number;
  maxRating: number | null;
  courseSlug: string;
  courseFallbackSlugs: string[];
  theoryShare: number;
  practiceShare: number;
  priorityThemes: string[];
  puzzleRatingWindow: { below: number; above: number };
  practiceRotation: string[];
}

interface ShelvesFile {
  schemaVersion: number;
  uncalibrated: { ratingDeviationThreshold: number; fallbackShelf: string };
  shelves: RatingShelf[];
  focusOverrides: Record<
    string,
    {
      courseSlug?: string;
      priorityThemesPrepend?: string[];
      practiceRotationPrepend?: string[];
      theoryShareDelta?: number;
    }
  >;
}

/** Шаблоны урока (lesson-templates.<lang>.json, схема KS-4910). */
export interface LessonTemplates {
  lessonTitle: string;
  introTitle: string;
  introBody: string;
  noteLines: Record<string, string>;
  puzzleInstruction: string;
  gameStepTitle: string;
  gameSelfCheck: string;
  homeworkNote: string;
}

/**
 * KS-4910 / ADR-162 §3.2. Единственный источник полок, текстов и
 * шаблонов уроков — файлы `tools/study-plan/` (закрытие долга v1:
 * захардкоженные константы генератора удалены).
 *
 * Файлы читаются один раз при старте (объёмы — килобайты). Каталог
 * ищется по списку кандидатов: dev (/project/tools/study-plan),
 * прод-образ (/app/tools/study-plan, см. apps/api/Dockerfile), либо
 * STUDY_PLAN_DIR. Файлы не найдены — модуль кидает при старте: пустые
 * полки означают неработающий генератор, лучше явный отказ.
 */
@Injectable()
export class StudyPlanConfigService implements OnModuleInit {
  private readonly logger = new Logger(StudyPlanConfigService.name);
  private shelvesFile!: ShelvesFile;
  private texts: Record<string, Record<string, unknown>> = {};
  private templates: Record<string, { common: LessonTemplates; shelves: Record<string, Partial<LessonTemplates>> }> = {};

  onModuleInit(): void {
    const dir = this.resolveDir();
    this.shelvesFile = JSON.parse(
      readFileSync(path.join(dir, 'rating-shelves.json'), 'utf8'),
    ) as ShelvesFile;
    for (const lang of ['en', 'ru']) {
      this.texts[lang] = JSON.parse(
        readFileSync(path.join(dir, `texts.${lang}.json`), 'utf8'),
      ) as Record<string, unknown>;
      this.templates[lang] = JSON.parse(
        readFileSync(path.join(dir, `lesson-templates.${lang}.json`), 'utf8'),
      ) as (typeof this.templates)[string];
    }
    this.logger.log(
      `study-plan config loaded from ${dir}: ${this.shelvesFile.shelves.length} shelves`,
    );
  }

  private resolveDir(): string {
    const candidates = [
      process.env.STUDY_PLAN_DIR,
      '/project/tools/study-plan',
      '/app/tools/study-plan',
      path.resolve(process.cwd(), '../../tools/study-plan'),
      path.resolve(process.cwd(), 'tools/study-plan'),
    ].filter((p): p is string => !!p);
    for (const dir of candidates) {
      if (existsSync(path.join(dir, 'rating-shelves.json'))) return dir;
    }
    throw new Error(
      `study-plan config not found; searched: ${candidates.join(', ')}`,
    );
  }

  /**
   * Полка по рейтингу с учётом калибровки Glicko (README study-plan):
   * deviation выше порога → fallback-полка, не полка по числу.
   */
  shelfFor(ratingPuzzle: number, ratingPuzzleDev: number): RatingShelf {
    const { uncalibrated, shelves } = this.shelvesFile;
    if (ratingPuzzleDev > uncalibrated.ratingDeviationThreshold) {
      const fb = shelves.find((s) => s.key === uncalibrated.fallbackShelf);
      if (fb) return fb;
    }
    return (
      shelves.find(
        (s) =>
          ratingPuzzle >= s.minRating &&
          (s.maxRating === null || ratingPuzzle < s.maxRating),
      ) ?? shelves[0]
    );
  }

  /** Полка с применённым focus-оверрайдом (ADR-160: StudySchedule.focus). */
  shelfWithFocus(
    ratingPuzzle: number,
    ratingPuzzleDev: number,
    focus: string | null,
  ): RatingShelf {
    const base = this.shelfFor(ratingPuzzle, ratingPuzzleDev);
    const override = focus ? this.shelvesFile.focusOverrides[focus] : undefined;
    if (!override) return base;
    return {
      ...base,
      courseSlug: override.courseSlug ?? base.courseSlug,
      priorityThemes: [
        ...(override.priorityThemesPrepend ?? []),
        ...base.priorityThemes,
      ],
      practiceRotation: [
        ...(override.practiceRotationPrepend ?? []),
        ...base.practiceRotation,
      ],
      theoryShare: Math.min(
        1,
        Math.max(0, base.theoryShare + (override.theoryShareDelta ?? 0)),
      ),
    };
  }

  /**
   * Текст из texts.<lang>.json по плоскому пути ("study.notification.title")
   * с подстановкой {{placeholders}}. Нет ключа → en → сам ключ.
   */
  text(lang: string, key: string, args?: Record<string, string | number>): string {
    const raw =
      this.lookup(this.texts[lang] ?? {}, key) ??
      this.lookup(this.texts.en ?? {}, key) ??
      key;
    return this.fill(String(raw), args);
  }

  /** Шаблоны урока для полки: common + переопределения полки. */
  lessonTemplates(lang: string, shelfKey: string): LessonTemplates {
    const t = this.templates[lang] ?? this.templates.en;
    return { ...t.common, ...(t.shelves[shelfKey] ?? {}) } as LessonTemplates;
  }

  /** Подстановка {{name}} в строку шаблона. */
  fill(template: string, args?: Record<string, string | number>): string {
    if (!args) return template;
    return template.replace(/\{\{(\w+)\}\}/g, (m, name) =>
      name in args ? String(args[name]) : m,
    );
  }

  private lookup(obj: Record<string, unknown>, dotted: string): unknown {
    let cur: unknown = obj;
    for (const part of dotted.split('.')) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return typeof cur === 'string' ? cur : undefined;
  }
}
