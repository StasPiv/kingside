import { pathHash } from './path-hash';

describe('pathHash (KS-3288 M2 §2.5)', () => {
  it('пустой path → детерминированный hex', () => {
    const h = pathHash([]);
    expect(h).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709'); // sha1 of empty
    expect(h).toHaveLength(40);
  });

  it('один UCI', () => {
    const h = pathHash(['e2e4']);
    expect(h).toHaveLength(40);
    expect(h).toMatch(/^[0-9a-f]{40}$/);
  });

  it('один и тот же path даёт одинаковый hash', () => {
    const path = ['e2e4', 'e7e5', 'g1f3', 'b8c6'];
    expect(pathHash(path)).toBe(pathHash(path));
  });

  it('разный порядок ходов → разный hash', () => {
    const a = pathHash(['e2e4', 'e7e5']);
    const b = pathHash(['e7e5', 'e2e4']);
    expect(a).not.toBe(b);
  });

  it('подстрока path даёт другой hash (длина учитывается)', () => {
    const a = pathHash(['e2e4', 'e7e5']);
    const b = pathHash(['e2e4', 'e7e5', 'g1f3']);
    expect(a).not.toBe(b);
  });

  it('UCI с promotion (5-char) парсится корректно', () => {
    const h = pathHash(['a7a8q']);
    expect(h).toMatch(/^[0-9a-f]{40}$/);
  });
});
