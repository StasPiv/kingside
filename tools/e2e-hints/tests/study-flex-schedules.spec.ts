/**
 * KS-4930 / ADR-163 §6 задача 4. e2e потока гибких расписаний занятий:
 *
 *   две тренировки × два слота (POST /study/schedules → immediate
 *   generation) → по 2 planned-сессии на тренировку (генерация по обоим
 *   слотам) → GET /study/sessions/current отдаёт занятие каждой
 *   тренировки со scheduleName → диспетчер шлёт onsite-уведомления с
 *   именами тренировок (payload.scheduleName) → ближайшее занятие
 *   проходится (steps + complete) → история со scheduleName (API + UI)
 *   → пересечение слотов (день+время) при создании тренировки в UI
 *   настроек показывает ошибку 400.
 *
 * Особенности:
 *  - Ближайшие слоты ставятся на «сейчас + 3/4 мин» (UTC) — диспетчер
 *    (EVERY_MINUTE) уведомляет ближайшим тиком; poll до 6 мин, отсюда
 *    большой test.setTimeout.
 *  - GET /study/sessions/current возвращает ПО ОДНОЙ (самой свежей по
 *    scheduledAt) сессии на тренировку — полнота генерации «по обоим
 *    слотам» проверяется напрямую в postgres (localhost:5434), там же
 *    берётся ближайшая сессия для прохождения.
 *  - Урок проходится через официальный API плеера (как в
 *    study-v2-flow.spec.ts) — UI-часть здесь проверяет карточки /study,
 *    колокольчик и историю со scheduleName.
 *  - Имена тренировок в уведомлениях проверяются по payload.scheduleName
 *    onsite-уведомления (GET /notifications): текст telegram-канала в
 *    test-стеке недоступен, а NotificationDropdown рендерит для
 *    study_session fallback без имени (см. отчёт KS-4930).
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { Client } from 'pg';
import { loginAs, TEST_USER } from '../fixtures/auth';

const API_URL = process.env.E2E_HINTS_API_URL || 'http://localhost:3101';
const PG_URL =
  process.env.E2E_HINTS_PG_URL ||
  'postgresql://kingside:kingside@localhost:5434/kingside';
const DEV_BYPASS_SECRET =
  process.env.E2E_HINTS_DEV_BYPASS_SECRET || 'test-hints-bypass';
const SHOTS = 'videos/study-flex-schedules';

const NAME_A = 'Тактика вечером';
const NAME_B = 'Эндшпили утром';

test.use({ video: 'on' });
// Поток ждёт минутные тики диспетчера по двум тренировкам.
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

/** "HH:mm" (UTC) для момента `now + minutes`. */
function utcTimePlus(minutes: number): string {
  const d = new Date(Date.now() + minutes * 60_000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

interface ScheduleDto {
  id: string;
  name: string;
  slots: Array<{ id: string; daysOfWeek: number[]; timeLocal: string }>;
}

async function createSchedule(
  request: APIRequestContext,
  token: string,
  name: string,
  slots: Array<{ daysOfWeek: number[]; timeLocal: string; sessionMinutes?: number | null }>,
): Promise<ScheduleDto> {
  const res = await request.post(`${API_URL}/study/schedules`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name,
      timezone: 'UTC',
      sessionMinutes: 60,
      focus: 'balanced',
      active: true,
      slots,
    },
  });
  expect(
    res.ok(),
    `POST /study/schedules "${name}": ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
  return ((await res.json()) as { schedule: ScheduleDto }).schedule;
}

interface SessionDto {
  id: string;
  scheduleId: string;
  scheduleName: string;
  status: string;
  lessonId: string | null;
}

async function getCurrentSessions(
  request: APIRequestContext,
  token: string,
): Promise<SessionDto[]> {
  const res = await request.get(`${API_URL}/study/sessions/current`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok(), `GET /study/sessions/current: ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { sessions: SessionDto[] }).sessions;
}

async function cleanStudyData(): Promise<void> {
  // Cascade: schedules → slots → sessions → tasks → study_notifications.
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
}

test('гибкие расписания: 2 тренировки × 2 слота → генерация, уведомления с именами, прохождение, история', async ({
  page,
  context,
  request,
}) => {
  await test.step('чистка study-данных', cleanStudyData);

  const token = await apiToken(request);
  await loginAs(context, request, TEST_USER);

  // ── 1. Две тренировки × два слота ─────────────────────────────────
  // Ближайшие слоты (+3/+4 мин) — их диспетчер уведомит в течение
  // прогона; вторые слоты (+2/+3 ч) остаются planned в горизонте +25 ч.
  let schedA!: ScheduleDto;
  let schedB!: ScheduleDto;
  await test.step('POST /study/schedules: две тренировки по два слота', async () => {
    schedA = await createSchedule(request, token, NAME_A, [
      { daysOfWeek: ALL_DAYS, timeLocal: utcTimePlus(2) },
      { daysOfWeek: ALL_DAYS, timeLocal: utcTimePlus(120), sessionMinutes: 45 },
    ]);
    schedB = await createSchedule(request, token, NAME_B, [
      { daysOfWeek: ALL_DAYS, timeLocal: utcTimePlus(3) },
      { daysOfWeek: ALL_DAYS, timeLocal: utcTimePlus(180) },
    ]);
    expect(schedA.slots.length).toBe(2);
    expect(schedB.slots.length).toBe(2);
  });

  // ── 2. Генерация по обоим слотам каждой тренировки ────────────────
  await test.step('в БД по 2 planned-сессии на тренировку', async () => {
    for (const sched of [schedA, schedB]) {
      const rows = await pgQuery<{ count: string }>(
        `SELECT count(*) AS count FROM study_sessions
         WHERE schedule_id = $1::uuid AND status = 'planned'`,
        [sched.id],
      );
      expect(
        Number(rows[0].count),
        `planned-сессии тренировки "${sched.name}" (по одной на слот)`,
      ).toBe(2);
    }
  });

  // ── 3. API current: занятие каждой тренировки со scheduleName ─────
  await test.step('GET /study/sessions/current: обе тренировки с именами', async () => {
    const sessions = await getCurrentSessions(request, token);
    const names = sessions.map((s) => s.scheduleName);
    expect(names, 'по занятию на каждую тренировку').toContain(NAME_A);
    expect(names).toContain(NAME_B);
    const byId = new Map(sessions.map((s) => [s.scheduleId, s.scheduleName]));
    expect(byId.get(schedA.id)).toBe(NAME_A);
    expect(byId.get(schedB.id)).toBe(NAME_B);
  });

  // ── 4. UI /study: карточки занятий обеих тренировок ───────────────
  await test.step('/study показывает карточки обеих тренировок', async () => {
    await page.goto('/study');
    await expect(page.getByTestId('study-session')).toHaveCount(2, {
      timeout: 15_000,
    });
    await expect(
      page.getByTestId('study-session-schedule-name').filter({ hasText: NAME_A }),
    ).toBeVisible();
    await expect(
      page.getByTestId('study-session-schedule-name').filter({ hasText: NAME_B }),
    ).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/01-two-trainings.png`, fullPage: true });
  });

  // ── 5. Диспетчер: onsite-уведомления содержат имена тренировок ────
  await test.step('уведомления study_session с именами обеих тренировок', async () => {
    interface NotifItem {
      type: string;
      payload: { scheduleName?: string };
    }
    const fetchStudyNotifs = async (): Promise<NotifItem[]> => {
      const res = await request.get(`${API_URL}/notifications`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.ok()).toBeTruthy();
      const body = (await res.json()) as { data: NotifItem[] };
      return body.data.filter((n) => n.type === 'study_session');
    };

    await expect
      .poll(
        async () =>
          (await fetchStudyNotifs())
            .map((n) => n.payload?.scheduleName)
            .filter(Boolean)
            .sort(),
        { timeout: 300_000, intervals: [10_000] },
      )
      .toEqual([NAME_B, NAME_A].sort());

    // UI: колокольчик показывает уведомления.
    await page.goto('/study');
    await page.locator('.nav-notification-wrapper button.header-icon-btn').click();
    await expect(
      page.locator('.notification-dropdown .notification-item'),
    ).toHaveCount(2, { timeout: 10_000 });
    await page.screenshot({ path: `${SHOTS}/02-notifications.png` });
  });

  // ── 6. Прохождение ближайшего занятия тренировки A ────────────────
  // current отдаёт самую свежую сессию тренировки (слот +2 ч), поэтому
  // ближайшую (уже notified, слот +3 мин) берём из БД.
  let sessionId = '';
  let lessonId = '';
  await test.step('прохождение урока ближайшей сессии A', async () => {
    const rows = await pgQuery<{ id: string; lesson_id: string | null }>(
      `SELECT id, lesson_id FROM study_sessions
       WHERE schedule_id = $1::uuid
       ORDER BY scheduled_at ASC LIMIT 1`,
      [schedA.id],
    );
    expect(rows.length).toBe(1);
    sessionId = rows[0].id;
    expect(rows[0].lesson_id, 'у сессии есть персональный урок').toBeTruthy();
    lessonId = rows[0].lesson_id!;

    const lr = await request.get(`${API_URL}/lessons/lessons/${lessonId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(lr.ok(), `GET lesson: ${lr.status()}`).toBeTruthy();
    const lesson = (await lr.json()) as { steps: Array<{ id: string }> };
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

    const cr = await request.post(
      `${API_URL}/lessons/progress/lessons/${lessonId}/complete`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { score: 0.8 },
      },
    );
    expect(cr.ok(), `complete: ${cr.status()} ${await cr.text()}`).toBeTruthy();

    // Статус completed выставляет reconciliation: on-demand в
    // GET /study/sessions/current — но только для САМОЙ СВЕЖЕЙ сессии
    // тренировки (здесь это planned-сессия слота +2 ч), пройденную
    // подхватывает 15-минутный cron (study-tracking.scheduler).
    // Ждать cron в e2e слишком долго — эмулируем его: убираем future-
    // planned сессию A, после чего current реконсилит пройденную.
    await pgQuery(
      `DELETE FROM study_sessions
       WHERE schedule_id = $1::uuid AND status = 'planned' AND id <> $2::uuid`,
      [schedA.id, sessionId],
    );
    await expect
      .poll(
        async () =>
          (await getCurrentSessions(request, token)).find((s) => s.id === sessionId)
            ?.status,
        { timeout: 30_000, intervals: [2_000] },
      )
      .toBe('completed');
  });

  // ── 7. История со scheduleName: API + UI ──────────────────────────
  await test.step('история занятий содержит scheduleName', async () => {
    const hr = await request.get(`${API_URL}/study/history`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(hr.ok()).toBeTruthy();
    const history = (await hr.json()) as {
      items: Array<{ id: string; status: string; score: number | null; scheduleName: string }>;
    };
    const done = history.items.find((i) => i.id === sessionId);
    expect(done, 'завершённое занятие в истории').toBeTruthy();
    expect(done!.status).toBe('completed');
    expect(done!.score, 'score заполнен').not.toBeNull();
    expect(done!.scheduleName, 'история хранит имя тренировки').toBe(NAME_A);

    await page.goto('/study');
    await expect(page.getByTestId('study-history')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`study-history-${sessionId}-schedule`)).toHaveText(
      new RegExp(NAME_A),
    );
    await page.screenshot({ path: `${SHOTS}/03-history.png`, fullPage: true });
  });
});

test('пересечение слотов (день+время) → ошибка 400 в UI настроек', async ({
  page,
  context,
  request,
}) => {
  const token = await apiToken(request);
  await loginAs(context, request, TEST_USER);

  // Тренировка с фиксированным слотом: вторник 12:34 (UTC). Время
  // статичное — тест проверяет только валидацию пересечения, генерация
  // ближайших занятий здесь не важна.
  const DAY = 2;
  const TIME = '12:34';
  await test.step('тренировка с занятым слотом через API', async () => {
    // Идемпотентность: прошлые прогоны могли оставить тренировку с этим
    // слотом — убираем только её, не трогая данные первого теста.
    await pgQuery(
      `DELETE FROM study_schedules WHERE user_id = $1::uuid AND name = $2`,
      [TEST_USER.id, 'Занятый слот'],
    );
    await createSchedule(request, token, 'Занятый слот', [
      { daysOfWeek: [DAY], timeLocal: TIME },
    ]);
  });

  await test.step('UI настроек: тот же день+время → ошибка 400 на карточке', async () => {
    await page.goto('/settings?tab=study');
    await expect(page.getByTestId('study-schedule-section')).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId('study-add-schedule').click();

    const card = page.getByTestId('study-schedule-card-new');
    await expect(card).toBeVisible();
    await card.getByTestId('study-name-input').fill('Дубль слота');
    // Таймзона тренировки «Занятый слот» — UTC; пересечение сверяется по
    // строкам (день, HH:mm), для чистоты выставляем ту же зону явно.
    await card.getByTestId('study-timezone-select').selectOption('UTC');
    await card.getByTestId(`study-slot-0-day-${DAY}`).click();
    await card.getByTestId('study-slot-0-time').fill(TIME);
    await card.getByTestId('study-schedule-save').click();

    const error = card.getByTestId('study-schedule-error');
    await expect(error).toBeVisible({ timeout: 10_000 });
    await expect(error).toContainText(/Overlapping/i);
    await page.screenshot({ path: `${SHOTS}/04-overlap-400.png`, fullPage: true });
  });
});
