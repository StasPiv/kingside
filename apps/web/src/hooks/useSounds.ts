import { useCallback, useRef, useState } from 'react';

export type SoundEvent = 'move' | 'capture' | 'check' | 'castle' | 'game-end' | 'puzzle-correct' | 'puzzle-incorrect' | 'puzzle-gameover';

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

function playMove(ctx: AudioContext): void {
  const t = ctx.currentTime;
  // Деревянный стук: короткий широкополосный шум + низкая частота
  playTone(ctx, 900, 0.08, t, 'square', 0.15);
  playTone(ctx, 450, 0.12, t, 'triangle', 0.25);
}

function playCapture(ctx: AudioContext): void {
  const t = ctx.currentTime;
  playTone(ctx, 600, 0.05, t, 'square', 0.2);
  playTone(ctx, 300, 0.18, t, 'triangle', 0.3);
  playTone(ctx, 150, 0.25, t + 0.04, 'sine', 0.15);
}

function playCheck(ctx: AudioContext): void {
  const t = ctx.currentTime;
  playTone(ctx, 1200, 0.1, t, 'sine', 0.3);
  playTone(ctx, 1000, 0.1, t + 0.15, 'sine', 0.25);
}

function playCastle(ctx: AudioContext): void {
  const t = ctx.currentTime;
  playTone(ctx, 800, 0.08, t, 'square', 0.15);
  playTone(ctx, 400, 0.1, t, 'triangle', 0.2);
  playTone(ctx, 900, 0.08, t + 0.18, 'square', 0.12);
  playTone(ctx, 450, 0.1, t + 0.18, 'triangle', 0.18);
}

function playGameEnd(ctx: AudioContext): void {
  const t = ctx.currentTime;
  const notes = [523, 659, 784, 1047]; // C5 E5 G5 C6
  notes.forEach((freq, i) => {
    playTone(ctx, freq, 0.35, t + i * 0.22, 'sine', 0.35);
  });
}

function playPuzzleCorrect(ctx: AudioContext): void {
  const t = ctx.currentTime;
  // Triumphant rising arpeggio: C5 → E5 → G5 → C6 (major chord, bright)
  playTone(ctx, 523, 0.18, t, 'sine', 0.3);
  playTone(ctx, 659, 0.18, t + 0.1, 'sine', 0.35);
  playTone(ctx, 784, 0.18, t + 0.2, 'sine', 0.35);
  playTone(ctx, 1047, 0.4, t + 0.3, 'sine', 0.4);
  // Add shimmer overtone on final note
  playTone(ctx, 2094, 0.3, t + 0.32, 'sine', 0.1);
}

function playPuzzleIncorrect(ctx: AudioContext): void {
  const t = ctx.currentTime;
  // Sad descending minor: E4 → Eb4 → C4, with heavy tone
  playTone(ctx, 330, 0.25, t, 'triangle', 0.3);
  playTone(ctx, 311, 0.25, t + 0.18, 'triangle', 0.25);
  playTone(ctx, 262, 0.45, t + 0.36, 'triangle', 0.2);
  // Low rumble underneath
  playTone(ctx, 131, 0.5, t + 0.1, 'sine', 0.15);
}

function playPuzzleGameover(ctx: AudioContext): void {
  const t = ctx.currentTime;
  // Dramatic descending: C4 → Ab3 → F3 → Db3 (diminished, tragic)
  playTone(ctx, 262, 0.3, t, 'triangle', 0.35);
  playTone(ctx, 208, 0.3, t + 0.2, 'triangle', 0.3);
  playTone(ctx, 175, 0.3, t + 0.4, 'triangle', 0.25);
  playTone(ctx, 139, 0.6, t + 0.6, 'triangle', 0.2);
  // Deep rumble
  playTone(ctx, 65, 0.9, t + 0.2, 'sine', 0.2);
  // Dissonant overtone
  playTone(ctx, 147, 0.5, t + 0.6, 'square', 0.08);
}

const SOUND_MUTED_KEY = 'soundMuted';

export function useSounds() {
  const ctxRef = useRef<AudioContext | null>(null);
  const [muted, setMuted] = useState(() => {
    try {
      return localStorage.getItem(SOUND_MUTED_KEY) === 'true';
    } catch {
      return false;
    }
  });

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

  const playSound = useCallback(
    (event: SoundEvent) => {
      if (muted) return;
      const ctx = ensureContext();
      if (!ctx) return;

      switch (event) {
        case 'move':
          playMove(ctx);
          break;
        case 'capture':
          playCapture(ctx);
          break;
        case 'check':
          playCheck(ctx);
          break;
        case 'castle':
          playCastle(ctx);
          break;
        case 'game-end':
          playGameEnd(ctx);
          break;
        case 'puzzle-correct':
          playPuzzleCorrect(ctx);
          break;
        case 'puzzle-incorrect':
          playPuzzleIncorrect(ctx);
          break;
        case 'puzzle-gameover':
          playPuzzleGameover(ctx);
          break;
      }
    },
    [muted, ensureContext],
  );

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SOUND_MUTED_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return { playSound, muted, toggleMute };
}

/** Определяет тип звука по SAN нотации хода */
export function soundEventFromSan(san: string): SoundEvent {
  if (san.startsWith('O-O')) return 'castle';
  if (san.includes('+') || san.includes('#')) return 'check';
  if (san.includes('x')) return 'capture';
  return 'move';
}
