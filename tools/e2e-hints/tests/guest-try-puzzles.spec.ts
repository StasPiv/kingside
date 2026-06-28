/**
 * Правило: guest-try-puzzles
 * Anchor:  landing-puzzles-tile
 * DSL:     actorType=guest, page=/, count guest_landing_viewed ≥2 за окно,
 *          not exists guest_puzzle_attempted за окно.
 */
import { test } from '@playwright/test';
import { cleanActor, seedEvents, minutesAgo } from '../fixtures/actor';
import { loginAsGuest, TEST_GUEST } from '../fixtures/auth';
import { expectHintShown } from '../fixtures/hints';

test('guest-try-puzzles показывается гостю, который не пробовал пазлы', async ({
  context,
  request,
  page,
}) => {
  await cleanActor(request, TEST_GUEST);
  await loginAsGuest(context, TEST_GUEST);

  await seedEvents(request, TEST_GUEST, [
    { type: 'guest_landing_viewed', created_at: minutesAgo(8) },
    { type: 'guest_landing_viewed', created_at: minutesAgo(2) },
  ]);

  await page.goto('/');

  await expectHintShown(page, 'guest-try-puzzles');
});
