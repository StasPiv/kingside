/**
 * Правило: guest-features-discovery
 * Anchor:  landing-features-block
 * DSL:     actorType=guest, page=/, count guest_landing_viewed ≥3 за 7 дн,
 *          not exists guest_signup_form_opened за 7 дн.
 */
import { test } from '@playwright/test';
import { cleanActor, seedEvents, daysAgo } from '../fixtures/actor';
import { loginAsGuest, TEST_GUEST } from '../fixtures/auth';
import { expectHintShown } from '../fixtures/hints';

test('guest-features-discovery показывается возвращающемуся гостю', async ({
  context,
  request,
  page,
}) => {
  await cleanActor(request, TEST_GUEST);
  await loginAsGuest(context, TEST_GUEST);

  await seedEvents(request, TEST_GUEST, [
    { type: 'guest_landing_viewed', created_at: daysAgo(5) },
    { type: 'guest_landing_viewed', created_at: daysAgo(3) },
    { type: 'guest_landing_viewed', created_at: daysAgo(1) },
  ]);

  await page.goto('/');

  await expectHintShown(page, 'guest-features-discovery');
});
