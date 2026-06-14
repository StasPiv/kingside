import { USER_AGENT_POOL, pickUserAgent } from './ua-pool';

describe('ua-pool', () => {
  it('пул содержит ≥ 5 уникальных строк', () => {
    expect(USER_AGENT_POOL.length).toBeGreaterThanOrEqual(5);
    expect(new Set(USER_AGENT_POOL).size).toBe(USER_AGENT_POOL.length);
  });

  it('каждая строка похожа на UA (Mozilla/5.0)', () => {
    for (const ua of USER_AGENT_POOL) {
      expect(ua.startsWith('Mozilla/5.0')).toBe(true);
    }
  });

  it('pickUserAgent с детерминированным random — детерминированный', () => {
    const seed = 0.42;
    const a = pickUserAgent(() => seed);
    const b = pickUserAgent(() => seed);
    expect(a).toBe(b);
  });

  it('pickUserAgent проходит весь пул при random=0..1', () => {
    const visited = new Set<string>();
    for (let i = 0; i < 100; i++) {
      visited.add(pickUserAgent(() => i / 100));
    }
    // Должен попасть хотя бы в половину пула.
    expect(visited.size).toBeGreaterThanOrEqual(USER_AGENT_POOL.length / 2);
  });
});
