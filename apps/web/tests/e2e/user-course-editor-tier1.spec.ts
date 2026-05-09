import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * KS-2594 (e2e Tier 1, ADR-049): сводный e2e для user-course-editor.
 *
 * Покрывает финальный QA-проход Tier 1 #9 (KS-2577 ждёт этот файл,
 * KS-2593 закрыта — i18n RU-строки уже в проекте).
 *
 * Сценарии в задаче KS-2594:
 *  1. Quiz: создать quiz-шаг → вопрос → 2 опции → правильный → autosave →
 *     reload → данные сохранились → reader-страница → ответ → видна оценка.
 *  2. Diagram with arrows: text-шаг → добавить диаграмму → задать FEN →
 *     стрелка (right-drag desktop / mode-toggle mobile) → подсветка
 *     клетки (right-click) → autosave → reload → reader → стрелка/
 *     подсветка видны через `data-arrows` / `data-highlights` атрибуты
 *     `lesson-text-step-diagram`.
 *  3. Edge cases: удаление диаграммы оставляет `{{diagram:0}}` в md;
 *     quiz без правильного ответа подсвечивает красной рамкой и не ломает
 *     autosave; reorder вопросов через DnD сохраняется (паттерн взят из
 *     `user-course-editor-dnd.spec.ts`).
 *  4. Backend whitelist: POST с `type:'opening_drill'` → 400, с
 *     `type:'quiz'` → 201. Используется `request` Playwright fixture.
 *  5. i18n RU/EN: переключаем язык через `localStorage.locale` ДО навигации,
 *     проверяем, что в DOM присутствуют RU-строки из KS-2593, и что нет
 *     fallback-ключей вида `lessons.my.editor.…`.
 *
 * Mobile-проект (Pixel 5, 390×844) гоняет Сценарии 1, 2, 5; на mobile
 * для стрелки используется mode-toggle вместо RMB-drag.
 *
 * # Замечания по формулировкам RU
 *
 * KS-2594 описывал ожидаемые формулировки «Порог прохождения» /
 * «Редактировать на доске», но фактически в `apps/web/src/i18n/locales/
 * ru/translation.json` уже закреплены смысловые эквиваленты «Порог зачёта
 * (0..1)» / «Расставить на доске». Acceptance KS-2593 явно допускает
 * эквивалентные по смыслу формулировки (см. её описание), поэтому
 * Сценарий 5 проверяет фактические строки.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const SCREENSHOTS_DIR = '/tmp/KS-2594';

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

async function devBypassLogin(username: string): Promise<AuthTokens> {
  const res = await fetch(`${API_URL}/auth/dev-bypass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: DEV_BYPASS_SECRET, user: username }),
  });
  if (!res.ok) throw new Error(`dev-bypass failed: ${res.status}`);
  return (await res.json()) as AuthTokens;
}

async function createCourseWithLesson(
  tokens: AuthTokens,
  title: string,
): Promise<{ courseId: string; slug: string; lessonId: string }> {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${tokens.accessToken}`,
  };

  // create-course rate-limited (429) при частом прогоне — экспоненциальный
  // ретрай с backoff'ом, как в существующих spec'ах KS-1871/KS-1861.
  let course: { id: string; slug: string } | null = null;
  for (let i = 0; i < 6; i += 1) {
    const r = await fetch(`${API_URL}/lessons/courses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title }),
    });
    if (r.ok) {
      course = (await r.json()) as { id: string; slug: string };
      break;
    }
    if (r.status !== 429) throw new Error(`create-course: ${r.status}`);
    await new Promise((res) => setTimeout(res, 2000 * 2 ** i));
  }
  if (!course) throw new Error('create-course failed: 429 max retries');

  const lessonRes = await fetch(
    `${API_URL}/lessons/courses/${course.id}/lessons`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Tier 1 lesson' }),
    },
  );
  if (!lessonRes.ok) throw new Error(`create-lesson: ${lessonRes.status}`);
  const lesson = (await lessonRes.json()) as { id: string };
  return { courseId: course.id, slug: course.slug, lessonId: lesson.id };
}

async function seedAuth(
  page: Page,
  tokens: AuthTokens,
  locale?: 'ru' | 'en',
): Promise<void> {
  await page.addInitScript(
    ([access, refresh, loc]) => {
      localStorage.setItem('token', access);
      localStorage.setItem('refreshToken', refresh);
      if (loc) localStorage.setItem('locale', loc);
    },
    [tokens.accessToken, tokens.refreshToken, locale ?? ''] as [
      string,
      string,
      string,
    ],
  );
}

async function cleanupCourse(
  tokens: AuthTokens,
  courseId: string,
): Promise<void> {
  await fetch(`${API_URL}/lessons/courses/${courseId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  }).catch(() => {});
}

function screenshotPath(name: string): string {
  return path.join(SCREENSHOTS_DIR, `${name}.png`);
}

/**
 * Перевести точку (file, rank) в координаты пикселя на доске относительно
 * её bounding-box'а. orientation='white' — стандарт (a1 слева снизу).
 * Используется для имитации drag'а стрелок и right-click highlight'а.
 */
function squareCenter(
  boardBox: { x: number; y: number; width: number; height: number },
  square: string,
): { x: number; y: number } {
  const file = square.charCodeAt(0) - 'a'.charCodeAt(0); // 0..7
  const rank = parseInt(square[1], 10) - 1; // 0..7 (rank 1 = bottom)
  const sw = boardBox.width / 8;
  const sh = boardBox.height / 8;
  return {
    x: boardBox.x + (file + 0.5) * sw,
    y: boardBox.y + (7 - rank + 0.5) * sh, // rank 1 — внизу (row 7)
  };
}

/** Ждать PATCH /lessons/user-lesson-steps/:id (autosave шага). */
function waitStepPatch(page: Page) {
  return page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' &&
      /\/lessons\/steps\//.test(r.url()),
    { timeout: 15_000 },
  );
}

// Все тесты внутри describe идут последовательно. workers:1 в global
// конфиге уже это даёт, но `serial` упрощает чтение и предотвращает
// race condition'ы внутри отдельных describe'ов на случай будущего
// параллельного тюнинга.
test.describe.configure({ mode: 'serial' });

// ─── Сценарий 1 (quiz) ────────────────────────────────────────────────

test.describe('KS-2594 Tier1 — Сценарий 1: quiz autosave + reader', () => {
  test('создание quiz, autosave, reload, ответ в reader, оценка', async ({
    page,
  }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile';
    const tokens = await devBypassLogin(`e2e-tier1-quiz-${Date.now()}`);
    const fixture = await createCourseWithLesson(
      tokens,
      `KS-2594 Quiz ${isMobile ? 'M' : 'D'} ${Date.now()}`,
    );
    await seedAuth(page, tokens);
    await page.goto(
      `/lessons/my/${fixture.slug}/edit?lesson=${fixture.lessonId}`,
    );
    await expect(page.getByTestId('user-course-editor')).toBeVisible({
      timeout: 15_000,
    });

    // На mobile editor открыт с outline-табом по умолчанию — переключаем
    // на editor-таб (там steps).
    if (isMobile) {
      await page.getByTestId('user-course-editor-tab-editor').click();
    }

    // 1. Empty state → выбираем quiz → «Добавить первый шаг».
    await expect(page.getByTestId('add-step-empty-state')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('add-step-empty-picker-option-quiz').click();
    // Создаём шаг, ждём ответа сервера и подхватываем step-id из ответа —
    // без id мы не знаем, какой PATCH ждать в waitStepPatch ниже.
    const createStepRes = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          /\/lessons\/lessons\/[^/]+\/steps$/.test(r.url()),
        { timeout: 15_000 },
      ),
      page.getByTestId('add-step-empty-cta').click(),
    ]).then(([res]) => res);
    const createdStep = (await createStepRes.json()) as { id: string };

    // 2. StepCard — раскрыт; QuizStepEditor виден.
    const card = page.getByTestId(`step-card-${createdStep.id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toHaveAttribute('data-expanded', 'true');
    const quizEditor = page.getByTestId('quiz-step-editor');
    await expect(quizEditor).toBeVisible();

    // 3. Добавляем 1 вопрос. Изначально questions пустой → жмём «+ Add question».
    const patch1 = waitStepPatch(page);
    await page.getByTestId('quiz-add-question').click();
    await patch1;
    await expect(page.getByTestId('quiz-question-0')).toBeVisible();

    // 4. Заполняем prompt, 2 опции (по умолчанию они уже есть пустыми a/b),
    //    и помечаем 'a' правильной.
    await page
      .getByTestId('quiz-question-prompt-0')
      .fill('What is 2+2?');
    // Опции уже есть пустые — заполняем label'ы.
    await page.getByTestId('quiz-option-label-0-0').fill('4');
    await page.getByTestId('quiz-option-label-0-1').fill('5');
    // Помечаем правильный — option-0-0 (id='a').
    const patch2 = waitStepPatch(page);
    await page.getByTestId('quiz-option-correct-0-0').check();
    await patch2;

    // Sanity: красной рамки нет (валидация пройдена).
    await expect(page.getByTestId('quiz-question-0')).toHaveAttribute(
      'data-invalid',
      'false',
    );

    await page.screenshot({
      path: screenshotPath(`s1-${isMobile ? 'mobile' : 'desktop'}-01-quiz-edited`),
      fullPage: true,
    });

    // 5. Reload — данные подгрузились с сервера.
    await page.reload();
    await expect(page.getByTestId('user-course-editor')).toBeVisible({
      timeout: 15_000,
    });
    if (isMobile) {
      await page.getByTestId('user-course-editor-tab-editor').click();
    }
    // StepCard свёрнут после reload — раскрываем chevron'ом.
    const cardReloaded = page.getByTestId(`step-card-${createdStep.id}`);
    await expect(cardReloaded).toBeVisible({ timeout: 10_000 });
    if ((await cardReloaded.getAttribute('data-expanded')) !== 'true') {
      await page
        .getByTestId(`step-card-chevron-${createdStep.id}`)
        .click();
    }
    await expect(page.getByTestId('quiz-question-prompt-0')).toHaveValue(
      'What is 2+2?',
    );
    await expect(page.getByTestId('quiz-option-label-0-0')).toHaveValue('4');
    await expect(page.getByTestId('quiz-option-correct-0-0')).toBeChecked();

    // 6. Reader: переходим на UserLessonPage, отвечаем правильно, видим оценку.
    await page.goto(
      `/lessons/my/${fixture.slug}/${fixture.lessonId}`,
    );
    await expect(page.getByTestId('user-lesson-page')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('lesson-quiz-step')).toBeVisible({
      timeout: 10_000,
    });
    // option-id 'a' = id первой опции (назначается a/b/c/...).
    await page.getByTestId('option-0-a').check();
    await page.getByTestId('check-0').click();
    await expect(page.getByTestId('question-result-0')).toHaveAttribute(
      'data-testid',
      'question-result-0',
    );
    // Submit квиза.
    await page.getByTestId('lesson-quiz-step-submit').click();
    // Видна оценка.
    await expect(page.getByTestId('lesson-quiz-step-score')).toBeVisible();
    await page.screenshot({
      path: screenshotPath(`s1-${isMobile ? 'mobile' : 'desktop'}-02-reader-scored`),
      fullPage: true,
    });

    await cleanupCourse(tokens, fixture.courseId);
  });
});

// ─── Сценарий 2 (text-step + диаграмма со стрелкой и подсветкой) ──────

test.describe('KS-2594 Tier1 — Сценарий 2: diagram arrow + highlight', () => {
  test('text-шаг → диаграмма → FEN → стрелка → подсветка → reload → reader', async ({
    page,
  }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile';
    const tokens = await devBypassLogin(`e2e-tier1-diagram-${Date.now()}`);
    const fixture = await createCourseWithLesson(
      tokens,
      `KS-2594 Diagram ${isMobile ? 'M' : 'D'} ${Date.now()}`,
    );
    await seedAuth(page, tokens);
    await page.goto(
      `/lessons/my/${fixture.slug}/edit?lesson=${fixture.lessonId}`,
    );
    await expect(page.getByTestId('user-course-editor')).toBeVisible({
      timeout: 15_000,
    });
    if (isMobile) {
      await page.getByTestId('user-course-editor-tab-editor').click();
    }

    // 1. Создаём text-шаг через empty-state → ждём POST .../steps.
    await expect(page.getByTestId('add-step-empty-state')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('add-step-empty-picker-option-text').click();
    const createStepRes = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          /\/lessons\/lessons\/[^/]+\/steps$/.test(r.url()),
        { timeout: 15_000 },
      ),
      page.getByTestId('add-step-empty-cta').click(),
    ]).then(([res]) => res);
    const stepId = ((await createStepRes.json()) as { id: string }).id;

    // 2. Добавляем диаграмму в text-шаге.
    const patchAddDiagram = waitStepPatch(page);
    await page.getByTestId('editor-step-text-add-diagram').click();
    await patchAddDiagram;
    await expect(page.getByTestId('editor-diagram-card-0')).toBeVisible();

    // 3. Расставляем позицию через FEN (как требует тикет — быстрее, чем drag).
    //    Используем простую миттельшпильную позицию, чтобы стрелка/highlight
    //    ложились на не-стартовые клетки.
    const TARGET_FEN =
      'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 2 4';
    const patchFen = waitStepPatch(page);
    await page.getByTestId('editor-diagram-fen-0').fill(TARGET_FEN);
    await page.getByTestId('editor-diagram-fen-0').blur();
    await patchFen;

    const board = page.getByTestId('diagram-editor-board');
    await expect(board).toBeVisible();
    const boardBox = await board.boundingBox();
    if (!boardBox) throw new Error('diagram-editor-board: no bounding box');

    // Mobile: переключаемся в режим draw (без mode-toggle drawing на coarse
    // pointer не работает; на desktop drawing на RMB активен всегда).
    if (isMobile) {
      const modeToggle = page.getByTestId('diagram-editor-mode-toggle');
      await expect(modeToggle).toBeVisible({ timeout: 5_000 });
      await page.getByTestId('diagram-editor-mode-draw').click();
    }

    // 4. Стрелка f3 → e5 (атака коня на пешку).
    const f3 = squareCenter(boardBox, 'f3');
    const e5 = squareCenter(boardBox, 'e5');
    const patchArrow = waitStepPatch(page);
    if (isMobile) {
      // На coarse + 'draw' режим drawing срабатывает на любую кнопку —
      // используем обычные mouse-эвенты, библиотека их обработает.
      await page.mouse.move(f3.x, f3.y);
      await page.mouse.down();
      await page.mouse.move(e5.x, e5.y, { steps: 10 });
      await page.mouse.up();
    } else {
      await page.mouse.move(f3.x, f3.y);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(e5.x, e5.y, { steps: 10 });
      await page.mouse.up({ button: 'right' });
    }
    await patchArrow;
    // На board'е счётчик в data-arrows-count увеличился до 1.
    await expect(board).toHaveAttribute('data-arrows-count', '1');

    // 5. Highlight клетки d4 (right-click без drag'а).
    const d4 = squareCenter(boardBox, 'd4');
    const patchHi = waitStepPatch(page);
    if (isMobile) {
      await page.mouse.move(d4.x, d4.y);
      await page.mouse.down();
      await page.mouse.up();
    } else {
      await page.mouse.move(d4.x, d4.y);
      await page.mouse.down({ button: 'right' });
      await page.mouse.up({ button: 'right' });
    }
    await patchHi;
    await expect(board).toHaveAttribute('data-highlights-count', '1');

    await page.screenshot({
      path: screenshotPath(`s2-${isMobile ? 'mobile' : 'desktop'}-01-edited`),
      fullPage: true,
    });

    // 6. Reload — стрелка/подсветка сохранены.
    await page.reload();
    await expect(page.getByTestId('user-course-editor')).toBeVisible({
      timeout: 15_000,
    });
    if (isMobile) {
      await page.getByTestId('user-course-editor-tab-editor').click();
    }
    const cardReloaded = page.getByTestId(`step-card-${stepId}`);
    if ((await cardReloaded.getAttribute('data-expanded')) !== 'true') {
      await page.getByTestId(`step-card-chevron-${stepId}`).click();
    }
    await expect(page.getByTestId('diagram-editor-board')).toHaveAttribute(
      'data-arrows-count',
      '1',
    );
    await expect(page.getByTestId('diagram-editor-board')).toHaveAttribute(
      'data-highlights-count',
      '1',
    );

    // 7. Reader: открываем урок, диаграмма с arrows/highlights видна.
    await page.goto(`/lessons/my/${fixture.slug}/${fixture.lessonId}`);
    await expect(page.getByTestId('user-lesson-page')).toBeVisible({
      timeout: 15_000,
    });
    const readerDiagram = page.getByTestId('lesson-text-step-diagram').first();
    await expect(readerDiagram).toBeVisible({ timeout: 10_000 });
    await expect(readerDiagram).toHaveAttribute('data-arrows', '1');
    await expect(readerDiagram).toHaveAttribute('data-highlights', '1');
    await page.screenshot({
      path: screenshotPath(`s2-${isMobile ? 'mobile' : 'desktop'}-02-reader`),
      fullPage: true,
    });

    await cleanupCourse(tokens, fixture.courseId);
  });
});

// ─── Сценарий 3 (edge cases — desktop only) ───────────────────────────

test.describe('KS-2594 Tier1 — Сценарий 3: edge cases', () => {
  test('удаление диаграммы оставляет {{diagram:0}} в md', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'Edge case удобнее проверять на desktop (markdown-textarea + множественные кнопки).',
    );
    const tokens = await devBypassLogin(`e2e-tier1-orphan-${Date.now()}`);
    const fixture = await createCourseWithLesson(
      tokens,
      `KS-2594 Orphan ${Date.now()}`,
    );
    await seedAuth(page, tokens);
    await page.goto(
      `/lessons/my/${fixture.slug}/edit?lesson=${fixture.lessonId}`,
    );
    await expect(page.getByTestId('user-course-editor')).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId('add-step-empty-picker-option-text').click();
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          /\/lessons\/lessons\/[^/]+\/steps$/.test(r.url()),
        { timeout: 15_000 },
      ),
      page.getByTestId('add-step-empty-cta').click(),
    ]);

    const patchAdd = waitStepPatch(page);
    await page.getByTestId('editor-step-text-add-diagram').click();
    await patchAdd;
    await expect(page.getByTestId('editor-diagram-card-0')).toBeVisible();

    // Удаляем диаграмму. Плейсхолдер `{{diagram:0}}` остаётся в md
    // (см. TextFields.removeDiagram — `bodyMarkdown` не трогаем).
    const patchRemove = waitStepPatch(page);
    await page.getByTestId('editor-diagram-remove-0').click();
    await patchRemove;
    await expect(page.getByTestId('editor-diagram-card-0')).toHaveCount(0);

    // Видим orphan-warning со списком «битых» индексов.
    await expect(
      page.getByTestId('editor-diagrams-orphan-warning'),
    ).toBeVisible();
    // Markdown body всё ещё содержит маркер.
    const mdValue = await page
      .getByTestId('editor-step-text-body')
      .first()
      .inputValue();
    expect(mdValue).toContain('{{diagram:0}}');

    await page.screenshot({
      path: screenshotPath('s3-01-orphan-warning'),
      fullPage: true,
    });
    await cleanupCourse(tokens, fixture.courseId);
  });

  test('quiz без правильного ответа: красная рамка + autosave не падает', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'Edge case на desktop достаточен (валидация одинаковая на всех viewport\'ах).',
    );
    const tokens = await devBypassLogin(`e2e-tier1-invalid-${Date.now()}`);
    const fixture = await createCourseWithLesson(
      tokens,
      `KS-2594 InvalidQuiz ${Date.now()}`,
    );
    await seedAuth(page, tokens);
    await page.goto(
      `/lessons/my/${fixture.slug}/edit?lesson=${fixture.lessonId}`,
    );
    await expect(page.getByTestId('user-course-editor')).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId('add-step-empty-picker-option-quiz').click();
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          /\/lessons\/lessons\/[^/]+\/steps$/.test(r.url()),
        { timeout: 15_000 },
      ),
      page.getByTestId('add-step-empty-cta').click(),
    ]);

    // Добавляем вопрос: запиливаем prompt и опции, но НЕ помечаем правильный.
    const patch1 = waitStepPatch(page);
    await page.getByTestId('quiz-add-question').click();
    await patch1;
    await page.getByTestId('quiz-question-prompt-0').fill('Q?');
    await page.getByTestId('quiz-option-label-0-0').fill('A');
    const patchOpt = waitStepPatch(page);
    await page.getByTestId('quiz-option-label-0-1').fill('B');
    await patchOpt;

    // Валидация: data-invalid='true' (нет correct), red-border CSS — проверяем
    // классы (`quiz-question--invalid` присутствует) и testid'ы валидаций.
    const q = page.getByTestId('quiz-question-0');
    await expect(q).toHaveAttribute('data-invalid', 'true');
    await expect(q).toHaveClass(/quiz-question--invalid/);
    await expect(
      page.getByTestId('quiz-question-validation-no-correct-0'),
    ).toBeVisible();

    await page.screenshot({
      path: screenshotPath('s3-02-quiz-invalid'),
      fullPage: true,
    });
    await cleanupCourse(tokens, fixture.courseId);
  });

  test('reorder вопросов через mouse DnD сохраняется', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'DnD-reorder проверяется на desktop через mouse — паттерн из user-course-editor-dnd.spec.ts.',
    );
    const tokens = await devBypassLogin(`e2e-tier1-reorder-${Date.now()}`);
    const fixture = await createCourseWithLesson(
      tokens,
      `KS-2594 Reorder ${Date.now()}`,
    );

    // Сидим quiz-шаг с готовыми 2 вопросами через API — это исключает
    // race-condition'ы с последовательными UI-PATCH'ами, тест фокусируется
    // именно на drag-reorder вопросов в QuizStepEditor.
    const seedHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokens.accessToken}`,
    };
    const stepRes = await fetch(
      `${API_URL}/lessons/lessons/${fixture.lessonId}/steps`,
      {
        method: 'POST',
        headers: seedHeaders,
        body: JSON.stringify({
          type: 'quiz',
          payload: {
            type: 'quiz',
            questions: [
              {
                id: 'q-1',
                prompt: 'Q1',
                options: [
                  { id: 'a', label: 'A' },
                  { id: 'b', label: 'B' },
                ],
                correctOptionIds: ['a'],
              },
              {
                id: 'q-2',
                prompt: 'Q2',
                options: [
                  { id: 'a', label: 'A' },
                  { id: 'b', label: 'B' },
                ],
                correctOptionIds: ['a'],
              },
            ],
          },
        }),
      },
    );
    if (!stepRes.ok) {
      throw new Error(`seed step failed: ${stepRes.status}`);
    }
    const stepId = ((await stepRes.json()) as { id: string }).id;

    await seedAuth(page, tokens);
    await page.goto(
      `/lessons/my/${fixture.slug}/edit?lesson=${fixture.lessonId}`,
    );
    await expect(page.getByTestId('user-course-editor')).toBeVisible({
      timeout: 15_000,
    });
    const card = page.getByTestId(`step-card-${stepId}`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    if ((await card.getAttribute('data-expanded')) !== 'true') {
      await page.getByTestId(`step-card-chevron-${stepId}`).click();
    }
    await expect(page.getByTestId('quiz-step-editor')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('quiz-question-prompt-0')).toHaveValue('Q1');
    await expect(page.getByTestId('quiz-question-prompt-1')).toHaveValue('Q2');

    // Drag первого вопроса под второй (mouse-pattern из dnd-spec'а).
    const handle1 = page.getByTestId('quiz-question-handle-0');
    const item2 = page.getByTestId('quiz-question-1');
    const h1Box = await handle1.boundingBox();
    const i2Box = await item2.boundingBox();
    if (!h1Box || !i2Box) throw new Error('boundingBox null');

    await page.mouse.move(h1Box.x + h1Box.width / 2, h1Box.y + h1Box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      h1Box.x + h1Box.width / 2 + 10,
      h1Box.y + h1Box.height / 2 + 10,
      { steps: 5 },
    );
    await page.mouse.move(
      i2Box.x + i2Box.width / 2,
      i2Box.y + i2Box.height + 12,
      { steps: 20 },
    );
    const patchReorder = waitStepPatch(page);
    await page.mouse.up();
    await patchReorder;

    // После reorder'а порядок prompt-инпутов поменялся: на индексе 0 теперь
    // Q2, на индексе 1 — Q1.
    await expect(page.getByTestId('quiz-question-prompt-0')).toHaveValue('Q2');
    await expect(page.getByTestId('quiz-question-prompt-1')).toHaveValue('Q1');

    // Дополнительно сверяем, что серверный payload получил
    // переставленный порядок — `GET /lessons/lessons/:id` отдаёт
    // урок со steps. Это устойчивее к асинхронной гидрации после reload.
    // KS-2646 закрыл блокер Phase D, unified GET работает для user.
    const lessonRes = await fetch(
      `${API_URL}/lessons/lessons/${fixture.lessonId}`,
      { headers: { Authorization: `Bearer ${tokens.accessToken}` } },
    );
    expect(lessonRes.ok, `GET lesson: ${lessonRes.status}`).toBe(true);
    const lessonData = (await lessonRes.json()) as {
      steps: Array<{
        id: string;
        payload: { questions?: Array<{ prompt: string }> };
      }>;
    };
    const reloadedStep = lessonData.steps.find((s) => s.id === stepId);
    expect(reloadedStep, `step ${stepId} not found in lesson`).toBeDefined();
    const reloadedQuestions = reloadedStep?.payload.questions ?? [];
    expect(reloadedQuestions).toHaveLength(2);
    expect(reloadedQuestions[0].prompt).toBe('Q2');
    expect(reloadedQuestions[1].prompt).toBe('Q1');

    await page.screenshot({
      path: screenshotPath('s3-03-reorder-persisted'),
      fullPage: true,
    });
    await cleanupCourse(tokens, fixture.courseId);
  });
});

// ─── Сценарий 4 (backend whitelist через REST — без браузера) ─────────

test.describe('KS-2594 Tier1 — Сценарий 4: backend whitelist', () => {
  test('opening_drill → 400, quiz → 201', async ({
    request,
  }: {
    request: APIRequestContext;
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'API-only сценарий: достаточно один раз на любом проекте, привязали к desktop.',
    );
    const tokens = await devBypassLogin(`e2e-tier1-whitelist-${Date.now()}`);
    const fixture = await createCourseWithLesson(
      tokens,
      `KS-2594 WL ${Date.now()}`,
    );

    // 4a. opening_drill → 400 (не в UserStepType whitelist'е).
    const r400 = await request.post(
      `${API_URL}/lessons/lessons/${fixture.lessonId}/steps`,
      {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
        data: {
          type: 'opening_drill',
          payload: {
            type: 'opening_drill',
            // payload-shape конкретно не валидируем — мы ждём, что
            // отвал на whitelist'е TYPE будет раньше любой проверки payload'а.
            startFen:
              'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            sideToPlay: 'white',
          },
        },
      },
    );
    expect(
      r400.status(),
      `expected 400 for type=opening_drill, got ${r400.status()}; body=${await r400.text().catch(() => '?')}`,
    ).toBe(400);

    // 4b. quiz → 201, шаг создан (questions может быть пустым — UI-валидация
    // лишь подсвечивает, а не блокирует POST).
    const r201 = await request.post(
      `${API_URL}/lessons/lessons/${fixture.lessonId}/steps`,
      {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
        data: {
          type: 'quiz',
          payload: { type: 'quiz', questions: [] },
        },
      },
    );
    expect(
      r201.status(),
      `expected 201 for type=quiz, got ${r201.status()}; body=${await r201.text().catch(() => '?')}`,
    ).toBe(201);
    const created = (await r201.json()) as { id: string; type: string };
    expect(created.type).toBe('quiz');

    await cleanupCourse(tokens, fixture.courseId);
  });
});

// ─── Сценарий 5 (i18n RU/EN) ──────────────────────────────────────────

test.describe('KS-2594 Tier1 — Сценарий 5: i18n RU/EN editor', () => {
  test('RU видны строки KS-2593, EN исходные, нет fallback-ключей', async ({
    page,
  }, testInfo) => {
    const isMobile = testInfo.project.name === 'mobile';
    const tokens = await devBypassLogin(`e2e-tier1-i18n-${Date.now()}`);
    const fixture = await createCourseWithLesson(
      tokens,
      `KS-2594 i18n ${isMobile ? 'M' : 'D'} ${Date.now()}`,
    );

    // Сидим quiz + text шаги через API — это убирает race-condition'ы с
    // последовательными UI-PATCH'ами, тест фокусируется именно на i18n
    // (видимости RU/EN-строк в редакторе).
    const seedHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokens.accessToken}`,
    };
    const quizSeedRes = await fetch(
      `${API_URL}/lessons/lessons/${fixture.lessonId}/steps`,
      {
        method: 'POST',
        headers: seedHeaders,
        body: JSON.stringify({
          type: 'quiz',
          payload: {
            type: 'quiz',
            questions: [
              {
                id: 'q-1',
                prompt: 'Sample question',
                options: [
                  { id: 'a', label: 'A' },
                  { id: 'b', label: 'B' },
                ],
                correctOptionIds: ['a'],
              },
            ],
          },
        }),
      },
    );
    if (!quizSeedRes.ok) {
      throw new Error(`seed quiz: ${quizSeedRes.status}`);
    }
    const quizStepId = ((await quizSeedRes.json()) as { id: string }).id;

    const textSeedRes = await fetch(
      `${API_URL}/lessons/lessons/${fixture.lessonId}/steps`,
      {
        method: 'POST',
        headers: seedHeaders,
        body: JSON.stringify({
          type: 'text',
          payload: {
            type: 'text',
            bodyMarkdown: 'Body {{diagram:0}}',
            diagrams: [
              {
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                caption: '',
                orientation: 'white',
                arrows: [],
                highlightedSquares: [],
              },
            ],
          },
        }),
      },
    );
    if (!textSeedRes.ok) {
      throw new Error(`seed text: ${textSeedRes.status}`);
    }
    const textStepId = ((await textSeedRes.json()) as { id: string }).id;

    // ── RU ────────────────────────────────────────────────────────────
    await seedAuth(page, tokens, 'ru');
    await page.goto(
      `/lessons/my/${fixture.slug}/edit?lesson=${fixture.lessonId}`,
    );
    await expect(page.getByTestId('user-course-editor')).toBeVisible({
      timeout: 15_000,
    });
    if (isMobile) {
      await page.getByTestId('user-course-editor-tab-editor').click();
    }

    // Раскрываем оба шага (после загрузки они свёрнуты).
    const expandIfNeeded = async (stepId: string) => {
      const card = page.getByTestId(`step-card-${stepId}`);
      await expect(card).toBeVisible({ timeout: 10_000 });
      if ((await card.getAttribute('data-expanded')) !== 'true') {
        await page.getByTestId(`step-card-chevron-${stepId}`).click();
      }
      await expect(card).toHaveAttribute('data-expanded', 'true');
    };
    await expandIfNeeded(quizStepId);
    await expandIfNeeded(textStepId);
    await expect(page.getByTestId('quiz-step-editor')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('quiz-question-0')).toBeVisible({
      timeout: 10_000,
    });

    // RU-строки KS-2593 (формулировки см. шапку файла).
    await expect(page.locator('text=Порог зачёта (0..1)')).toBeVisible();
    await expect(
      page.locator('text=Несколько правильных ответов'),
    ).toBeVisible();
    await expect(page.locator('text=Вопрос 1')).toBeVisible();
    await expect(page.locator('text=Расчётное время, мин.')).toBeVisible();
    await expect(
      page.locator('text=Расставить на доске').first(),
    ).toBeVisible();
    await expect(
      page.getByTestId(`step-card-preview-toggle-${textStepId}`),
    ).toContainText('Предпросмотр');

    // Нет fallback-ключей вида `lessons.my.editor.…` в видимом DOM.
    await expect(page.locator('text=/lessons\\.my\\.editor\\./')).toHaveCount(0);

    await page.screenshot({
      path: screenshotPath(`s5-${isMobile ? 'mobile' : 'desktop'}-01-ru`),
      fullPage: true,
    });

    // ── EN ────────────────────────────────────────────────────────────
    // Меняем локаль через localStorage. ВАЖНО: `seedAuth` зарегистрировал
    // init-скрипт, который на каждом reload пишет 'ru' обратно в
    // localStorage. Регистрируем второй init-скрипт, перезатирающий
    // локаль на 'en' — он запустится после первого. Только после этого
    // делаем reload.
    await page.addInitScript(() => {
      localStorage.setItem('locale', 'en');
    });
    await page.reload();
    await expect(page.getByTestId('user-course-editor')).toBeVisible({
      timeout: 15_000,
    });
    if (isMobile) {
      await page.getByTestId('user-course-editor-tab-editor').click();
    }

    // Раскрываем оба шага после reload'а заново — collapsed-состояние
    // не персистится.
    await expandIfNeeded(quizStepId);
    await expandIfNeeded(textStepId);
    await expect(page.getByTestId('quiz-step-editor')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('quiz-question-0')).toBeVisible({
      timeout: 10_000,
    });

    await expect(page.locator('text=Pass threshold (0..1)')).toBeVisible();
    await expect(
      page.locator('text=Multiple correct answers'),
    ).toBeVisible();
    await expect(page.locator('text=Question 1')).toBeVisible();
    await expect(page.locator('text=Estimated minutes')).toBeVisible();

    await expect(page.locator('text=Edit on board').first()).toBeVisible();
    await expect(
      page.getByTestId(`step-card-preview-toggle-${textStepId}`),
    ).toContainText('Preview');

    // Нет fallback-ключей и в EN.
    await expect(page.locator('text=/lessons\\.my\\.editor\\./')).toHaveCount(0);

    await page.screenshot({
      path: screenshotPath(`s5-${isMobile ? 'mobile' : 'desktop'}-02-en`),
      fullPage: true,
    });

    await cleanupCourse(tokens, fixture.courseId);
  });
});
