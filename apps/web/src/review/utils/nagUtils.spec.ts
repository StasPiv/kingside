import { describe, it, expect } from 'vitest';
import { nagToSymbol, symbolToNag } from './nagUtils';

describe('nagToSymbol', () => {
  it('maps known NAG codes to symbols', () => {
    expect(nagToSymbol(1)).toBe('!');
    expect(nagToSymbol(2)).toBe('?');
    expect(nagToSymbol(3)).toBe('!!');
    expect(nagToSymbol(4)).toBe('??');
    expect(nagToSymbol(5)).toBe('!?');
    expect(nagToSymbol(6)).toBe('?!');
    expect(nagToSymbol(7)).toBe('□');
    expect(nagToSymbol(10)).toBe('=');
    expect(nagToSymbol(11)).toBe('=');
    expect(nagToSymbol(12)).toBe('=');
    expect(nagToSymbol(13)).toBe('∞');
    expect(nagToSymbol(14)).toBe('⩲');
    expect(nagToSymbol(18)).toBe('+−');
    expect(nagToSymbol(19)).toBe('−+');
  });

  it('returns $N for unknown NAG codes', () => {
    expect(nagToSymbol(99)).toBe('$99');
    expect(nagToSymbol(200)).toBe('$200');
  });
});

describe('symbolToNag', () => {
  it('maps known symbols to NAG codes', () => {
    expect(symbolToNag('!')).toBe(1);
    expect(symbolToNag('?')).toBe(2);
    expect(symbolToNag('!!')).toBe(3);
    expect(symbolToNag('??')).toBe(4);
    expect(symbolToNag('!?')).toBe(5);
    expect(symbolToNag('?!')).toBe(6);
  });

  it('parses $N format', () => {
    expect(symbolToNag('$1')).toBe(1);
    expect(symbolToNag('$99')).toBe(99);
  });

  it('returns -1 for unknown symbols', () => {
    expect(symbolToNag('xyz')).toBe(-1);
  });
});
