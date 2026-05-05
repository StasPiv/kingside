/**
 * KS-2438. Юнит-тесты CLI-обёртки `index-tactic-drills` для tactic-worker.
 * Перенесены из `apps/api/src/scripts/index-tactic-drills.spec.ts`
 * (KS-2229) и адаптированы под новые пути импортов.
 */

import { Chess } from 'chess.js';
import { parseArgs, predicatesForPosition } from './index-tactic-drills.cli';

describe('parseArgs — tactic-worker CLI', () => {
  it('default options', () => {
    const o = parseArgs([]);
    expect(o.difficultyVersion).toBe('v1');
    expect(o.perTypeTarget).toBe(3000);
    expect(o.maxGames).toBe(Infinity);
    expect(o.gameBatchSize).toBe(200);
    expect(o.insertBatchSize).toBe(500);
    // KS-2393: после удаления mate-in-1 типов — 7.
    expect(o.types.size).toBe(7);
  });

  it('--difficulty-version=full', () => {
    expect(parseArgs(['--difficulty-version=full']).difficultyVersion).toBe(
      'full',
    );
  });

  it('--difficulty-version=invalid → throws', () => {
    expect(() => parseArgs(['--difficulty-version=v3'])).toThrow();
  });

  it('--max-games=inf трактуется как Infinity', () => {
    expect(parseArgs(['--max-games=inf']).maxGames).toBe(Infinity);
  });

  it('--max-games=100 → 100', () => {
    expect(parseArgs(['--max-games=100']).maxGames).toBe(100);
  });

  it('--types ограничивает набор', () => {
    const o = parseArgs(['--types=find-fork,find-pin']);
    expect([...o.types].sort()).toEqual(['find-fork', 'find-pin']);
  });

  it('--types с неизвестным типом фильтруется', () => {
    const o = parseArgs(['--types=find-fork,unknown-type']);
    expect([...o.types]).toEqual(['find-fork']);
  });

  it('--types полностью пустой → throw', () => {
    expect(() => parseArgs(['--types=unknown-only'])).toThrow();
  });

  it('unknown option → throw', () => {
    expect(() => parseArgs(['--bogus=1'])).toThrow();
  });
});

describe('predicatesForPosition — tactic-worker CLI re-export', () => {
  it('FEN с одним loose-куском → возвращает find-loose-piece drill', () => {
    const chess = new Chess('4k3/8/8/4n3/8/8/8/4K3 w - - 0 1');
    const options = parseArgs([]);
    const drills = predicatesForPosition(chess, options, 'archive');
    const loose = drills.find((d) => d.type === 'find-loose-piece');
    expect(loose).toBeDefined();
    if (loose && loose.answer.shape === 'square') {
      expect(loose.answer.square).toBe('e5');
    }
  });

  it('--types фильтр: только find-fork → не возвращает другие типы', () => {
    const chess = new Chess('r3k3/2N5/8/8/8/8/8/4K3 w - - 0 1');
    const options = parseArgs(['--types=find-fork']);
    const drills = predicatesForPosition(chess, options, 'archive');
    for (const d of drills) {
      expect(d.type).toBe('find-fork');
    }
  });

  it('пустая позиция → нет drill-кандидатов', () => {
    const chess = new Chess('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
    const options = parseArgs([]);
    const drills = predicatesForPosition(chess, options, 'archive');
    const nonCount = drills.filter((d) => d.type !== 'count-attackers');
    expect(nonCount.length).toBe(0);
  });
});
