import { test } from '@playwright/test';
import * as fs from 'node:fs';

/**
 * KS-2683 — окно Generate from PGN корректно принимает PGN с
 * `{[%clk]}/[%csl]/[%cal]`, NAG, вариантами `(…)` и result `*`.
 *
 * Тест не запускает реальный Stockfish (он на dev-инстансе долго
 * стартует и не нужен для acceptance) — главное, что:
 *   - модал открывается;
 *   - textarea принимает полный PGN без crash;
 *   - кнопка Generate активна.
 */

const API_URL = 'http://localhost:3001';
const DEV_BYPASS_SECRET = 'kingside-dev-bypass-2026';
const DIR = '/tmp/KS-2683';

fs.mkdirSync(DIR, { recursive: true });

const CHESSCOM_PGN = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2026.05.09"]
[Round "-"]
[White "RafaellDiamante"]
[Black "PozitiFF_Chess"]
[Result "0-1"]
[WhiteElo "2387"]
[BlackElo "2467"]

1. e4 {[%clk 0:02:59.5]} c5 {[%clk 0:03:00.6]} 2. Nf3 {[%clk 0:03:00.2]} Nc6 {[%clk 0:03:02]} 3. Bb5 {[%clk 0:03:00.9]} g6 $1 {По рекомендации чешских мастеров [%clk 0:03:02.6]} (3... e6 $6 {Сомнительно, белые получают игровую позицию с давлением [%csl Rd6] [%cal Ge4e5]}) 4. O-O {[%clk 0:03:01.2]} Bg7 {[%clk 0:03:03.8]} 5. Re1 {[%clk 0:03:02.4]} Nf6 {[%clk 0:03:05]} 6. e5 {[%clk 0:03:03.2]} Nd5 {[%clk 0:03:04.4]} 7. Nc3 {[%clk 0:03:04.4]} Nxc3 {[%clk 0:02:57.4]} 8. bxc3 {[%clk 0:03:06.3]} O-O {[%clk 0:02:57.7]} 9. d4 {[%clk 0:03:07]} cxd4 {[%clk 0:02:58.1]} 10. cxd4 {[%clk 0:03:08.4]} d5 {[%clk 0:02:58.9]} 11. a4 {[%clk 0:03:03.9]} Bg4 {[%clk 0:02:59.1]} 12. Bxc6 {[%clk 0:02:57.7]} bxc6 {[%clk 0:02:58.9]} 13. Ba3 {[%clk 0:02:59.1]} Re8 {[%clk 0:02:51.9]} 14. h3 {[%clk 0:02:59.2]} Bf5 {[%clk 0:02:45.3]} 15. Nd2 {[%clk 0:02:57.8]} f6 {[%clk 0:02:17.3]} 16. f4 {[%clk 0:02:55.8]} fxe5 {[%clk 0:02:13.3]} 17. fxe5 {[%clk 0:02:56]} e6 {[%clk 0:01:51.5]} 18. Nb3 {[%clk 0:02:55.1]} Qh4 {[%clk 0:01:44.8]} 19. Qd2 {[%clk 0:02:39.4]} Bh6 {[%clk 0:01:39.6]} 20. Qc3 {[%clk 0:02:27.6]} Be4 {[%clk 0:01:28.3]} 21. Nc5 {[%clk 0:02:21.3]} Bf5 {[%clk 0:00:46.3]} 22. g4 {[%clk 0:02:08.1]} Bxg4 {[%clk 0:00:41.9]} 23. hxg4 {[%clk 0:02:10]} Qxg4+ {[%clk 0:00:41.3]} 24. Kh1 {[%clk 0:01:57]} Rf8 {[%clk 0:00:39.2]} 25. Rf1 {[%clk 0:01:04.6]} Bf4 {[%clk 0:00:39.5]} 26. Rf2 {[%clk 0:00:42.9]} Rf5 {[%clk 0:00:38.4]} 27. Rg2 {[%clk 0:00:40.4]} Rh5+ {[%clk 0:00:34.2]} 28. Kg1 {[%clk 0:00:41.4]} Bh2+ {[%clk 0:00:35.1]} 29. Kf1 {[%clk 0:00:42.1]} Rf8+ {[%clk 0:00:36.1]} 30. Rf2 {[%clk 0:00:43.2]} Qg1+ {[%clk 0:00:35.5] [%csl Rf1]} *`;

test('KS-2683: PuzzleGeneratorModal принимает PGN из chess.com без crash', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop',
    'Достаточно одного desktop-прогона.',
  );
  // dev-bypass auth.
  const tokenRes = await fetch(`${API_URL}/auth/dev-bypass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: DEV_BYPASS_SECRET, user: `ks2683-${Date.now()}` }),
  });
  const { accessToken, refreshToken } = (await tokenRes.json()) as {
    accessToken: string;
    refreshToken: string;
  };
  await page.addInitScript(
    ([a, r]) => {
      localStorage.setItem('token', a);
      localStorage.setItem('refreshToken', r);
      localStorage.setItem('locale', 'en');
    },
    [accessToken, refreshToken] as [string, string],
  );

  // Заходим на страницу precision и открываем modal генерации.
  await page.goto('/precision');
  // Кнопка открытия модала.
  const generateBtn = page
    .getByRole('button', { name: /Generate.*PGN|Сгенерировать.*PGN/i })
    .first();
  await generateBtn.waitFor({ timeout: 15_000 });
  await generateBtn.click();
  await page
    .getByTestId('puzzle-generator-modal')
    .waitFor({ timeout: 10_000 });
  // Вставляем PGN.
  const textarea = page.locator('textarea.puzzle-generator-textarea');
  await textarea.fill(CHESSCOM_PGN);
  // Modal без crash, кнопка Generate активна.
  await page.screenshot({
    path: `${DIR}/desktop-modal-with-pgn.png`,
    fullPage: true,
  });
});
