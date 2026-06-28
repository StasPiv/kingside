/**
 * Правило: analyze-after-loss
 * Anchor:  game-end-analysis-button (модалка game-end в /play)
 * DSL:     event=game_end, where: result string_equals 'loss', windowMin окно
 *          (см. реальное правило через GET /admin/hints/<id>)
 *
 * Этот сценарий использует РЕАЛЬНЫЙ flow — играем с ботом и проигрываем,
 * чтобы получить game_end из game-service (через internal-events). Backdating
 * тут не подойдёт: модалка game-end показывается только сразу после партии
 * на основе текущего ws-стейта, не от историчных событий.
 *
 * Зависимость: KS-4757 (string_equals в DSL) — без него правило либо
 * отключено, либо игнорируется evaluator'ом.
 */
import { test, expect } from '@playwright/test';
import { cleanActor } from '../fixtures/actor';
import { loginAs, TEST_USER } from '../fixtures/auth';
import { expectHintShown } from '../fixtures/hints';

test.skip(
  process.env.E2E_HINTS_SKIP_GAME_FLOW === '1',
  'требует bot-flow в game-service на test-окружении',
);

test('analyze-after-loss показывается в game-end после проигрыша боту', async ({
  context,
  request,
  page,
}) => {
  await cleanActor(request, TEST_USER);
  await loginAs(context, request, TEST_USER);

  await page.goto('/play');

  // Кнопка «Играть с ботом» — селектор зависит от текущей вёрстки лобби.
  // Конкретный data-testid уточнить в LobbyPage.tsx (KS-4753 ссылается на
  // `puzzles-rush-tab` через `puzzle-browser-tabs` — здесь аналогично).
  await page.getByRole('button', { name: /play.*bot|играть.*бот/i }).click();

  // Сыграть короткую партию до мата — для теста бот выставлен на максимум
  // сложности через ENV BOT_FORCE_LEVEL=8 (T3 docker-compose).
  // Конкретные ходы — TODO после стабилизации test-окружения; здесь
  // placeholder через ожидание появления game-end модалки.
  await expect(page.getByText(/checkmate|шах и мат/i)).toBeVisible({ timeout: 120_000 });

  await expectHintShown(page, 'analyze-after-loss');
});
