/**
 * Правило: puzzle-comeback-after-week
 * Anchor:  home-puzzles-tile (на /play или /play/*)
 * DSL:     timeSince puzzle_start gtDays:7
 */
import { test } from '@playwright/test';
import { cleanActor, seedEvents, daysAgo, emitHint } from '../fixtures/actor';
import { loginAs, TEST_USER } from '../fixtures/auth';
import { expectHintShown, expectHintNotShown } from '../fixtures/hints';

test('puzzle-comeback показывается, если puzzle_start был 8 дней назад', async ({
  context,
  request,
  page,
}) => {
  await cleanActor(request, TEST_USER);
  await loginAs(context, request, TEST_USER);

  // Был puzzle_start, но давно — timeSince gtDays:7 истинно.
  await seedEvents(request, TEST_USER, [
    { type: 'puzzle_start', created_at: daysAgo(8) },
  ]);

  await page.goto('/lobby');
  await emitHint(request, TEST_USER, '/lobby');

  await expectHintShown(page, 'puzzle-comeback-after-week');
});

test('puzzle-comeback НЕ показывается, если puzzle_start был вчера', async ({
  context,
  request,
  page,
}) => {
  await cleanActor(request, TEST_USER);
  await loginAs(context, request, TEST_USER);

  await seedEvents(request, TEST_USER, [
    { type: 'puzzle_start', created_at: daysAgo(1) },
  ]);

  await page.goto('/lobby');
  await emitHint(request, TEST_USER, '/lobby');

  await expectHintNotShown(page, 'puzzle-comeback-after-week');
});
