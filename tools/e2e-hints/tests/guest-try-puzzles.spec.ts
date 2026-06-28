/**
 * Правило: guest-try-puzzles
 * Anchor:  landing-puzzles-tile
 * DSL:     actorType=guest, page=/, count guest_landing_viewed ≥2 за окно,
 *          not exists guest_puzzle_attempted за окно.
 */
import { test } from '@playwright/test';
import { cleanActor, seedEvents, minutesAgo, emitHint } from '../fixtures/actor';
import { loginAsGuest } from '../fixtures/auth';
import { expectHintShown } from '../fixtures/hints';

test('guest-try-puzzles показывается гостю, который не пробовал пазлы', async ({
  context,
  request,
  page,
}) => {
  const guest = await loginAsGuest(context, request);
  await cleanActor(request, guest);

  await seedEvents(request, guest, [
    { type: 'guest_landing_viewed', created_at: minutesAgo(8) },
    { type: 'guest_landing_viewed', created_at: minutesAgo(2) },
  ]);

  await page.goto('/');
  await emitHint(request, guest, '/');

  await expectHintShown(page, 'guest-try-puzzles');
});
