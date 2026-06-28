/**
 * Правило: guest-play-friction
 * Anchor:  landing-signup-button
 * DSL:     actorType=guest, page=/, count guest_play_attempted ≥2 за час,
 *          not exists guest_signup_form_opened.
 */
import { test } from '@playwright/test';
import { cleanActor, seedEvents, minutesAgo, emitHint } from '../fixtures/actor';
import { loginAsGuest } from '../fixtures/auth';
import { expectHintShown } from '../fixtures/hints';

test('guest-play-friction показывается после 2+ попыток сыграть без аккаунта', async ({
  context,
  request,
  page,
}) => {
  const guest = await loginAsGuest(context, request);
  await cleanActor(request, guest);

  await seedEvents(request, guest, [
    { type: 'guest_play_attempted', payload: { mode: 'vs_human' }, created_at: minutesAgo(30) },
    { type: 'guest_play_attempted', payload: { mode: 'vs_bot' }, created_at: minutesAgo(5) },
  ]);

  await page.goto('/');
  await emitHint(request, guest, '/');

  await expectHintShown(page, 'guest-play-friction');
});
