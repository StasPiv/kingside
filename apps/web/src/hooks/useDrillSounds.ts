import { useCallback, useEffect, useState } from 'react';
import { Chess, type Square as ChessSquare } from 'chess.js';
import { useSounds, type SoundEvent } from './useSounds';

/**
 * KS-2423 — звуки в тренажёрах.
 *
 * Тонкая обёртка над `useSounds()`:
 *  - использует существующий `playSound` (web-audio synth, тема + global mute);
 *  - добавляет drill-специфичный mute (`drills.soundsMuted` в localStorage),
 *    чтобы пользователь мог отключить ТОЛЬКО звуки тренажёров, не трогая
 *    звуки игры. По умолчанию drill-звуки включены.
 *
 * Если глобальный mute (`useSounds.muted`) выключен — drill-звуки тоже
 * молчат: глобальный — приоритетный.
 *
 * # Ивенты
 *
 *   - `select`           — выбор клетки / pickup (тихий клик)
 *   - `move` / `capture` — коммит хода (capture определяется через chess.js
 *                          по handler `resolveMoveSound(fen, from, to)`)
 *   - `puzzle-correct`   — правильный ответ на drill
 *   - `puzzle-incorrect` — неверный ответ
 *   - `game-end`         — финал sprint'а / завершение find-all-checks
 *
 * Все события идут через тот же `playSound` из useSounds — никаких
 * новых web-audio контекстов / ассетов.
 */

const DRILL_SOUNDS_MUTED_KEY = 'drills.soundsMuted';
const DRILL_SOUNDS_MUTED_EVENT = 'kingside:drill-sounds-muted-change';

function readDrillMuted(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(DRILL_SOUNDS_MUTED_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeDrillMuted(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DRILL_SOUNDS_MUTED_KEY, String(value));
  } catch {
    /* ignore */
  }
  // Custom-event для синхронизации между компонентами в текущей вкладке
  // (storage event сам не доходит до инициирующей вкладки).
  window.dispatchEvent(new Event(DRILL_SOUNDS_MUTED_EVENT));
}

/**
 * Определяет нужный SoundEvent ('move' / 'capture' / 'check' / 'castle')
 * для конкретного хода в позиции FEN. Если ход невалиден или произошла
 * ошибка парсинга — возвращает 'move' как безопасный fallback.
 */
export function resolveMoveSound(
  fen: string,
  from: string,
  to: string,
): SoundEvent {
  try {
    const c = new Chess(fen);
    const m = c.move({
      from: from as ChessSquare,
      to: to as ChessSquare,
      promotion: 'q',
    });
    if (!m) return 'move';
    if (m.flags.includes('k') || m.flags.includes('q')) return 'castle';
    if (m.san.includes('+') || m.san.includes('#')) return 'check';
    if (m.flags.includes('c') || m.flags.includes('e')) return 'capture';
    return 'move';
  } catch {
    return 'move';
  }
}

export interface UseDrillSoundsReturn {
  /** Сыграть drill-событие через web-audio. No-op если global или drill mute. */
  play: (event: SoundEvent) => void;
  /** Локальный (drill-only) mute-флаг. */
  drillMuted: boolean;
  /** Глобальный mute-флаг (из useSounds). */
  globalMuted: boolean;
  /** Переключить drill-mute (сохраняется в localStorage). */
  toggleDrillMuted: () => void;
}

export function useDrillSounds(): UseDrillSoundsReturn {
  const { playSound, muted: globalMuted } = useSounds();
  const [drillMuted, setDrillMuted] = useState<boolean>(() => readDrillMuted());

  // Подписка на смену drill-mute из других компонентов (например,
  // SettingsPage переключил toggle, пока drill открыт в другом окне).
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onChange = () => setDrillMuted(readDrillMuted());
    const onStorage = (e: StorageEvent) => {
      if (e.key === DRILL_SOUNDS_MUTED_KEY) setDrillMuted(readDrillMuted());
    };
    window.addEventListener(DRILL_SOUNDS_MUTED_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(DRILL_SOUNDS_MUTED_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const play = useCallback(
    (event: SoundEvent) => {
      if (drillMuted) return;
      // playSound уже сам уважает globalMuted, но проверяем явно — на
      // случай если в будущем появятся drill-звуки, которые игнорируют
      // global (по аналогии с previewSound).
      if (globalMuted) return;
      playSound(event);
    },
    [drillMuted, globalMuted, playSound],
  );

  const toggleDrillMuted = useCallback(() => {
    setDrillMuted((prev) => {
      const next = !prev;
      writeDrillMuted(next);
      return next;
    });
  }, []);

  return { play, drillMuted, globalMuted, toggleDrillMuted };
}

/** Публичные хелперы для UI настроек (без хука). */
export function getDrillSoundsMuted(): boolean {
  return readDrillMuted();
}

export function setDrillSoundsMuted(value: boolean): void {
  writeDrillMuted(value);
}
