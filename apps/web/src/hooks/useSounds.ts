import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * KS-2172: Звуковые темы.
 *
 * Все темы синтезируются через WebAudio — никаких внешних mp3/ogg/wav
 * ассетов не используется. Это:
 *  - юридически чище CC-BY/CC0 файлов: код собственный, attribution не
 *    требуется, гарантированно нет случайного совпадения с
 *    проприетарными сэмплами (ChessBase / lichess / chess.com);
 *  - размер ассетов = 0 байт, нет latency на первый звук;
 *  - работает offline.
 *
 * Если в будущем понадобятся «настоящие» сэмплы (запись деревянного
 * стука и т.п.) — отдельный тикет: положить файлы в
 * `apps/web/public/sounds/<theme>/<event>.ogg` + LICENSE.txt и научить
 * тему ходить через HTMLAudio. Вся внешняя сторона хука уже к этому готова.
 */

export type SoundEvent =
  | 'move'
  | 'capture'
  | 'check'
  | 'castle'
  | 'game-start'
  | 'game-end'
  | 'puzzle-correct'
  | 'puzzle-incorrect'
  | 'puzzle-gameover'
  // KS-2423: тихий короткий «click» при выборе клетки/подъёме фигуры
  // в тренажёрах. Должен быть НАМНОГО тише чем move/capture, иначе на
  // shape='squares' (где набирается несколько кликов подряд) утомляет.
  | 'select';

export type SoundTheme = 'standard' | 'wood' | 'minimal' | 'eightbit';

export const SOUND_THEMES: ReadonlyArray<{ id: SoundTheme; nameKey: string; nameRu: string; nameEn: string }> = [
  { id: 'standard', nameKey: 'settings.soundTheme.standard', nameRu: 'Стандарт', nameEn: 'Standard' },
  { id: 'wood', nameKey: 'settings.soundTheme.wood', nameRu: 'Деревянная доска', nameEn: 'Wooden board' },
  { id: 'minimal', nameKey: 'settings.soundTheme.minimal', nameRu: 'Минимализм', nameEn: 'Minimal' },
  { id: 'eightbit', nameKey: 'settings.soundTheme.eightbit', nameRu: 'Ретро 8-bit', nameEn: 'Retro 8-bit' },
];

const SOUND_MUTED_KEY = 'soundMuted';
const SOUND_THEME_KEY = 'kingside.soundTheme';
const SOUND_THEME_EVENT = 'kingside:sound-theme-change';

const DEFAULT_THEME: SoundTheme = 'standard';

function readTheme(): SoundTheme {
  try {
    const v = localStorage.getItem(SOUND_THEME_KEY);
    if (v && SOUND_THEMES.some((t) => t.id === v)) return v as SoundTheme;
  } catch {
    /* ignore */
  }
  return DEFAULT_THEME;
}

function writeTheme(theme: SoundTheme): void {
  try {
    localStorage.setItem(SOUND_THEME_KEY, theme);
  } catch {
    /* ignore */
  }
  // Сообщаем всем useSounds в текущей вкладке (storage event сам не
  // ловится в инициирующей вкладке).
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(SOUND_THEME_EVENT));
  }
}

function getAudioContext(): AudioContext | null {
  try {
    return new AudioContext();
  } catch {
    return null;
  }
}

function playTone(
  ctx: AudioContext,
  frequency: number,
  duration: number,
  startTime: number,
  type: OscillatorType = 'sine',
  gainPeak = 0.4,
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, startTime);
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

/** KS-2172: короткий шумовой "стук" — для имитации удара дерева/пластика. */
function playNoise(
  ctx: AudioContext,
  duration: number,
  startTime: number,
  gainPeak = 0.3,
  filterFreq = 2000,
): void {
  const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  }
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = filterFreq;
  src.buffer = buffer;
  src.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(gainPeak, startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  src.start(startTime);
  src.stop(startTime + duration);
}

// =============================================================================
// Тема "standard" — текущий synthetic, как был до KS-2172. Это default.
// =============================================================================
const standardTheme: Record<SoundEvent, (ctx: AudioContext) => void> = {
  move: (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 900, 0.08, t, 'square', 0.15);
    playTone(ctx, 450, 0.12, t, 'triangle', 0.25);
  },
  capture: (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 600, 0.05, t, 'square', 0.2);
    playTone(ctx, 300, 0.18, t, 'triangle', 0.3);
    playTone(ctx, 150, 0.25, t + 0.04, 'sine', 0.15);
  },
  check: (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 1200, 0.1, t, 'sine', 0.3);
    playTone(ctx, 1000, 0.1, t + 0.15, 'sine', 0.25);
  },
  castle: (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 800, 0.08, t, 'square', 0.15);
    playTone(ctx, 400, 0.1, t, 'triangle', 0.2);
    playTone(ctx, 900, 0.08, t + 0.18, 'square', 0.12);
    playTone(ctx, 450, 0.1, t + 0.18, 'triangle', 0.18);
  },
  'game-start': (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 392, 0.12, t, 'sine', 0.3);
    playTone(ctx, 523, 0.2, t + 0.12, 'sine', 0.35);
  },
  'game-end': (ctx) => {
    const t = ctx.currentTime;
    [523, 659, 784, 1047].forEach((freq, i) => {
      playTone(ctx, freq, 0.35, t + i * 0.22, 'sine', 0.35);
    });
  },
  'puzzle-correct': (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 523, 0.18, t, 'sine', 0.3);
    playTone(ctx, 659, 0.18, t + 0.1, 'sine', 0.35);
    playTone(ctx, 784, 0.18, t + 0.2, 'sine', 0.35);
    playTone(ctx, 1047, 0.4, t + 0.3, 'sine', 0.4);
    playTone(ctx, 2094, 0.3, t + 0.32, 'sine', 0.1);
  },
  'puzzle-incorrect': (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 330, 0.25, t, 'triangle', 0.3);
    playTone(ctx, 311, 0.25, t + 0.18, 'triangle', 0.25);
    playTone(ctx, 262, 0.45, t + 0.36, 'triangle', 0.2);
    playTone(ctx, 131, 0.5, t + 0.1, 'sine', 0.15);
  },
  'puzzle-gameover': (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 262, 0.3, t, 'triangle', 0.35);
    playTone(ctx, 208, 0.3, t + 0.2, 'triangle', 0.3);
    playTone(ctx, 175, 0.3, t + 0.4, 'triangle', 0.25);
    playTone(ctx, 139, 0.6, t + 0.6, 'triangle', 0.2);
    playTone(ctx, 65, 0.9, t + 0.2, 'sine', 0.2);
    playTone(ctx, 147, 0.5, t + 0.6, 'square', 0.08);
  },
  select: (ctx) => {
    // Очень тихий короткий клик — для подсветки выбора клетки.
    const t = ctx.currentTime;
    playTone(ctx, 1200, 0.025, t, 'sine', 0.05);
  },
};

// =============================================================================
// Тема "wood" — короткий шумовой "стук" + низкая компонента, имитирует
// удар дерева о доску.
// =============================================================================
const woodTheme: Record<SoundEvent, (ctx: AudioContext) => void> = {
  move: (ctx) => {
    const t = ctx.currentTime;
    playNoise(ctx, 0.05, t, 0.4, 1800);
    playTone(ctx, 180, 0.08, t, 'triangle', 0.35);
  },
  capture: (ctx) => {
    const t = ctx.currentTime;
    // Двойной удар: тише первый, громче второй
    playNoise(ctx, 0.04, t, 0.25, 1500);
    playTone(ctx, 160, 0.06, t, 'triangle', 0.2);
    playNoise(ctx, 0.07, t + 0.04, 0.5, 1200);
    playTone(ctx, 110, 0.12, t + 0.04, 'triangle', 0.4);
  },
  check: (ctx) => {
    const t = ctx.currentTime;
    playNoise(ctx, 0.04, t, 0.3, 2000);
    playTone(ctx, 180, 0.08, t, 'triangle', 0.3);
    // Высокий "колокольчик" поверх удара
    playTone(ctx, 1480, 0.4, t + 0.02, 'sine', 0.18);
    playTone(ctx, 2960, 0.25, t + 0.02, 'sine', 0.06);
  },
  castle: (ctx) => {
    const t = ctx.currentTime;
    // Два удара — король и ладья
    playNoise(ctx, 0.05, t, 0.35, 1700);
    playTone(ctx, 175, 0.08, t, 'triangle', 0.3);
    playNoise(ctx, 0.05, t + 0.18, 0.35, 1700);
    playTone(ctx, 175, 0.08, t + 0.18, 'triangle', 0.3);
  },
  'game-start': (ctx) => {
    const t = ctx.currentTime;
    playNoise(ctx, 0.04, t, 0.25, 1800);
    playTone(ctx, 220, 0.1, t, 'triangle', 0.3);
    playTone(ctx, 330, 0.14, t + 0.1, 'sine', 0.3);
  },
  'game-end': (ctx) => {
    const t = ctx.currentTime;
    [220, 175, 147, 110].forEach((freq, i) => {
      playTone(ctx, freq, 0.3, t + i * 0.18, 'triangle', 0.32);
    });
  },
  'puzzle-correct': (ctx) => {
    const t = ctx.currentTime;
    [262, 330, 392, 523].forEach((freq, i) => {
      playTone(ctx, freq, 0.18, t + i * 0.1, 'triangle', 0.3);
    });
  },
  'puzzle-incorrect': (ctx) => {
    const t = ctx.currentTime;
    playNoise(ctx, 0.08, t, 0.35, 1000);
    playTone(ctx, 120, 0.3, t, 'triangle', 0.35);
    playTone(ctx, 90, 0.4, t + 0.15, 'triangle', 0.25);
  },
  'puzzle-gameover': (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 175, 0.3, t, 'triangle', 0.3);
    playTone(ctx, 147, 0.3, t + 0.25, 'triangle', 0.3);
    playTone(ctx, 110, 0.5, t + 0.5, 'triangle', 0.3);
  },
  select: (ctx) => {
    const t = ctx.currentTime;
    // Деревянный тихий тук без полного удара.
    playNoise(ctx, 0.02, t, 0.1, 1500);
    playTone(ctx, 220, 0.025, t, 'triangle', 0.1);
  },
};

// =============================================================================
// Тема "minimal" — очень тихие, короткие щелчки. Для тех, кого «standard»
// раздражает.
// =============================================================================
const minimalTheme: Record<SoundEvent, (ctx: AudioContext) => void> = {
  move: (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 660, 0.04, t, 'sine', 0.12);
  },
  capture: (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 440, 0.05, t, 'sine', 0.16);
  },
  check: (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 880, 0.06, t, 'sine', 0.14);
    playTone(ctx, 1320, 0.06, t + 0.08, 'sine', 0.1);
  },
  castle: (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 660, 0.04, t, 'sine', 0.12);
    playTone(ctx, 660, 0.04, t + 0.1, 'sine', 0.12);
  },
  'game-start': (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 523, 0.1, t, 'sine', 0.15);
    playTone(ctx, 784, 0.12, t + 0.1, 'sine', 0.15);
  },
  'game-end': (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 784, 0.12, t, 'sine', 0.15);
    playTone(ctx, 523, 0.12, t + 0.12, 'sine', 0.15);
    playTone(ctx, 392, 0.18, t + 0.24, 'sine', 0.13);
  },
  'puzzle-correct': (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 660, 0.06, t, 'sine', 0.14);
    playTone(ctx, 880, 0.1, t + 0.08, 'sine', 0.16);
  },
  'puzzle-incorrect': (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 330, 0.12, t, 'sine', 0.14);
  },
  'puzzle-gameover': (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 262, 0.15, t, 'sine', 0.14);
    playTone(ctx, 208, 0.2, t + 0.18, 'sine', 0.13);
  },
  select: (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 1500, 0.02, t, 'sine', 0.04);
  },
};

// =============================================================================
// Тема "eightbit" — square waves, pitch-перепады, ретро-видеоигра.
// =============================================================================
const eightbitTheme: Record<SoundEvent, (ctx: AudioContext) => void> = {
  move: (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 220, 0.04, t, 'square', 0.18);
    playTone(ctx, 440, 0.04, t + 0.04, 'square', 0.18);
  },
  capture: (ctx) => {
    const t = ctx.currentTime;
    // Sweep от высокой к низкой — square wave
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(110, t + 0.18);
    gain.gain.setValueAtTime(0.22, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.start(t);
    osc.stop(t + 0.2);
  },
  check: (ctx) => {
    const t = ctx.currentTime;
    // Тревожный «бип-бип-бип»
    [880, 880, 880].forEach((freq, i) => {
      playTone(ctx, freq, 0.06, t + i * 0.1, 'square', 0.18);
    });
  },
  castle: (ctx) => {
    const t = ctx.currentTime;
    [220, 330, 440, 550].forEach((freq, i) => {
      playTone(ctx, freq, 0.05, t + i * 0.05, 'square', 0.18);
    });
  },
  'game-start': (ctx) => {
    const t = ctx.currentTime;
    [262, 330, 392, 523].forEach((freq, i) => {
      playTone(ctx, freq, 0.08, t + i * 0.08, 'square', 0.2);
    });
  },
  'game-end': (ctx) => {
    const t = ctx.currentTime;
    // Финальный мажорный аккорд
    [523, 659, 784, 1047].forEach((freq, i) => {
      playTone(ctx, freq, 0.28, t + i * 0.12, 'square', 0.18);
    });
  },
  'puzzle-correct': (ctx) => {
    const t = ctx.currentTime;
    [523, 659, 784, 1047].forEach((freq, i) => {
      playTone(ctx, freq, 0.08, t + i * 0.07, 'square', 0.2);
    });
  },
  'puzzle-incorrect': (ctx) => {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'square';
    osc.frequency.setValueAtTime(330, t);
    osc.frequency.exponentialRampToValueAtTime(110, t + 0.3);
    gain.gain.setValueAtTime(0.22, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
    osc.start(t);
    osc.stop(t + 0.32);
  },
  'puzzle-gameover': (ctx) => {
    const t = ctx.currentTime;
    [262, 220, 175, 130].forEach((freq, i) => {
      playTone(ctx, freq, 0.18, t + i * 0.16, 'square', 0.2);
    });
  },
  select: (ctx) => {
    const t = ctx.currentTime;
    playTone(ctx, 880, 0.025, t, 'square', 0.08);
  },
};

const THEMES: Record<SoundTheme, Record<SoundEvent, (ctx: AudioContext) => void>> = {
  standard: standardTheme,
  wood: woodTheme,
  minimal: minimalTheme,
  eightbit: eightbitTheme,
};

/**
 * KS-2172: Чтение/запись звуковой темы — публичные хелперы для UI настроек.
 */
export function getSoundTheme(): SoundTheme {
  return readTheme();
}

export function setSoundTheme(theme: SoundTheme): void {
  writeTheme(theme);
}

/**
 * KS-2172: Воспроизвести `event` ОДНОЙ КОНКРЕТНОЙ темой — для preview-кнопки
 * в настройках. Игнорирует mute (специально, чтобы пользователь мог
 * прослушать тему даже при включённом mute).
 */
export function previewSound(theme: SoundTheme, event: SoundEvent = 'move'): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => undefined);
  }
  const handler = THEMES[theme]?.[event];
  if (handler) handler(ctx);
  // Закрываем context через 2 секунды, чтобы не плодить их.
  setTimeout(() => {
    ctx.close().catch(() => undefined);
  }, 2000);
}

export function useSounds() {
  const ctxRef = useRef<AudioContext | null>(null);
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem(SOUND_MUTED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [theme, setTheme] = useState<SoundTheme>(() => readTheme());

  // KS-2172: подписываемся на смену темы — и для текущей вкладки
  // (custom event), и для других вкладок (storage event).
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onThemeChange = () => setTheme(readTheme());
    const onStorage = (e: StorageEvent) => {
      if (e.key === SOUND_THEME_KEY) setTheme(readTheme());
      if (e.key === SOUND_MUTED_KEY) {
        try {
          setMuted(localStorage.getItem(SOUND_MUTED_KEY) === 'true');
        } catch {
          /* ignore */
        }
      }
    };
    window.addEventListener(SOUND_THEME_EVENT, onThemeChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SOUND_THEME_EVENT, onThemeChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const ensureContext = useCallback((): AudioContext | null => {
    if (!ctxRef.current) {
      ctxRef.current = getAudioContext();
    }
    const ctx = ctxRef.current;
    if (!ctx) return null;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => undefined);
    }
    return ctx;
  }, []);

  // KS-2702: autoplay policy. Если первое срабатывание `playSound`
  // приходит не из user-gesture (например, по WebSocket-сообщению от
  // backend'а на странице, куда юзер только что зашёл и пока не
  // взаимодействовал) — браузер не разрешит воспроизведение даже после
  // `ctx.resume()`. Регистрируем one-time listener на любой
  // pointer/key/touch-event и насильно «прогреваем» AudioContext в
  // user-gesture handler'e — после этого все последующие playSound'ы
  // (хоть из таймера, хоть из WS) уже срабатывают штатно. Idempotent:
  // если ctx уже running — listener просто снимется без эффекта.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const unlock = () => {
      const ctx = ensureContext();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
      if (!ctx) return;
      // resume() возвращает promise; ошибки нам не интересны — следующий
      // playSound разбудит контекст ещё раз через тот же путь.
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => undefined);
      }
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    window.addEventListener('touchstart', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };
  }, [ensureContext]);

  const playSound = useCallback(
    (event: SoundEvent) => {
      if (muted) return;
      const ctx = ensureContext();
      if (!ctx) return;
      const handler = THEMES[theme]?.[event];
      if (handler) handler(ctx);
    },
    [muted, ensureContext, theme],
  );

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SOUND_MUTED_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const changeTheme = useCallback((next: SoundTheme) => {
    setTheme(next);
    writeTheme(next);
  }, []);

  return { playSound, muted, toggleMute, theme, setTheme: changeTheme };
}

/** Определяет тип звука по SAN нотации хода */
export function soundEventFromSan(san: string): SoundEvent {
  if (san.startsWith('O-O')) return 'castle';
  if (san.includes('+') || san.includes('#')) return 'check';
  if (san.includes('x')) return 'capture';
  return 'move';
}
