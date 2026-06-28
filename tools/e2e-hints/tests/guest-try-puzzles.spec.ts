/**
 * Правило: guest-try-puzzles
 * Anchor:  landing-puzzles-tile
 * DSL:     actorType=guest, page=/, count guest_landing_viewed ≥2 за окно,
 *          not exists guest_puzzle_attempted за окно.
 */
import { test } from '@playwright/test';
import { cleanActor, seedEvents, minutesAgo } from '../fixtures/actor';
import { loginAsGuest } from '../fixtures/auth';
import { expectHintAppearsAfterEmit } from '../fixtures/hints';

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
    // KS-4763: gлушим guest-register-prompt (priority 60 vs guest-try-puzzles
    // priority 50) — иначе на тех же seed-событиях он перехватывает emit.
    // not-exists guest_signup_form_opened за 1 день в его DSL отключает правило.
    { type: 'guest_signup_form_opened', created_at: minutesAgo(5) },
  ]);

  await page.goto('/');
  await expectHintAppearsAfterEmit(page, request, guest, '/', 'guest-try-puzzles');
});
