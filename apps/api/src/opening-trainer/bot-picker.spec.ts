import { pickBotMove } from './bot-picker';
import type { RepertoireEdge } from '@kingside/shared';

/**
 * KS-3272 / ADR-077 §2.3. Спека random-without-repeat бот-picker'а.
 */

function edge(uci: string, childFen: string): RepertoireEdge {
  return { moveUci: uci, moveSan: uci, childFen };
}

describe('pickBotMove', () => {
  it('пустые edges → lineComplete=true, pick=null', () => {
    const r = pickBotMove({
      edges: [],
      playedChildFens: [],
      repeatMode: 'complete',
    });
    expect(r).toEqual({ pick: null, cycled: false, lineComplete: true });
  });

  it('один edge, не сыгран → выбирает его', () => {
    const e = edge('e2e4', 'fen-after-e4');
    const r = pickBotMove({
      edges: [e],
      playedChildFens: [],
      repeatMode: 'complete',
      random: () => 0.5,
    });
    expect(r.pick).toBe(e);
    expect(r.cycled).toBe(false);
    expect(r.lineComplete).toBe(false);
  });

  it('несколько edges + некоторые сыграны → выбирает из оставшихся', () => {
    const e1 = edge('e2e4', 'fen-A');
    const e2 = edge('d2d4', 'fen-B');
    const e3 = edge('c2c4', 'fen-C');
    // played: A, C. Доступен только B (e2/d2/c2 → e2=A, d2=B, c2=C).
    const r = pickBotMove({
      edges: [e1, e2, e3],
      playedChildFens: ['fen-A', 'fen-C'],
      repeatMode: 'complete',
      random: () => 0.99, // последний элемент в available
    });
    expect(r.pick).toBe(e2);
  });

  it('все edges пройдены, repeatMode=complete → lineComplete=true', () => {
    const e1 = edge('e2e4', 'fen-A');
    const e2 = edge('d2d4', 'fen-B');
    const r = pickBotMove({
      edges: [e1, e2],
      playedChildFens: ['fen-A', 'fen-B'],
      repeatMode: 'complete',
    });
    expect(r.pick).toBeNull();
    expect(r.lineComplete).toBe(true);
    expect(r.cycled).toBe(false);
  });

  it('все edges пройдены, repeatMode=cycle → cycled=true + выбирает из всех', () => {
    const e1 = edge('e2e4', 'fen-A');
    const e2 = edge('d2d4', 'fen-B');
    const r = pickBotMove({
      edges: [e1, e2],
      playedChildFens: ['fen-A', 'fen-B'],
      repeatMode: 'cycle',
      random: () => 0,
    });
    expect(r.cycled).toBe(true);
    expect(r.lineComplete).toBe(false);
    expect(r.pick).toBe(e1);
  });

  it('uniform-random корректный для серии вызовов (sanity)', () => {
    // 1000 итераций с одинаковыми 3 edges и cycle-mode. Каждый из 3
    // edges должен быть выбран хотя бы один раз.
    const edges = [
      edge('a', 'A'),
      edge('b', 'B'),
      edge('c', 'C'),
    ];
    const counts = { A: 0, B: 0, C: 0 };
    for (let i = 0; i < 1000; i++) {
      const r = pickBotMove({
        edges,
        playedChildFens: [],
        repeatMode: 'complete',
      });
      counts[r.pick!.childFen as 'A' | 'B' | 'C']++;
    }
    expect(counts.A).toBeGreaterThan(200);
    expect(counts.B).toBeGreaterThan(200);
    expect(counts.C).toBeGreaterThan(200);
  });

  it('random=1 защищён от out-of-bounds', () => {
    const e1 = edge('e2e4', 'fen-A');
    const e2 = edge('d2d4', 'fen-B');
    const r = pickBotMove({
      edges: [e1, e2],
      playedChildFens: [],
      repeatMode: 'complete',
      random: () => 1, // = floor(1*2) = 2 → out of bounds
    });
    expect(r.pick).toBe(e2); // safely clamped to last
  });

  it('random-without-repeat: 4 edges проходятся ровно по разу за 4 итерации (cycle)', () => {
    const edges = [
      edge('a', 'A'),
      edge('b', 'B'),
      edge('c', 'C'),
      edge('d', 'D'),
    ];
    const played: string[] = [];
    const seen = new Set<string>();
    // Жадно вытягиваем 4 хода — должны быть все разные.
    for (let i = 0; i < 4; i++) {
      const r = pickBotMove({
        edges,
        playedChildFens: played,
        repeatMode: 'complete',
        random: () => Math.random(),
      });
      expect(r.pick).not.toBeNull();
      expect(seen.has(r.pick!.childFen)).toBe(false);
      seen.add(r.pick!.childFen);
      played.push(r.pick!.childFen);
    }
    expect(seen.size).toBe(4);
    // 5-й вызов — lineComplete.
    const fifth = pickBotMove({
      edges,
      playedChildFens: played,
      repeatMode: 'complete',
    });
    expect(fifth.lineComplete).toBe(true);
  });
});
