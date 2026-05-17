import { expect, test } from '@playwright/test';

/**
 * KS-2365 / ADR-040 §7 — e2e для `<BoardImageDropzone>`.
 *
 * Сценарий из Acceptance:
 *   1. Открыть dev-страницу `/dev/board-image-dropzone` (только в dev-
 *      сборке, KS-1821 tree-shake'ает в prod).
 *   2. Через скрытый file-input «загрузить» изображение (1×1 PNG
 *      data-buffer — реальный распознаватель не нужен; в KS-2365
 *      backend KS-2363 ещё не готов, фронт-клиент `recognizeBoard`
 *      сам отдаёт мок).
 *   3. Убедиться, что FEN отрисован в `[data-testid="board-image-
 *      dropzone-fen"]` (мок отдаёт стартовую позицию).
 *   4. Нажать Apply → подтверждённый FEN появляется в demo-блоке.
 *
 * Drag&drop в headless-Chromium через `dataTransfer.files` чувствителен
 * к деталям protected DOM-API; spec работает через `setInputFiles` —
 * это идентичный UX-вход (`<input type="file">`), который у нас
 * рендерит сам компонент.
 */

const DROPZONE_URL = '/dev/board-image-dropzone';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function pngBuffer(): Buffer {
  return Buffer.from(TINY_PNG_BASE64, 'base64');
}

test.describe('KS-2365 BoardImageDropzone', () => {
  test('upload → FEN отрисован и Apply возвращает FEN', async ({ page }) => {
    // На dev-сервере `recognizeBoard` отдаёт мок (стартовая позиция)
    // при 404 от backend'а — KS-2363 ещё не задеплоен. Это и есть
    // happy path для этого spec'а.
    await page.goto(DROPZONE_URL);

    // Скрытый file-input — стандартный UX вход компонента; компонент
    // привязывает onChange к нему.
    const fileInput = page.getByTestId('board-image-dropzone-file-input');
    await fileInput.setInputFiles({
      name: 'board.png',
      mimeType: 'image/png',
      buffer: pngBuffer(),
    });

    // Ждём пока recognizer вернёт ответ и FEN отрисуется.
    const fenLocator = page.getByTestId('board-image-dropzone-fen');
    await expect(fenLocator).toBeVisible();
    // Мок отдаёт стартовую позицию.
    await expect(fenLocator).toContainText(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
      { timeout: 10_000 },
    );

    // Доска тоже отрисована.
    await expect(page.getByTestId('board-image-dropzone-board')).toBeVisible();

    // Apply передаёт FEN наружу — dev-страница рендерит его в applied-блоке.
    await page.getByTestId('board-image-dropzone-apply').click();
    await expect(page.getByTestId('dev-board-image-dropzone-applied')).toContainText(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
    );
  });

  test('side-to-move toggle меняет FEN', async ({ page }) => {
    await page.goto(DROPZONE_URL);
    await page.getByTestId('board-image-dropzone-file-input').setInputFiles({
      name: 'board.png',
      mimeType: 'image/png',
      buffer: pngBuffer(),
    });
    const fenLocator = page.getByTestId('board-image-dropzone-fen');
    await expect(fenLocator).toContainText(' w ', { timeout: 10_000 });

    await page.getByTestId('board-image-dropzone-side').selectOption('b');
    await expect(fenLocator).toContainText(' b ');
  });

  test('manual FEN edit перебивает распознавание и идёт в Apply', async ({ page }) => {
    await page.goto(DROPZONE_URL);
    await page.getByTestId('board-image-dropzone-file-input').setInputFiles({
      name: 'board.png',
      mimeType: 'image/png',
      buffer: pngBuffer(),
    });
    await expect(page.getByTestId('board-image-dropzone-fen')).toBeVisible();

    await page.getByTestId('board-image-dropzone-toggle-manual').click();
    const manualFen = '8/8/8/8/8/8/8/4k2K w - - 0 1';
    const fenInput = page.getByTestId('board-image-dropzone-fen-input');
    await fenInput.fill(manualFen);

    await page.getByTestId('board-image-dropzone-apply').click();
    await expect(page.getByTestId('dev-board-image-dropzone-applied')).toContainText(
      manualFen,
    );
  });
});
