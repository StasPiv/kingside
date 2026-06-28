/**
 * Правило: guest-register-prompt
 * Anchor:  landing-signup-button (на / для гостя)
 * DSL:     actorType=guest, page=/, count guest_landing_viewed ≥1 за окно,
 *          not exists guest_signup_form_opened.
 */
import { test } from '@playwright/test';
import { cleanActor, seedEvents, minutesAgo } from '../fixtures/actor';
import { loginAsGuest, TEST_GUEST } from '../fixtures/auth';
import { expectHintShown, expectHintNotShown } from '../fixtures/hints';

test('guest-register-prompt показывается гостю после landing-view', async ({
  context,
  request,
  page,
}) => {
  await cleanActor(request, TEST_GUEST);
  await loginAsGuest(context, TEST_GUEST);

  await seedEvents(request, TEST_GUEST, [
    { type: 'guest_landing_viewed', created_at: minutesAgo(2) },
  ]);

  await page.goto('/');

  await expectHintShown(page, 'guest-register-prompt');
});

test('guest-register-prompt НЕ показывается, если гость уже открывал форму регистрации', async ({
  context,
  request,
  page,
}) => {
  await cleanActor(request, TEST_GUEST);
  await loginAsGuest(context, TEST_GUEST);

  await seedEvents(request, TEST_GUEST, [
    { type: 'guest_landing_viewed', created_at: minutesAgo(2) },
    { type: 'guest_signup_form_opened', created_at: minutesAgo(1) },
  ]);

  await page.goto('/');

  await expectHintNotShown(page, 'guest-register-prompt');
});
