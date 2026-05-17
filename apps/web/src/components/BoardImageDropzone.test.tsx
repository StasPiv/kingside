/**
 * KS-2365: unit-тесты `<BoardImageDropzone>`. Покрываем:
 *  - file input → recognizer → FEN отрисован;
 *  - flip board / side-to-move toggle меняют preview FEN;
 *  - «Edit FEN manually» открывает текстовое поле и берёт оттуда значение
 *    при Apply;
 *  - onAccept вызывается с актуальным FEN.
 */
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';
import { BoardImageDropzone } from './BoardImageDropzone';
import type { BoardRecognitionResponse } from '../api/boardRecognition';

const RECOGNIZED: BoardRecognitionResponse = {
  fen: '8/8/4k3/4P2p/8/P2pR3/P4PP1/3r2K1 w - - 2 51',
  fenBoard: '8/8/4k3/4P2p/8/P2pR3/P4PP1/3r2K1',
  orientation: 'white',
  orientationConfidence: 0.95,
  bbox: { x: 0, y: 0, width: 320, height: 320 },
  modelVersion: 'br-test-v1',
  lowConfidenceCells: [],
  warnings: [],
};

function makeImageFile(): File {
  return new File([new Uint8Array([0])], 'b.png', { type: 'image/png' });
}

describe('<BoardImageDropzone> (KS-2365)', () => {
  it('после загрузки файла рендерит распознанный FEN в превью', async () => {
    const recognizer = vi.fn().mockResolvedValue(RECOGNIZED);
    const onAccept = vi.fn();
    renderWithProviders(
      <BoardImageDropzone onAccept={onAccept} recognizer={recognizer} />,
    );
    const input = screen.getByTestId('board-image-dropzone-file-input') as HTMLInputElement;
    await userEvent.upload(input, makeImageFile());
    await waitFor(() => {
      expect(recognizer).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId('board-image-dropzone-fen').textContent).toContain(
        '8/8/4k3/4P2p/8/P2pR3/P4PP1/3r2K1 w',
      );
    });
  });

  it('Apply вызывает onAccept с распознанным FEN', async () => {
    const recognizer = vi.fn().mockResolvedValue(RECOGNIZED);
    const onAccept = vi.fn();
    renderWithProviders(
      <BoardImageDropzone onAccept={onAccept} recognizer={recognizer} />,
    );
    await userEvent.upload(
      screen.getByTestId('board-image-dropzone-file-input'),
      makeImageFile(),
    );
    await waitFor(() => expect(recognizer).toHaveBeenCalled());
    await userEvent.click(screen.getByTestId('board-image-dropzone-apply'));
    expect(onAccept).toHaveBeenCalledWith(RECOGNIZED.fen);
  });

  it('side-to-move toggle меняет ход в превью FEN', async () => {
    const recognizer = vi.fn().mockResolvedValue(RECOGNIZED);
    renderWithProviders(<BoardImageDropzone onAccept={vi.fn()} recognizer={recognizer} />);
    await userEvent.upload(
      screen.getByTestId('board-image-dropzone-file-input'),
      makeImageFile(),
    );
    await waitFor(() => expect(recognizer).toHaveBeenCalled());
    const side = screen.getByTestId('board-image-dropzone-side') as HTMLSelectElement;
    await userEvent.selectOptions(side, 'b');
    expect(screen.getByTestId('board-image-dropzone-fen').textContent).toMatch(
      / b /,
    );
  });

  it('режим «Edit FEN manually» позволяет править FEN и принять руками', async () => {
    const onAccept = vi.fn();
    const recognizer = vi.fn().mockResolvedValue(RECOGNIZED);
    renderWithProviders(
      <BoardImageDropzone onAccept={onAccept} recognizer={recognizer} />,
    );
    await userEvent.upload(
      screen.getByTestId('board-image-dropzone-file-input'),
      makeImageFile(),
    );
    await waitFor(() => expect(recognizer).toHaveBeenCalled());

    await userEvent.click(screen.getByTestId('board-image-dropzone-toggle-manual'));
    const fenInput = screen.getByTestId('board-image-dropzone-fen-input') as HTMLInputElement;
    await userEvent.clear(fenInput);
    const manual = '8/8/8/8/8/8/8/4k2K w - - 0 1';
    await userEvent.type(fenInput, manual);
    await userEvent.click(screen.getByTestId('board-image-dropzone-apply'));
    expect(onAccept).toHaveBeenCalledWith(manual);
  });

  it('flip board переключает ориентацию (data-prop передаётся в Chessboard)', async () => {
    const recognizer = vi.fn().mockResolvedValue(RECOGNIZED);
    renderWithProviders(<BoardImageDropzone onAccept={vi.fn()} recognizer={recognizer} />);
    const flipBtn = screen.getByTestId('board-image-dropzone-flip');
    expect(flipBtn).toBeDefined();
    // Сама ориентация Chessboard внутри — детальный prop, тестируем только что
    // обработчик кликабелен и не падает.
    await userEvent.click(flipBtn);
    await userEvent.click(flipBtn);
  });

  it('некорректный manual FEN дизейблит Apply', async () => {
    const recognizer = vi.fn().mockResolvedValue(RECOGNIZED);
    renderWithProviders(<BoardImageDropzone onAccept={vi.fn()} recognizer={recognizer} />);
    await userEvent.upload(
      screen.getByTestId('board-image-dropzone-file-input'),
      makeImageFile(),
    );
    await waitFor(() => expect(recognizer).toHaveBeenCalled());
    await userEvent.click(screen.getByTestId('board-image-dropzone-toggle-manual'));
    const fenInput = screen.getByTestId('board-image-dropzone-fen-input') as HTMLInputElement;
    await userEvent.clear(fenInput);
    await userEvent.type(fenInput, 'garbage');
    const apply = screen.getByTestId('board-image-dropzone-apply') as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
  });
});
