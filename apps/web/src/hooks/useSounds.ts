import { useCallback } from 'react';

type SoundType = 'move' | 'capture' | 'check' | 'castle' | 'game-end' | 'game-start';

export function useSounds(soundEnabled: boolean) {
  const play = useCallback(
    (type: SoundType) => {
      if (!soundEnabled) return;
      new Audio(`/sounds/${type}.mp3`).play().catch(() => {});
    },
    [soundEnabled],
  );

  return { play };
}

export function getSoundTypeFromSan(san: string): SoundType {
  if (san.includes('x')) return 'capture';
  if (san.startsWith('O-O')) return 'castle';
  if (san.includes('+') || san.includes('#')) return 'check';
  return 'move';
}
