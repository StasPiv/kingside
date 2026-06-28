/**
 * Правило: guest-register-prompt
 * Anchor:  landing-signup-button (на / для гостя)
 * DSL:     actorType=guest, page=/, count guest_landing_viewed ≥1 за окно,
 *          not exists guest_signup_form_opened.
 */
import { test } from '@playwright/test';
import { cleanActor, seedEvents, minutesAgo, emitHint } from '../fixtures/actor';
import { loginAsGuest } from '../fixtures/auth';
import { expectHintAppearsAfterEmit, expectHintNotShown } from '../fixtures/hints';

test('guest-register-prompt показывается гостю после landing-view', async ({
  context,
  request,
  page,
}) => {
  const guest = await loginAsGuest(context, request);
  await cleanActor(request, guest);

  await seedEvents(request, guest, [
    { type: 'guest_landing_viewed', created_at: minutesAgo(2) },
  ]);

  await page.goto('/');
  await expectHintAppearsAfterEmit(page, request, guest, '/', 'guest-register-prompt');
});

test('guest-register-prompt НЕ показывается, если гость уже открывал форму регистрации', async ({
  context,
  request,
  page,
}) => {
  const guest = await loginAsGuest(context, request);
  await cleanActor(request, guest);

  await seedEvents(request, guest, [
    { type: 'guest_landing_viewed', created_at: minutesAgo(2) },
    { type: 'guest_signup_form_opened', created_at: minutesAgo(1) },
  ]);

  await page.goto('/');
  await emitHint(request, guest, '/');

  await expectHintNotShown(page, 'guest-register-prompt');
});
