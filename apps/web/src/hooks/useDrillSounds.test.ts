import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useDrillSounds,
  resolveMoveSound,
  getDrillSoundsMuted,
  setDrillSoundsMuted,
} from './useDrillSounds';

/**
 * KS-2423 — useDrillSounds + resolveMoveSound.
 *
 * Делаем мокаем `./useSounds` чтобы не запускать настоящий AudioContext
 * в jsdom (он там не настоящий, но вызывает консольный шум). Проверяем
 * что:
 *  - play() вызывает playSound из useSounds, когда оба mute выключены;
 *  - drill-mute (localStorage) блокирует звук;
 *  - global-mute (`muted` из useSounds) блокирует звук;
 *  - toggleDrillMuted переключает и пишет в localStorage;
 *  - resolveMoveSound правильно классифицирует ходы по chess.js.
 */

const mockPlaySound = vi.fn();
const mockUseSounds = vi.fn(() => ({
  playSound: mockPlaySound,
  muted: false,
  toggleMute: vi.fn(),
  theme: 'standard' as const,
  setTheme: vi.fn(),
}));

vi.mock('./useSounds', async () => {
  const actual = await vi.importActual<typeof import('./useSounds')>(
    './useSounds',
  );
  return {
    ...actual,
    useSounds: () => mockUseSounds(),
  };
});

describe('useDrillSounds (KS-2423)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockPlaySound.mockClear();
    mockUseSounds.mockReturnValue({
      playSound: mockPlaySound,
      muted: false,
      toggleMute: vi.fn(),
      theme: 'standard',
      setTheme: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('play() вызывает playSound, когда оба mute выключены', () => {
    const { result } = renderHook(() => useDrillSounds());
    act(() => result.current.play('move'));
    expect(mockPlaySound).toHaveBeenCalledWith('move');
  });

  it('drill-mute блокирует play()', () => {
    setDrillSoundsMuted(true);
    const { result } = renderHook(() => useDrillSounds());
    expect(result.current.drillMuted).toBe(true);
    act(() => result.current.play('puzzle-correct'));
    expect(mockPlaySound).not.toHaveBeenCalled();
  });

  it('global-mute блокирует play() даже при выключенном drill-mute', () => {
    mockUseSounds.mockReturnValue({
      playSound: mockPlaySound,
      muted: true,
      toggleMute: vi.fn(),
      theme: 'standard',
      setTheme: vi.fn(),
    });
    const { result } = renderHook(() => useDrillSounds());
    expect(result.current.globalMuted).toBe(true);
    act(() => result.current.play('move'));
    expect(mockPlaySound).not.toHaveBeenCalled();
  });

  it('toggleDrillMuted сохраняет факт в localStorage', () => {
    const { result } = renderHook(() => useDrillSounds());
    expect(result.current.drillMuted).toBe(false);
    act(() => result.current.toggleDrillMuted());
    expect(result.current.drillMuted).toBe(true);
    expect(getDrillSoundsMuted()).toBe(true);
    act(() => result.current.toggleDrillMuted());
    expect(result.current.drillMuted).toBe(false);
    expect(getDrillSoundsMuted()).toBe(false);
  });
});

describe('resolveMoveSound (KS-2423)', () => {
  it('обычный ход → "move"', () => {
    expect(
      resolveMoveSound(
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'e2',
        'e4',
      ),
    ).toBe('move');
  });

  it('взятие → "capture"', () => {
    // Стандартная позиция после 1.e4 d5: ход 2.exd5 — взятие.
    expect(
      resolveMoveSound(
        'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
        'e4',
        'd5',
      ),
    ).toBe('capture');
  });

  it('шах → "check"', () => {
    // Чёрный король e8, белый ферзь даёт шах с h5 на e5? Используем
    // простую позицию: 8/8/8/8/8/8/4k3/4K2R w K - 0 1, ход Rh1-h2 не шах,
    // а ход Rh1-e1 — ходим, шаха нет. Возьмём другую: Qg5+.
    expect(
      resolveMoveSound(
        '4k3/8/8/6Q1/8/8/8/4K3 w - - 0 1',
        'g5',
        'e5',
      ),
    ).toBe('check');
  });

  it('рокировка → "castle"', () => {
    expect(
      resolveMoveSound(
        '4k3/8/8/8/8/8/8/4K2R w K - 0 1',
        'e1',
        'g1',
      ),
    ).toBe('castle');
  });

  it('невалидный ход → "move" (fallback)', () => {
    expect(
      resolveMoveSound(
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'a1',
        'h8',
      ),
    ).toBe('move');
  });
});
