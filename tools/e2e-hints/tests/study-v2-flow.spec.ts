/**
 * KS-4914 / ADR-162. e2e полного потока «Занятия v2»:
 *
 *   расписание (PUT /study/schedule → immediate generation)
 *   → генерация персонального урока (StudySession.lessonId, задачи main+homework)
 *   → уведомление (диспетчер EVERY_MINUTE → onsite Notification type='study_session')
 *   → прохождение урока в плеере (/lessons/:courseSlug/:lessonId)
 *   → занятие completed со score (reconciliation по требованию GET /study/session)
 *   → домашка отражается через reconciliation (puzzle_theme: solved attempt → doneCount).
 *
 * Особенности:
 *  - Слот расписания ставится на «сейчас + 2 мин» (UTC) — диспетчер
 *    подхватывает planned-сессию ближайшим минутным тиком. Ожидание
 *    notified — poll до 4 мин, отсюда большой test.setTimeout.
 *  - Шаги урока проходятся через официальный API плеера
 *    (POST /lessons/progress/lessons/:id/step + .../complete) — UI-часть
 *    проверяет карточку занятия, открытие плеера, уведомление и
 *    финальные состояния /study. Решать puzzle-шаг перетаскиванием
 *    фигур в e2e хрупко и не добавляет покрытия потоку занятий.
 *  - Прямой доступ к postgres (localhost:5434) — очистка study-данных
 *    DEV_USER перед прогоном (идемпотентность) и сид пазла с темой
 *    домашки (в test-стеке база пазлов пуста).
 *
 * Скриншоты ключевых экранов — tools/e2e-hints/videos/study-v2-flow/.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { Client } from 'pg';
import { loginAs, TEST_USER } from '../fixtures/auth';

const API_URL = process.env.E2E_HINTS_API_URL || 'http://localhost:3101';
const PG_URL =
  process.env.E2E_HINTS_PG_URL ||
  'postgresql://kingside:kingside@localhost:5434/kingside';
const DEV_BYPASS_SECRET =
  process.env.E2E_HINTS_DEV_BYPASS_SECRET || 'test-hints-bypass';
const SHOTS = 'videos/study-v2-flow';

test.use({ video: 'on' });
// Поток ждёт минутный тик диспетчера — таймаут с запасом.
test.setTimeout(480_000);

async function pgQuery<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new Client({ connectionString: PG_URL });
  await client.connect();
  try {
    const res = await client.query(text, params);
    return res.rows as T[];
  } finally {
    await client.end();
  }
}

async function apiToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_URL}/auth/dev-bypass`, {
    data: { secret: DEV_BYPASS_SECRET },
  });
  expect(res.ok(), `dev-bypass: ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { accessToken: string }).accessToken;
}

interface StudyTask {
  id: string;
  type: string;
  role: string;
  status: string;
  doneCount: number;
  targetCount: number;
  params: Record<string, unknown> | null;
}
interface StudySession {
  id: string;
  status: string;
  score: number | null;
  lessonId: string | null;
  tasks: StudyTask[];
}

async function getSession(
  request: APIRequestContext,
  token: string,
): Promise<StudySession | null> {
  const res = await request.get(`${API_URL}/study/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok(), `GET /study/session: ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { session: StudySession | null }).session;
}

test('занятие v2: расписание → урок → уведомление → плеер → completed+score → домашка', async ({
  page,
  context,
  request,
}) => {
  // ── 0. Чистка study-данных DEV_USER: прогон идемпотентен ──────────
  await test.step('чистка study-данных', async () => {
    // Cascade: sessions → tasks → study_notifications.
    await pgQuery(`DELETE FROM study_schedules WHERE user_id = $1::uuid`, [
      TEST_USER.id,
    ]);
    await pgQuery(
      `DELETE FROM notifications WHERE user_id = $1::uuid AND type = 'study_session'`,
      [TEST_USER.id],
    );
    // Прогресс по урокам персонального курса прошлых прогонов.
    await pgQuery(
      `DELETE FROM user_lesson_progress
       WHERE user_id = $1::uuid
         AND lesson_id IN (
           SELECT l.id FROM lessons l
           JOIN courses c ON c.id = l.course_id
           WHERE c.owner_id = $1::uuid
             AND c.description = 'kingside:study-personal-course'
         )`,
      [TEST_USER.id],
    );
  });

  const token = await apiToken(request);
  await loginAs(context, request, TEST_USER);

  // ── 1. Расписание: слот через ~2 минуты, PUT делает immediate generation ──
  await test.step('PUT /study/schedule создаёт занятие с уроком', async () => {
    const slot = new Date(Date.now() + 120_000);
    const hh = String(slot.getUTCHours()).padStart(2, '0');
    const mm = String(slot.getUTCMinutes()).padStart(2, '0');
    const res = await request.put(`${API_URL}/study/schedule`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        timeLocal: `${hh}:${mm}`,
        timezone: 'UTC',
        sessionMinutes: 60,
        active: true,
      },
    });
    expect(res.ok(), `PUT /study/schedule: ${res.status()} ${await res.text()}`).toBeTruthy();
  });

  // ── 2. Генерация: сессия planned, персональный урок, main+homework ──
  let lessonId = '';
  let courseSlug = '';
  let homeworkTheme: string | null = null;
  await test.step('сессия сгенерирована: lessonId + homework', async () => {
    const session = await getSession(request, token);
    expect(session, 'session должна существовать сразу после PUT').toBeTruthy();
    expect(session!.status).toBe('planned');
    expect(session!.lessonId, 'lessonId персонального урока').toBeTruthy();
    lessonId = session!.lessonId!;

    const main = session!.tasks.find((t) => t.role === 'main');
    expect(main, 'main-задача типа lesson').toBeTruthy();
    expect(main!.type).toBe('lesson');
    courseSlug = String(main!.params?.courseSlug ?? '');
    expect(courseSlug, 'courseSlug в params main-задачи').toBeTruthy();

    const homework = session!.tasks.filter((t) => t.role === 'homework');
    expect(homework.length, 'есть домашка').toBeGreaterThan(0);
    const puzzleHw = homework.find((t) => t.type === 'puzzle_theme');
    expect(puzzleHw, 'homework puzzle_theme').toBeTruthy();
    homeworkTheme = (puzzleHw!.params?.theme as string | null) ?? null;
  });

  // ── 3. Сид пазла с темой домашки (база пазлов test-стека пуста) ──
  const puzzleId = `study-e2e-${homeworkTheme ?? 'any'}`;
  await test.step('сид пазла темы домашки', async () => {
    await pgQuery(
      `INSERT INTO puzzles (id, fen, moves, rating, themes, source)
       VALUES ($1, 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 2 3',
               'f3f7', 1500, $2, 'lichess')
       ON CONFLICT (id) DO UPDATE SET themes = EXCLUDED.themes`,
      [puzzleId, homeworkTheme ?? ''],
    );
  });

  // ── 4. UI /study: карточка занятия с кнопкой «Начать занятие» ──
  await test.step('/study показывает карточку урока', async () => {
    await page.goto('/study');
    await expect(page.getByTestId('study-session')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('study-lesson-card')).toBeVisible();
    await expect(page.getByTestId('study-lesson-start')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/01-study-planned.png`, fullPage: true });
  });

  // ── 5. Уведомление: диспетчер переводит planned → notified ──
  await test.step('диспетчер: notified + onsite-уведомление', async () => {
    await expect
      .poll(
        async () => (await getSession(request, token))?.status,
        { timeout: 240_000, intervals: [5_000] },
      )
      .toBe('notified');

    const res = await request.get(`${API_URL}/notifications`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok()).toBeTruthy();
    // NotificationService.getAll → { data: [...] }.
    const list = (await res.json()) as { data: Array<{ type: string }> };
    const items = list.data;
    expect(
      items.some((n) => n.type === 'study_session'),
      'onsite-уведомление study_session',
    ).toBeTruthy();

    // UI: колокольчик показывает уведомление.
    await page.goto('/study');
    await page.locator('.nav-notification-wrapper button.header-icon-btn').click();
    await expect(page.locator('.notification-dropdown .notification-item').first()).toBeVisible({
      timeout: 10_000,
    });
    await page.screenshot({ path: `${SHOTS}/02-notification.png` });
  });

  // ── 6. Плеер: открытие персонального урока из карточки ──
  await test.step('кнопка ведёт в плеер урока', async () => {
    await page.goto('/study');
    await page.getByTestId('study-lesson-start').click();
    await page.waitForURL(new RegExp(`/lessons/${courseSlug}/`), { timeout: 15_000 });
    // Персональный урок — user-course: LessonPage рендерит UserLessonView.
    await expect(page.getByTestId('user-lesson-page')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('user-lesson-title')).toBeVisible();
    await expect(page.getByTestId('lesson-error')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/03-lesson-player.png`, fullPage: true });
  });

  // ── 7. Прохождение урока: шаги → done, complete со score ──
  await test.step('прохождение шагов и completeLesson', async () => {
    const res = await request.get(`${API_URL}/lessons/lessons/${lessonId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.ok(), `GET lesson: ${res.status()}`).toBeTruthy();
    const lesson = (await res.json()) as { steps: Array<{ id: string }> };
    expect(lesson.steps.length, 'урок содержит шаги').toBeGreaterThan(0);

    for (const step of lesson.steps) {
      const sr = await request.post(
        `${API_URL}/lessons/progress/lessons/${lessonId}/step`,
        {
          headers: { Authorization: `Bearer ${token}` },
          data: { stepId: step.id, state: 'done' },
        },
      );
      expect(sr.ok(), `step ${step.id}: ${sr.status()} ${await sr.text()}`).toBeTruthy();
    }
  });

  // ── 8. Домашка: solved-попытка пазла темы → reconciliation ──
  await test.step('домашка отражается через reconciliation', async () => {
    const ar = await request.post(`${API_URL}/puzzles/${puzzleId}/attempt`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { result: 'solved', timeMs: 4200 },
    });
    expect(ar.ok(), `attempt: ${ar.status()} ${await ar.text()}`).toBeTruthy();

    // GET /study/session для активной сессии делает reconcile on-demand.
    const session = await getSession(request, token);
    const hw = session!.tasks.find(
      (t) => t.role === 'homework' && t.type === 'puzzle_theme',
    );
    expect(hw, 'homework puzzle_theme').toBeTruthy();
    expect(hw!.doneCount, 'solved-попытка засчитана в домашку').toBeGreaterThan(0);
    expect(['partial', 'done']).toContain(hw!.status);
  });

  // ── 9. Завершение урока → сессия completed со score ──
  await test.step('completeLesson → session completed + score', async () => {
    const cr = await request.post(
      `${API_URL}/lessons/progress/lessons/${lessonId}/complete`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { score: 0.85 },
      },
    );
    expect(cr.ok(), `complete: ${cr.status()} ${await cr.text()}`).toBeTruthy();

    const session = await getSession(request, token);
    expect(session!.status).toBe('completed');
    // ADR-162 §5: score 0-100 пишется в результат сессии.
    expect(session!.score, 'score занятия заполнен').not.toBeNull();
    expect(session!.score!, 'score занятия > 0').toBeGreaterThan(0);
  });

  // ── 10. UI: /study показывает завершение, score, домашку, историю ──
  await test.step('/study: completed + score + история', async () => {
    await page.goto('/study');
    await expect(page.getByTestId('study-session-completed')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('study-session-score')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/04-study-completed.png`, fullPage: true });

    const hr = await request.get(`${API_URL}/study/history`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(hr.ok()).toBeTruthy();
    const history = (await hr.json()) as { items: Array<{ status: string; score: number | null }> };
    expect(
      history.items.some((i) => i.status === 'completed' && i.score != null),
      'история содержит завершённое занятие со score',
    ).toBeTruthy();
  });
});
