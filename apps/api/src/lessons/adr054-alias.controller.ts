/**
 * KS-2642 / ADR-054 §4 Phase C. Alias-контроллеры для legacy-роутов
 * `/lessons/user-courses/*`, `/lessons/user-lessons/*`,
 * `/lessons/user-lesson-steps/*`, `/lessons/user-progress/*`.
 *
 * При активном фича-флаге `ADR054_UNIFIED_API=true` `UserCoursesModule`
 * регистрирует ЭТИ контроллеры вместо legacy — они на тех же URL, но
 * каждый запрос отдают `HTTP 308 Permanent Redirect` на
 * соответствующий унифицированный URL (`/lessons/courses/*`,
 * `/lessons/lessons/*`, `/lessons/steps/*`, `/lessons/progress/*`).
 *
 * 308 (а не 301/307) — потому что:
 *   1) сохраняет HTTP-метод (POST остаётся POST после редиректа,
 *      `LE5/RFC 7538` гарантирует это явно);
 *   2) семантически означает «постоянный» — клиенты могут кешировать
 *      mapping, что снижает нагрузку.
 *
 * Тело запроса в 308 не пробрасывается: клиент должен повторить запрос
 * на новый URL с тем же `method` и тем же `body`. fetch, axios,
 * node-fetch — оба этого не пробрасывают autoматически из-за CORS-
 * соображений только в браузере; на нашем frontend redirect-fallow
 * вручную не требуется (мы добавим явный `lessonsApi.fetch` в Phase D).
 *
 * Query-string копируется через `req.url` — он содержит и path, и
 * `?…`. `originalUrl` мы не используем, чтобы корректно работать в
 * случае глобального префикса `/api`, который в `main.ts` по умолчанию
 * не включён (но если включится — `req.url` уже без него).
 */

import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { rewriteAdr054AliasUrl } from './adr054.config';

function redirect(req: Request, res: Response): void {
  // `req.url` приходит как `/lessons/user-courses/abc?x=1` — Nest при
  // matching отрезает только глобальный prefix, всё остальное в
  // `req.url`. Это удобно: один вызов `rewriteAdr054AliasUrl` отдаёт
  // готовый Location.
  //
  // Если фича-флаг включился, а запрос почему-то не подпадает под
  // mapping (теоретически невозможно — маршруты совпадают), отдаём
  // 410 Gone. Лучше чем 200 OK на ничего.
  const target = rewriteAdr054AliasUrl(req.url);
  if (!target) {
    res.status(410).json({ error: 'gone', message: 'ADR-054 alias mapping miss' });
    return;
  }
  res.status(308).set('Location', target).json({
    deprecation: true,
    location: target,
    // Поясняющий тег для полевой диагностики: фронт логирует «откуда
    // редиректнули» и видит метку в DevTools.
    tag: 'adr054-phase-c-alias',
  });
}

/**
 * `/lessons/user-courses/*` → `/lessons/courses/*` (включая
 * `enrolled`, `authors`, `:slug`, `:id`, `:id/lessons`,
 * `:id/lessons/reorder`).
 */
@Controller('lessons/user-courses')
export class Adr054UserCoursesAliasController {
  @All()
  rootRedirect(@Req() req: Request, @Res() res: Response): void {
    redirect(req, res);
  }
  @All('*splat')
  subRedirect(@Req() req: Request, @Res() res: Response): void {
    redirect(req, res);
  }
}

/**
 * `/lessons/user-lessons/*` → `/lessons/lessons/*` (включая
 * `:id/steps`, `:id/steps/reorder`).
 */
@Controller('lessons/user-lessons')
export class Adr054UserLessonsAliasController {
  @All()
  rootRedirect(@Req() req: Request, @Res() res: Response): void {
    redirect(req, res);
  }
  @All('*splat')
  subRedirect(@Req() req: Request, @Res() res: Response): void {
    redirect(req, res);
  }
}

/**
 * `/lessons/user-lesson-steps/*` → `/lessons/steps/*`.
 */
@Controller('lessons/user-lesson-steps')
export class Adr054UserLessonStepsAliasController {
  @All()
  rootRedirect(@Req() req: Request, @Res() res: Response): void {
    redirect(req, res);
  }
  @All('*splat')
  subRedirect(@Req() req: Request, @Res() res: Response): void {
    redirect(req, res);
  }
}

/**
 * `/lessons/user-progress/*` → `/lessons/progress/*`.
 */
@Controller('lessons/user-progress')
export class Adr054UserProgressAliasController {
  @All()
  rootRedirect(@Req() req: Request, @Res() res: Response): void {
    redirect(req, res);
  }
  @All('*splat')
  subRedirect(@Req() req: Request, @Res() res: Response): void {
    redirect(req, res);
  }
}
