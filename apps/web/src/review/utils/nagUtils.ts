const NAG_TO_SYMBOL: Record<number, string> = {
  1: '!',
  2: '?',
  3: '!!',
  4: '??',
  5: '!?',
  6: '?!',
  7: '□',
  10: '=',
  13: '∞',
  14: '⩲',
  15: '⩱',
  16: '±',
  17: '∓',
  18: '+−',
  19: '−+',
};

const SYMBOL_TO_NAG: Record<string, number> = {};
for (const [nag, sym] of Object.entries(NAG_TO_SYMBOL)) {
  SYMBOL_TO_NAG[sym] = Number(nag);
}

export function nagToSymbol(nag: number): string {
  return NAG_TO_SYMBOL[nag] ?? `$${nag}`;
}

export function symbolToNag(symbol: string): number {
  const nag = SYMBOL_TO_NAG[symbol];
  if (nag !== undefined) return nag;

  // Handle $N format
  const match = symbol.match(/^\$(\d+)$/);
  if (match) return parseInt(match[1], 10);

  return -1;
}
