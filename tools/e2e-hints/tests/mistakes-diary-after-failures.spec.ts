/**
 * Правило: mistakes-diary-after-failures
 * Anchor:  profile-mistakes-link (на /player/<username>(/*))
 * DSL:     puzzle_failed ≥5 за 7 дней, нет feature_used{mistakes_diary_opened} за 30 дн
 *
 * USERNAME тестового user'а — фиксированный (test-fixture, см.
 * docker-compose.test-hints.yml).
 */
import { test } from '@playwright/test';
import { cleanActor, seedEvents, daysAgo, hoursAgo } from '../fixtures/actor';
import { loginAs, TEST_USER } from '../fixtures/auth';
import { expectHintShown, expectHintNotShown } from '../fixtures/hints';

const TEST_USERNAME = process.env.E2E_HINTS_TEST_USERNAME || 'tester';

test('mistakes-diary показывается после 5 puzzle_failed за неделю', async ({
  context,
  request,
  page,
}) => {
  await cleanActor(request, TEST_USER);
  await loginAs(context, request, TEST_USER);

  await seedEvents(request, TEST_USER, [
    { type: 'puzzle_failed', created_at: daysAgo(6) },
    { type: 'puzzle_failed', created_at: daysAgo(5) },
    { type: 'puzzle_failed', created_at: daysAgo(3) },
    { type: 'puzzle_failed', created_at: daysAgo(2) },
    { type: 'puzzle_failed', created_at: hoursAgo(6) },
  ]);

  await page.goto(`/player/${TEST_USERNAME}`);

  await expectHintShown(page, 'mistakes-diary-after-failures');
});

test('mistakes-diary НЕ показывается, если дневник ошибок уже открывали', async ({
  context,
  request,
  page,
}) => {
  await cleanActor(request, TEST_USER);
  await loginAs(context, request, TEST_USER);

  await seedEvents(request, TEST_USER, [
    { type: 'puzzle_failed', created_at: daysAgo(6) },
    { type: 'puzzle_failed', created_at: daysAgo(5) },
    { type: 'puzzle_failed', created_at: daysAgo(3) },
    { type: 'puzzle_failed', created_at: daysAgo(2) },
    { type: 'puzzle_failed', created_at: hoursAgo(6) },
    {
      type: 'feature_used',
      payload: { feature_key: 'mistakes_diary_opened' },
      created_at: daysAgo(1),
    },
  ]);

  await page.goto(`/player/${TEST_USERNAME}`);

  await expectHintNotShown(page, 'mistakes-diary-after-failures');
});
