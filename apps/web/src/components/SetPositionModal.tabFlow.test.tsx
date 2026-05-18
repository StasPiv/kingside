// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import userEvent from '@testing-library/user-event';
import { cleanup } from '@testing-library/react';

import { renderWithProviders, screen, waitFor } from '../test/test-utils';

/**
 * KS-3095: после распознавания картинки `SetPositionModal` остаётся
 * на вкладке `image` (а не уходит автоматом в `editor`), и state
 * вкладки сохраняется при ручном переключении.
 */

// Мок BoardImageDropzone: на mount сразу дёргает `onRecognized` с
// валидным FEN — имитируем «backend вернул успешный ответ». Реальный
// компонент покрыт своим сьютом.
vi.mock('./BoardImageDropzone', () => ({
  BoardImageDropzone: function MockDropzone({
    onRecognized,
  }: {
    onRecognized?: (fen: string) => void;
    onAccept: (fen: string) => void;
  }) {
    useEffect(() => {
      onRecognized?.(
        '8/8/4k3/4P2p/8/P2pR3/P4PP1/3r2K1 w - - 2 51',
      );
    }, [onRecognized]);
    return <div data-testid="mock-dropzone">mock</div>;
  },
}));

import { SetPositionModal } from './SetPositionModal';

beforeEach(() => {
  cleanup();
});

describe('SetPositionModal — KS-3095 tab-flow после распознавания', () => {
  it('после onRecognized активная вкладка остаётся image, editor — hidden', async () => {
    renderWithProviders(
      <SetPositionModal
        initialTab="image"
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByTestId('mock-dropzone')).not.toBeNull(),
    );
    // Image-вкладка активна (parentElement — её body, не hidden).
    const dropzoneWrapper = screen.getByTestId('mock-dropzone').parentElement!;
    expect(dropzoneWrapper.hasAttribute('hidden')).toBe(false);
    // Editor-body отрисован, но скрыт через hidden.
    const editorBody = document.querySelector('.set-position-editor');
    expect(editorBody).not.toBeNull();
    expect(editorBody!.hasAttribute('hidden')).toBe(true);
  });

  it('переключение на Board Editor и обратно: mock-dropzone остаётся в DOM (state не сброшен)', async () => {
    renderWithProviders(
      <SetPositionModal
        initialTab="image"
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByTestId('mock-dropzone')).not.toBeNull(),
    );
    const dropzoneWrapper = screen.getByTestId('mock-dropzone').parentElement!;

    // Клик по вкладке Board Editor.
    const editorTab = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.set-position-tab'),
    ).find((b) => b.textContent === 'Board Editor');
    expect(editorTab).toBeTruthy();
    await userEvent.click(editorTab!);

    // mock-дропзона осталась смонтирована (скрыта).
    expect(screen.queryByTestId('mock-dropzone')).not.toBeNull();
    expect(dropzoneWrapper.hasAttribute('hidden')).toBe(true);
    const editorBody = document.querySelector('.set-position-editor');
    expect(editorBody!.hasAttribute('hidden')).toBe(false);

    // Возвращаемся на image — снова hidden=false.
    const imageTab = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.set-position-tab'),
    ).find((b) => b.getAttribute('data-testid') === 'set-position-tab-image');
    expect(imageTab).toBeTruthy();
    await userEvent.click(imageTab!);
    expect(dropzoneWrapper.hasAttribute('hidden')).toBe(false);
  });

  it('Board Editor получил распознанную позицию (editorTurn=w из FEN)', async () => {
    renderWithProviders(
      <SetPositionModal
        initialTab="image"
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByTestId('mock-dropzone')).not.toBeNull(),
    );
    const sideSelect = document.querySelector<HTMLSelectElement>(
      '.set-position-options select',
    );
    expect(sideSelect).toBeTruthy();
    expect(sideSelect!.value).toBe('w');
  });
});
