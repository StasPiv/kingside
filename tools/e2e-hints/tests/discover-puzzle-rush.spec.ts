/**
 * Правило: discover-puzzle-rush
 * Anchor:  puzzles-rush-tab (на /puzzles или /puzzles/*)
 * DSL:     puzzle_solved ≥10 за 30 дн, not exists rush_start за 30 дн.
 */
import { test } from '@playwright/test';
import { cleanActor, seedEvents, daysAgo } from '../fixtures/actor';
import { loginAs, TEST_USER } from '../fixtures/auth';
import { expectHintAppearsAfterEmit } from '../fixtures/hints';

test('discover-puzzle-rush показывается активному решающему без rush', async ({
  context,
  request,
  page,
}) => {
  await cleanActor(request, TEST_USER);
  await loginAs(context, request, TEST_USER);

  // 10 puzzle_solved за последний месяц, ни одного rush_start.
  const seeds = Array.from({ length: 10 }, (_, i) => ({
    type: 'puzzle_solved',
    created_at: daysAgo(20 - i),
  }));
  await seedEvents(request, TEST_USER, seeds);

  await page.goto('/puzzles');
  await expectHintAppearsAfterEmit(page, request, TEST_USER, '/puzzles', 'discover-puzzle-rush');
});
