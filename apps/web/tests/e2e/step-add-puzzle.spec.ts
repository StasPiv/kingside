import { expect, test } from '@playwright/test';

import { emptyStepPayload } from '../../src/types/editor';

/**
 * KS-1873: добавление puzzle-шага с дефолтным payload'ом не должно
 * падать 400 на backend DTO `UserPuzzleStepPayloadDto`. Прямой POST
 * через dev-сервер — без UI-цепочки, чтобы тест не зависел от
 * `StepTypePicker` рендера / переключения tabs / autosave.
 *
 * `text` и `endgame_drill` дефолты тоже проверяем — DoD KS-1873.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';

test.describe.configure({ mode: 'serial' });

test('default payload каждого supported user-step-type принимается backend (POST 200)', async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Network-only e2e.');

  const login = await fetch(`${API_URL}/auth/dev-bypass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: DEV_BYPASS_SECRET,
      user: `ks1873-${Date.now()}`,
    }),
  });
  expect(login.ok).toBe(true);
  const tokens = (await login.json()) as { accessToken: string };
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${tokens.accessToken}`,
  };

  // Курс + урок (с ретраями на 429 — лимитер create-course).
  let course: { id: string; slug: string } | null = null;
  for (let i = 0; i < 6; i += 1) {
    const r = await fetch(`${API_URL}/lessons/user-courses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: `KS-1873 ${Date.now()}` }),
    });
    if (r.ok) {
      course = (await r.json()) as { id: string; slug: string };
      break;
    }
    if (r.status !== 429) throw new Error(`create-course: ${r.status}`);
    await new Promise((res) => setTimeout(res, 2000 * 2 ** i));
  }
  if (!course) throw new Error('create-course failed');
  const lesson = (await (
    await fetch(`${API_URL}/lessons/user-courses/${course.id}/lessons`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'l' }),
    })
  ).json()) as { id: string };

  // 3 supported user-step-type'а из ADR-026 §2.3 (whitelist).
  for (const type of ['text', 'puzzle', 'endgame_drill'] as const) {
    const payload = emptyStepPayload(type);
    const res = await fetch(
      `${API_URL}/lessons/user-lessons/${lesson.id}/steps`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ type, payload }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `POST step type=${type} failed: ${res.status} ${body}`,
      );
    }
    const created = (await res.json()) as { id: string; type: string };
    expect(created.type).toBe(type);
  }

  // Cleanup
  await fetch(`${API_URL}/lessons/user-courses/${course.id}`, {
    method: 'DELETE',
    headers,
  });
});
