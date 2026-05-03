import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  buildShareUrl,
  canvasToBlob,
  renderSprintResultCanvas,
  useShareSprintResult,
  type SprintShareInput,
  type ShareTexts,
} from './useShareSprintResult';

// happy-dom не реализует canvas — стабим getContext, toBlob.
function makeMockCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ctxStub = {
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    fillStyle: '',
    font: '',
    textBaseline: '',
    textAlign: '',
  };
  // @ts-expect-error: mock-объект, упрощённый.
  canvas.getContext = vi.fn(() => ctxStub);
  // toBlob → симулируем Blob с непустым размером.
  // @ts-expect-error: mock-метод.
  canvas.toBlob = vi.fn((cb: BlobCallback) => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/png' });
    setTimeout(() => cb(blob), 0);
  });
  return canvas;
}

const DATA: SprintShareInput = {
  score: 18,
  accuracy: 0.75,
  durationLabel: '3 мин',
  setLabel: 'Все 8 типов',
};

const TEXTS: ShareTexts = {
  title: 'Мой результат',
  text: 'Решил 18 упражнений с точностью 75%',
  fileName: 'kingside-sprint-result.png',
};

describe('buildShareUrl — KS-2251', () => {
  it('добавляет UTM-метки к /drills/sprint', () => {
    const url = buildShareUrl('https://kingside.site');
    expect(url).toBe(
      'https://kingside.site/drills/sprint?utm_source=share&utm_medium=sprint-result&utm_campaign=drills',
    );
  });

  it('убирает trailing slash из origin', () => {
    expect(buildShareUrl('https://kingside.site/')).toContain(
      'https://kingside.site/drills/sprint?utm_source=share',
    );
  });
});

describe('renderSprintResultCanvas — KS-2251', () => {
  it('возвращает true и устанавливает 1200×630, вызывает fillText для score/accuracy/brand', () => {
    const canvas = makeMockCanvas();
    const ok = renderSprintResultCanvas(canvas, DATA);
    expect(ok).toBe(true);
    expect(canvas.width).toBe(1200);
    expect(canvas.height).toBe(630);
    const ctx = canvas.getContext('2d') as unknown as { fillText: ReturnType<typeof vi.fn> };
    // Несколько fillText: brand, sub, score, accuracy, meta, cta.
    expect(ctx.fillText).toHaveBeenCalled();
    const calls = ctx.fillText.mock.calls.map((c) => String(c[0]));
    expect(calls).toContain('Kingside');
    expect(calls).toContain('18');
    expect(calls.some((s) => s.includes('75%'))).toBe(true);
  });

  it('getContext===null → возвращает false', () => {
    const canvas = document.createElement('canvas');
    // @ts-expect-error: stubим возврат null.
    canvas.getContext = vi.fn(() => null);
    expect(renderSprintResultCanvas(canvas, DATA)).toBe(false);
  });
});

describe('canvasToBlob — KS-2251', () => {
  it('возвращает Blob > 0 байт', async () => {
    const canvas = makeMockCanvas();
    const blob = await canvasToBlob(canvas);
    expect(blob).not.toBeNull();
    expect(blob!.size).toBeGreaterThan(0);
    expect(blob!.type).toBe('image/png');
  });

  it('canvas без toBlob → null', async () => {
    const canvas = document.createElement('canvas');
    // @ts-expect-error: убираем toBlob.
    canvas.toBlob = undefined;
    const blob = await canvasToBlob(canvas);
    expect(blob).toBeNull();
  });
});

describe('useShareSprintResult — KS-2251', () => {
  let originalShare: typeof navigator.share | undefined;
  let originalCanShare: typeof navigator.canShare | undefined;
  let originalClipboard: typeof navigator.clipboard | undefined;

  beforeEach(() => {
    // Сохраняем для restore.
    originalShare = navigator.share;
    originalCanShare = navigator.canShare;
    originalClipboard = navigator.clipboard;
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'share', {
      value: originalShare,
      configurable: true,
    });
    Object.defineProperty(navigator, 'canShare', {
      value: originalCanShare,
      configurable: true,
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it('по умолчанию status="idle"', () => {
    const { result } = renderHook(() => useShareSprintResult());
    expect(result.current.status).toBe('idle');
  });

  it('navigator.share + canShare(files)=true → status=shared, share вызван с files', async () => {
    const shareMock = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'share', { value: shareMock, configurable: true });
    Object.defineProperty(navigator, 'canShare', {
      value: () => true,
      configurable: true,
    });
    const { result } = renderHook(() => useShareSprintResult());
    await act(async () => {
      await result.current.share({
        data: DATA,
        texts: TEXTS,
        canvas: makeMockCanvas(),
        origin: 'https://kingside.site',
      });
    });
    await waitFor(() => expect(result.current.status).toBe('shared'));
    expect(shareMock).toHaveBeenCalledTimes(1);
    const args = shareMock.mock.calls[0][0] as ShareData;
    expect(args.url).toContain('utm_source=share');
    expect(args.url).toContain('utm_medium=sprint-result');
    expect(args.url).toContain('utm_campaign=drills');
    expect(args.title).toBe(TEXTS.title);
    expect((args as { files?: File[] }).files).toBeDefined();
  });

  it('navigator.share выбросил → fallback download + clipboard → status=copied', async () => {
    const shareMock = vi.fn(async () => {
      throw new Error('AbortError');
    });
    const writeTextMock = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'share', { value: shareMock, configurable: true });
    Object.defineProperty(navigator, 'canShare', {
      value: () => true,
      configurable: true,
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
    });
    // URL.createObjectURL / revokeObjectURL — стаб.
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = vi.fn();
    try {
      const { result } = renderHook(() => useShareSprintResult());
      await act(async () => {
        await result.current.share({
          data: DATA,
          texts: TEXTS,
          canvas: makeMockCanvas(),
          origin: 'https://kingside.site',
        });
      });
      await waitFor(() => expect(result.current.status).toBe('copied'));
      expect(writeTextMock).toHaveBeenCalledTimes(1);
      const copiedText = writeTextMock.mock.calls[0][0] as string;
      expect(copiedText).toContain('utm_source=share');
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  it('нет navigator.share → fallback download, status=copied (если clipboard работает)', async () => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'canShare', {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => undefined) },
      configurable: true,
    });
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    try {
      const { result } = renderHook(() => useShareSprintResult());
      await act(async () => {
        await result.current.share({
          data: DATA,
          texts: TEXTS,
          canvas: makeMockCanvas(),
        });
      });
      await waitFor(() => expect(result.current.status).toBe('copied'));
    } finally {
      URL.createObjectURL = origCreate;
    }
  });

  it('reset() возвращает status в idle', async () => {
    const { result } = renderHook(() => useShareSprintResult());
    await act(async () => {
      await result.current.share({
        data: DATA,
        texts: TEXTS,
        canvas: makeMockCanvas(),
        origin: 'https://kingside.site',
      });
    });
    act(() => result.current.reset());
    expect(result.current.status).toBe('idle');
  });
});
