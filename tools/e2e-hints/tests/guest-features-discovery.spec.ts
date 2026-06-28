/**
 * Правило: guest-features-discovery
 * Anchor:  landing-features-block
 * DSL:     actorType=guest, page=/, count guest_landing_viewed ≥3 за 7 дн,
 *          not exists guest_signup_form_opened за 7 дн.
 */
import { test } from '@playwright/test';
import { cleanActor, seedEvents, daysAgo } from '../fixtures/actor';
import { loginAsGuest } from '../fixtures/auth';
import { expectHintAppearsAfterEmit } from '../fixtures/hints';

test('guest-features-discovery показывается возвращающемуся гостю', async ({
  context,
  request,
  page,
}) => {
  const guest = await loginAsGuest(context, request);
  await cleanActor(request, guest);

  await seedEvents(request, guest, [
    { type: 'guest_landing_viewed', created_at: daysAgo(5) },
    { type: 'guest_landing_viewed', created_at: daysAgo(3) },
    { type: 'guest_landing_viewed', created_at: daysAgo(1) },
  ]);

  await page.goto('/');
  await expectHintAppearsAfterEmit(page, request, guest, '/', 'guest-features-discovery');
});
