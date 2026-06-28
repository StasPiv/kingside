/**
 * Правило: home-idle-suggest-puzzles
 * Anchor:  home-puzzles-tile (на /play)
 * DSL:     count session_idle ≥1 за окно minutesAgo(2) с payload.page=/play.
 *
 * Этот сценарий не использует backdating — событие session_idle естественным
 * образом приходит с frontend'а после 60 сек простоя. Чтобы не ждать минуту,
 * мы можем подсунуть событие через seedEvents.
 */
import { test } from '@playwright/test';
import { cleanActor, seedEvents, minutesAgo } from '../fixtures/actor';
import { loginAs, TEST_USER } from '../fixtures/auth';
import { expectHintShown } from '../fixtures/hints';

test('home-idle подсказка показывается после session_idle на /play', async ({
  context,
  request,
  page,
}) => {
  await cleanActor(request, TEST_USER);
  await loginAs(context, request, TEST_USER);

  await seedEvents(request, TEST_USER, [
    {
      type: 'session_idle',
      payload: { page: '/play', idle_seconds: 65 },
      created_at: minutesAgo(1),
    },
  ]);

  await page.goto('/play');

  await expectHintShown(page, 'home-idle-suggest-puzzles');
});
