/**
 * Правило: hint-overuse-mistakes-diary
 * Anchor:  profile-mistakes-link
 * DSL:     count hint_used ≥5 за 7 дней.
 */
import { test } from '@playwright/test';
import { cleanActor, seedEvents, daysAgo } from '../fixtures/actor';
import { loginAs, TEST_USER } from '../fixtures/auth';
import { expectHintAppearsAfterEmit } from '../fixtures/hints';

// KS-4763: см. mistakes-diary-after-failures.spec.ts — DEV username.
const TEST_USERNAME = process.env.E2E_HINTS_TEST_USERNAME || 'DEV';

test('hint-overuse показывается после 5 hint_used за неделю', async ({
  context,
  request,
  page,
}) => {
  await cleanActor(request, TEST_USER);
  await loginAs(context, request, TEST_USER);

  await seedEvents(
    request,
    TEST_USER,
    Array.from({ length: 5 }, (_, i) => ({
      type: 'hint_used',
      created_at: daysAgo(6 - i),
    })),
  );

  const route = `/player/${TEST_USERNAME}`;
  await page.goto(route);
  await expectHintAppearsAfterEmit(page, request, TEST_USER, route, 'hint-overuse-mistakes-diary');
});
