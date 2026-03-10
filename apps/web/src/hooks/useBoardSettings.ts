import { useState, useCallback } from 'react';

const SHOW_NOTATION_KEY = 'showNotation';

function readShowNotation(): boolean {
  const stored = localStorage.getItem(SHOW_NOTATION_KEY);
  if (stored === null) return true;
  return stored === 'true';
}

export function useBoardSettings() {
  const [showNotation, setShowNotationState] = useState<boolean>(readShowNotation);

  const setShowNotation = useCallback((value: boolean) => {
    localStorage.setItem(SHOW_NOTATION_KEY, String(value));
    setShowNotationState(value);
  }, []);

  return { showNotation, setShowNotation };
}
