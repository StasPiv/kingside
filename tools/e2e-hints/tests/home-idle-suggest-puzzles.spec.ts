/**
 * Правило: home-idle-suggest-puzzles
 * Anchor:  home-puzzles-tile (на /lobby — page-override KS-4763)
 * DSL:     count session_idle ≥1 за окно minutesAgo(2) с payload.page=/lobby.
 */
import { test } from '@playwright/test';
import { cleanActor, seedEvents, minutesAgo } from '../fixtures/actor';
import { loginAs, TEST_USER } from '../fixtures/auth';
import { expectHintAppearsAfterEmit } from '../fixtures/hints';

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
      payload: { page: '/lobby', idle_seconds: 65 },
      created_at: minutesAgo(1),
    },
  ]);

  await page.goto('/lobby');
  await expectHintAppearsAfterEmit(page, request, TEST_USER, '/lobby', 'home-idle-suggest-puzzles');
});
