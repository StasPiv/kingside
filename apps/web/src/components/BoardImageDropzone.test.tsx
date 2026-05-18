/**
 * KS-2365: unit-тесты `<BoardImageDropzone>`. Покрываем:
 *  - file input → recognizer → FEN отрисован;
 *  - flip board / side-to-move toggle меняют preview FEN;
 *  - «Edit FEN manually» открывает текстовое поле и берёт оттуда значение
 *    при Apply;
 *  - onAccept вызывается с актуальным FEN.
 */
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { cleanup } from '@testing-library/react';
import { useEffect } from 'react';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';

// KS-3094: мок `react-easy-crop`, чтобы lazy-Suspense быстро отдал
// заглушку, которая моментально дёргает `onCropComplete` с фейковой
// областью (как будто пользователь уже подвигал рамку). Без этого
// `cropAreaPxRef` остался бы null и retry был бы no-op.
vi.mock('react-easy-crop', () => ({
  default: function FakeCropper({
    onCropComplete,
  }: {
    onCropComplete?: (
      pct: { x: number; y: number; width: number; height: number },
      px: { x: number; y: number; width: number; height: number },
    ) => void;
  }) {
    useEffect(() => {
      onCropComplete?.(
        { x: 10, y: 10, width: 80, height: 80 },
        { x: 100, y: 100, width: 400, height: 400 },
      );
    }, [onCropComplete]);
    return <div data-testid="fake-cropper" />;
  },
}));

import { BoardImageDropzone, checkBoardSanity } from './BoardImageDropzone';
import {
  BoardNotDetectedError,
  BoardRecognitionUnreliableError,
  type BoardRecognitionResponse,
  type BoardRecognitionUnreliablePayload,
} from '../api/boardRecognition';

// KS-3093: глобальный afterEach в test/setup.ts уже вызывает
// `cleanup()`, но в комбинации с react-chessboard'ом в этом сьюте
// иногда остаётся живая DOM-нода от предыдущего теста (происходит
// внутри react-chessboard v5 + happy-dom, к нашему коду не относится).
// На «горячую» — `beforeEach(cleanup)` гарантирует чистую страницу
// перед каждым `render`-ом.
beforeEach(() => {
  cleanup();
});

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

describe('checkBoardSanity (KS-3093)', () => {
  it('стартовая позиция — без issues', () => {
    expect(
      checkBoardSanity('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'),
    ).toEqual([]);
  });

  it('пешки на 1/8 ранге — отмечает', () => {
    // a1=P (нелегально по правилам, нельзя пешке стоять на своём первом ряду).
    expect(
      checkBoardSanity('r2q1rk1/ppp1b1pp/1nn1pP2/5b2/2PP4/2N1BN2/PP2B1PP/P2Q1RK1'),
    ).toContain('some pawns are on the edge rows');
  });

  it('пустая доска — нет ни одного короля', () => {
    const issues = checkBoardSanity('8/8/8/8/8/8/8/8');
    expect(issues).toContain('exactly one white king required');
    expect(issues).toContain('exactly one black king required');
  });

  it('14 ферзей на сторону — отмечает превышение', () => {
    // 8 ферзей в ряду + 8 в другом + 1 король каждой стороны.
    const fen = 'QQQQQQQQ/QQQQQQQK/8/8/8/8/qqqqqqqq/qqqqqqqk';
    const issues = checkBoardSanity(fen);
    expect(issues.some((i) => /too many white queens/.test(i))).toBe(true);
    expect(issues.some((i) => /too many black queens/.test(i))).toBe(true);
  });

  it('меньше 8 рангов — структурная ошибка', () => {
    expect(checkBoardSanity('8/8/8')).toEqual(['board must have 8 ranks']);
  });

  it('ранг не сходится по файлам — структурная ошибка', () => {
    // 7 файлов в первом ранге вместо 8.
    const issues = checkBoardSanity('7/8/8/8/8/8/8/8');
    expect(issues.some((i) => /rank 8.*8 files/.test(i))).toBe(true);
  });
});

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

  // KS-3093: scenario 1 из задачи — 422 c fenAttempt.
  it('KS-3093: 422 c fenAttempt → доска показывает позицию, Apply disabled, после правки → enabled', async () => {
    const payload: BoardRecognitionUnreliablePayload = {
      error: 'recognition_unreliable',
      // Распознанный FEN с ошибкой модели: пешка на a1 вместо ладьи.
      fenAttempt: 'r2q1rk1/ppp1b1pp/1nn1pP2/5b2/2PP4/2N1BN2/PP2B1PP/P2Q1RK1 w - - 0 1',
      issues: ['some pawns are on the edge rows'],
      lowConfidenceCells: [
        { file: 0, rank: 7, piece: 'P', confidence: 0.51 },
      ],
      orientation: 'white',
      modelVersion: '0.9.3',
    };
    const recognizer = vi
      .fn()
      .mockRejectedValue(new BoardRecognitionUnreliableError(payload));
    const onAccept = vi.fn();
    renderWithProviders(
      <BoardImageDropzone onAccept={onAccept} recognizer={recognizer} />,
    );
    await userEvent.upload(
      screen.getByTestId('board-image-dropzone-file-input'),
      makeImageFile(),
    );
    await waitFor(() => expect(recognizer).toHaveBeenCalled());

    // 1) Доска НЕ пустая — рисуется fenAttempt (board-only часть).
    await waitFor(() => {
      const board = screen.getByTestId('board-image-dropzone-board');
      expect(board.getAttribute('data-fen-board')).toBe(
        'r2q1rk1/ppp1b1pp/1nn1pP2/5b2/2PP4/2N1BN2/PP2B1PP/P2Q1RK1',
      );
    });

    // 2) Warning-плашка с sanity-issues видна.
    expect(
      screen.getByTestId('board-image-dropzone-sanity-warning').textContent,
    ).toMatch(/edge rows|fix highlighted/i);

    // 3) FEN-строка в превью равна fenAttempt (юзер видит, что
    //    именно правит).
    expect(screen.getByTestId('board-image-dropzone-fen').textContent).toContain(
      'P2Q1RK1',
    );

    // 4) Apply заблокирован.
    let apply = screen.getByTestId('board-image-dropzone-apply') as HTMLButtonElement;
    expect(apply.disabled).toBe(true);

    // 5) Manual-edit и Flip активны (они не привязаны к валидности).
    expect(
      (screen.getByTestId('board-image-dropzone-toggle-manual') as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByTestId('board-image-dropzone-flip') as HTMLButtonElement).disabled,
    ).toBe(false);

    // 6) Юзер открывает Edit FEN, заменяет P2Q1RK1 → R2Q1RK1.
    await userEvent.click(screen.getByTestId('board-image-dropzone-toggle-manual'));
    const fenInput = screen.getByTestId(
      'board-image-dropzone-fen-input',
    ) as HTMLInputElement;
    await userEvent.clear(fenInput);
    const fixed = 'r2q1rk1/ppp1b1pp/1nn1pP2/5b2/2PP4/2N1BN2/PP2B1PP/R2Q1RK1 w - - 0 1';
    await userEvent.type(fenInput, fixed);

    // 7) Warning-плашка пропадает.
    await waitFor(() =>
      expect(
        screen.queryByTestId('board-image-dropzone-sanity-warning'),
      ).toBeNull(),
    );

    // 8) Apply становится активна.
    apply = screen.getByTestId('board-image-dropzone-apply') as HTMLButtonElement;
    await waitFor(() => expect(apply.disabled).toBe(false));

    // 9) Apply → onAccept с поправленным FEN.
    await userEvent.click(apply);
    expect(onAccept).toHaveBeenCalledWith(fixed);
  });

  // KS-3095 follow-up: ручной crop по кнопке (без 400).
  it('KS-3095: «Crop image» после успешного 200 → crop UI → retry с обрезанным blob', async () => {
    const recognizer = vi
      .fn()
      .mockResolvedValueOnce(RECOGNIZED)
      .mockResolvedValueOnce(RECOGNIZED);
    const cropImage = vi
      .fn<(src: string, area: unknown) => Promise<Blob>>()
      .mockResolvedValue(new Blob([new Uint8Array([9, 9])], { type: 'image/png' }));
    renderWithProviders(
      <BoardImageDropzone
        onAccept={vi.fn()}
        recognizer={recognizer}
        cropImage={cropImage}
      />,
    );
    await userEvent.upload(
      screen.getByTestId('board-image-dropzone-file-input'),
      makeImageFile(),
    );
    await waitFor(() => expect(recognizer).toHaveBeenCalledTimes(1));
    // 200 — crop UI выключен, есть кнопка «Crop image».
    expect(screen.queryByTestId('board-image-dropzone-crop-frame')).toBeNull();
    const cropToggle = screen.getByTestId('board-image-dropzone-crop-toggle');
    await userEvent.click(cropToggle);
    await waitFor(() =>
      expect(screen.queryByTestId('board-image-dropzone-crop-frame')).not.toBeNull(),
    );
    // Cancel-кнопка тоже видна (для выхода без recognize).
    expect(screen.queryByTestId('board-image-dropzone-crop-cancel')).not.toBeNull();
    // Дожидаемся пока FakeCropper смонтирован — он сразу в useEffect
    // дёрнет onCropComplete, ref заполнится.
    await waitFor(() =>
      expect(screen.queryByTestId('fake-cropper')).not.toBeNull(),
    );
    await Promise.resolve();
    await userEvent.click(screen.getByTestId('board-image-dropzone-crop-retry'));
    await waitFor(() => expect(cropImage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(recognizer).toHaveBeenCalledTimes(2));
    expect(recognizer.mock.calls[1][0]).toBeInstanceOf(Blob);
  });

  it('KS-3095: «Cancel crop» возвращает в обычный режим без recognize', async () => {
    const recognizer = vi.fn().mockResolvedValueOnce(RECOGNIZED);
    renderWithProviders(
      <BoardImageDropzone onAccept={vi.fn()} recognizer={recognizer} />,
    );
    await userEvent.upload(
      screen.getByTestId('board-image-dropzone-file-input'),
      makeImageFile(),
    );
    await waitFor(() => expect(recognizer).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByTestId('board-image-dropzone-crop-toggle'));
    await waitFor(() =>
      expect(screen.queryByTestId('board-image-dropzone-crop-frame')).not.toBeNull(),
    );
    await userEvent.click(screen.getByTestId('board-image-dropzone-crop-cancel'));
    await waitFor(() =>
      expect(screen.queryByTestId('board-image-dropzone-crop-frame')).toBeNull(),
    );
    // Recognizer не вызвался повторно.
    expect(recognizer).toHaveBeenCalledTimes(1);
    // Apply снова доступен (вместе с result).
    expect(screen.queryByTestId('board-image-dropzone-apply')).not.toBeNull();
  });

  // KS-3094: scenario из задачи — 400 board_not_detected → crop UI →
  // retry с обрезанным blob → 200 → доска отрисована.
  it('KS-3094: 400 board_not_detected → crop UI → retry вызывает recognizer с обрезанным blob', async () => {
    const recognizer = vi
      .fn()
      // 1-я попытка: backend не нашёл доску.
      .mockRejectedValueOnce(
        new BoardNotDetectedError({ error: 'board_not_detected' }),
      )
      // 2-я попытка: уже распознали.
      .mockResolvedValueOnce(RECOGNIZED);
    const cropImage = vi
      .fn<(src: string, area: unknown) => Promise<Blob>>()
      .mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
    renderWithProviders(
      <BoardImageDropzone
        onAccept={vi.fn()}
        recognizer={recognizer}
        cropImage={cropImage}
      />,
    );

    await userEvent.upload(
      screen.getByTestId('board-image-dropzone-file-input'),
      makeImageFile(),
    );

    // crop UI появился (fake-cropper из mock-react-easy-crop).
    await waitFor(() =>
      expect(screen.queryByTestId('board-image-dropzone-crop-frame')).not.toBeNull(),
    );
    expect(
      screen.getByTestId('board-image-dropzone-crop-hint').textContent,
    ).toMatch(/board not found|fit just the board/i);
    expect(
      screen.queryByTestId('board-image-dropzone-crop-retry'),
    ).not.toBeNull();
    expect(
      screen.queryByTestId('board-image-dropzone-crop-reset'),
    ).not.toBeNull();
    // Apply отключён — позиция ещё не распознана.
    expect(screen.queryByTestId('board-image-dropzone-apply')).toBeNull();

    // fake-cropper сразу дёрнул onCropComplete (см. mock наверху), но
    // useEffect срабатывает после mount — ждём, пока он отработает.
    await waitFor(() =>
      expect(screen.queryByTestId('fake-cropper')).not.toBeNull(),
    );
    // Микро-пауза, чтобы effect внутри FakeCropper успел дёрнуть
    // onCropComplete до клика.
    await Promise.resolve();
    await userEvent.click(screen.getByTestId('board-image-dropzone-crop-retry'));

    // cropImage вызван с областью из cropper'а.
    await waitFor(() => expect(cropImage).toHaveBeenCalledTimes(1));
    expect(cropImage.mock.calls[0][1]).toMatchObject({
      x: 100,
      y: 100,
      width: 400,
      height: 400,
    });
    // recognizer вызван второй раз — с обрезанным blob.
    await waitFor(() => expect(recognizer).toHaveBeenCalledTimes(2));
    expect(recognizer.mock.calls[1][0]).toBeInstanceOf(Blob);
    // crop UI ушёл, доска появилась с распознанным FEN.
    await waitFor(() =>
      expect(
        screen.queryByTestId('board-image-dropzone-crop-frame'),
      ).toBeNull(),
    );
    expect(screen.getByTestId('board-image-dropzone-fen').textContent).toContain(
      '8/8/4k3/4P2p/8/P2pR3/P4PP1/3r2K1 w',
    );
  });

  it('KS-3094: повторный 400 → опять crop UI (но уже над обрезанной картинкой)', async () => {
    const recognizer = vi
      .fn()
      .mockRejectedValue(
        new BoardNotDetectedError({ error: 'board_not_detected' }),
      );
    const cropImage = vi
      .fn<(src: string, area: unknown) => Promise<Blob>>()
      .mockResolvedValue(new Blob([new Uint8Array([4, 5])], { type: 'image/png' }));
    renderWithProviders(
      <BoardImageDropzone
        onAccept={vi.fn()}
        recognizer={recognizer}
        cropImage={cropImage}
      />,
    );
    await userEvent.upload(
      screen.getByTestId('board-image-dropzone-file-input'),
      makeImageFile(),
    );
    await waitFor(() =>
      expect(screen.queryByTestId('board-image-dropzone-crop-frame')).not.toBeNull(),
    );
    await userEvent.click(screen.getByTestId('board-image-dropzone-crop-retry'));
    await waitFor(() => expect(recognizer).toHaveBeenCalledTimes(2));
    // crop UI снова показан после второго 400 — ровно как требует
    // acceptance.
    await waitFor(() =>
      expect(screen.queryByTestId('board-image-dropzone-crop-frame')).not.toBeNull(),
    );
  });

  // KS-3093 hand-off в родительский board-editor.
  it('KS-3093: `onRecognized` вызывается с FEN на 200 — apply кнопка скрыта', async () => {
    const onRecognized = vi.fn();
    const recognizer = vi.fn().mockResolvedValue(RECOGNIZED);
    renderWithProviders(
      <BoardImageDropzone
        onAccept={vi.fn()}
        onRecognized={onRecognized}
        recognizer={recognizer}
      />,
    );
    await userEvent.upload(
      screen.getByTestId('board-image-dropzone-file-input'),
      makeImageFile(),
    );
    await waitFor(() =>
      expect(onRecognized).toHaveBeenCalledWith(RECOGNIZED.fen),
    );
    // Локальный Apply и «Edit FEN manually» не рендерятся — apply
    // делает родительский editor.
    expect(screen.queryByTestId('board-image-dropzone-apply')).toBeNull();
    expect(
      screen.queryByTestId('board-image-dropzone-toggle-manual'),
    ).toBeNull();
  });

  it('KS-3093: `onRecognized` вызывается с fenAttempt и на 422', async () => {
    const onRecognized = vi.fn();
    const payload: BoardRecognitionUnreliablePayload = {
      error: 'recognition_unreliable',
      fenAttempt:
        'r2q1rk1/ppp1b1pp/1nn1pP2/5b2/2PP4/2N1BN2/PP2B1PP/P2Q1RK1 w - - 0 1',
      issues: ['some pawns are on the edge rows'],
    };
    const recognizer = vi
      .fn()
      .mockRejectedValue(new BoardRecognitionUnreliableError(payload));
    renderWithProviders(
      <BoardImageDropzone
        onAccept={vi.fn()}
        onRecognized={onRecognized}
        recognizer={recognizer}
      />,
    );
    await userEvent.upload(
      screen.getByTestId('board-image-dropzone-file-input'),
      makeImageFile(),
    );
    await waitFor(() =>
      expect(onRecognized).toHaveBeenCalledWith(payload.fenAttempt),
    );
  });

  // KS-3093: scenario 2 — 422 без fenAttempt (legacy/edge-case).
  it('KS-3093: 422 без fenAttempt → старое сообщение «recognition failed»', async () => {
    const recognizer = vi.fn().mockRejectedValue(
      new BoardRecognitionUnreliableError({
        error: 'recognition_unreliable',
        message: 'no board detected',
      }),
    );
    renderWithProviders(
      <BoardImageDropzone onAccept={vi.fn()} recognizer={recognizer} />,
    );
    await userEvent.upload(
      screen.getByTestId('board-image-dropzone-file-input'),
      makeImageFile(),
    );
    await waitFor(() => expect(recognizer).toHaveBeenCalled());
    // Старый error-блок — а не плашка sanity-warning.
    await waitFor(() =>
      expect(
        screen.queryByTestId('board-image-dropzone-sanity-warning'),
      ).toBeNull(),
    );
    expect(
      (screen.getByTestId('board-image-dropzone-apply') as HTMLButtonElement).disabled,
    ).toBe(true);
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
