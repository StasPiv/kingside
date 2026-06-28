/**
 * Правило: rush-streak-recovery
 * Anchor:  puzzles-rush-tab (на /puzzles*)
 * DSL:     count rush_streak_broken ≥2 за сутки.
 */
import { test } from '@playwright/test';
import { cleanActor, seedEvents, hoursAgo } from '../fixtures/actor';
import { loginAs, TEST_USER } from '../fixtures/auth';
import { expectHintAppearsAfterEmit } from '../fixtures/hints';

test('rush-streak-recovery показывается после 2 сорванных серий за сутки', async ({
  context,
  request,
  page,
}) => {
  await cleanActor(request, TEST_USER);
  await loginAs(context, request, TEST_USER);

  await seedEvents(request, TEST_USER, [
    { type: 'rush_streak_broken', created_at: hoursAgo(20) },
    { type: 'rush_streak_broken', created_at: hoursAgo(3) },
  ]);

  await page.goto('/puzzles');
  await expectHintAppearsAfterEmit(page, request, TEST_USER, '/puzzles', 'rush-streak-recovery');
});
