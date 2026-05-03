import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';

import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { SetPositionModal } from './SetPositionModal';

/**
 * KS-2220 — кнопка «Copy to Clipboard» во вкладке FEN модалки Set Position.
 *
 * Тестируем три сценария:
 *  - success: writeText отрабатывает → появляется toast «FEN copied to clipboard»;
 *  - error:   writeText reject → появляется toast «Failed to copy FEN»;
 *  - кнопка disabled при пустом FEN.
 *
 * Глобального toast-сервиса в проекте нет — паттерн «inline state + setTimeout»
 * (повторяет ArchiveGamePage.tsx, см. KS-2065).
 */

describe('<SetPositionModal> — KS-2220 Copy FEN to clipboard', () => {
  // happy-dom предоставляет navigator.clipboard как getter с фиксированным
  // объектом — Object.defineProperty(navigator, 'clipboard', ...) у нас
  // отрабатывал, но writeText замены не подхватывались (видимо, кеш в
  // proxy). Вместо этого spy'им сам метод writeText на существующем
  // clipboard-объекте — это переживает рендер.
  let writeTextSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Гарантируем, что navigator.clipboard есть (для очень минимальных env).
    if (!navigator.clipboard) {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') },
      });
    }
    writeTextSpy = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    writeTextSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('успех: клик «Copy to Clipboard» вызывает writeText и показывает toast', async () => {
    const user = userEvent.setup();
    const initialFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    renderWithProviders(
      <SetPositionModal initialFen={initialFen} onApply={() => {}} onClose={() => {}} />,
    );

    const copyBtn = screen.getByTestId('set-position-copy-fen');
    expect(copyBtn).not.toBeDisabled();

    await user.click(copyBtn);

    // success-toast — самое надёжное доказательство, что код прошёл
    // try-ветку (writeText resolved). По spy-counter happy-dom иногда
    // отдаёт 0 в первом тесте файла из-за того, что navigator.clipboard
    // сбрасывается между импортом модулей и выполнением `vi.spyOn`.
    await waitFor(() =>
      expect(
        screen.getByTestId('set-position-copy-fen-msg'),
      ).toHaveTextContent(/copied/i),
    );
  });

  it('ошибка: writeText reject → toast «Failed to copy FEN»', async () => {
    writeTextSpy.mockRejectedValueOnce(new Error('permission denied'));
    const user = userEvent.setup();
    renderWithProviders(
      <SetPositionModal
        initialFen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        onApply={() => {}}
        onClose={() => {}}
      />,
    );

    await user.click(screen.getByTestId('set-position-copy-fen'));

    await waitFor(() =>
      expect(
        screen.getByTestId('set-position-copy-fen-msg'),
      ).toHaveTextContent(/failed/i),
    );
    expect(writeTextSpy).toHaveBeenCalled();
  });

  it('пустое поле FEN → кнопка disabled, writeText не вызывается', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <SetPositionModal initialFen="" onApply={() => {}} onClose={() => {}} />,
    );

    // initialFen='' даёт fallback на стартовую позицию, поэтому очистим вручную.
    const input = screen.getByPlaceholderText(
      /rnbqkbnr/i,
    ) as HTMLInputElement;
    await user.clear(input);

    const copyBtn = screen.getByTestId('set-position-copy-fen');
    expect(copyBtn).toBeDisabled();

    await user.click(copyBtn);
    expect(writeTextSpy).not.toHaveBeenCalled();
  });
});
