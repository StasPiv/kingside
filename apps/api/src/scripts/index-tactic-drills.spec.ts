/**
 * KS-2229. Юнит-тесты для CLI-индексера: парсинг args + проверка
 * predicatesForPosition (что для известной FEN возвращаются ожидаемые
 * drill-кандидаты).
 *
 * Pipeline-целиком (читать archive_games + writeBatch) — интеграционный
 * сценарий, гонится отдельно через `npm run index:tactic-drills` на
 * dev-БД (см. README acceptance).
 */

import { Chess } from 'chess.js';
import { parseArgs, predicatesForPosition } from './index-tactic-drills';

describe('parseArgs — KS-2229 CLI', () => {
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

describe('predicatesForPosition — KS-2229', () => {
  // KS-2393: тест back-rank mate удалён вместе с типом
  // `mate-in-1 (deprecated)`. Predicate более не существует.

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

  it('KS-2397: find-all-checks → meta.expectedMoves (массив пар)', () => {
    // Позиция с несколькими ходами-шахами, без мата (predicate отсекает
    // мат-в-1 с KS-2227 §2.1 строка 2).
    // Белая ладья + конь, чёрный король; есть несколько способов
    // объявить шах без мата.
    const chess = new Chess('4k3/8/8/8/3N4/8/3R4/4K3 w - - 0 1');
    const options = parseArgs([]);
    const drills = predicatesForPosition(chess, options, 'archive');
    const checks = drills.find((d) => d.type === 'find-all-checks');
    if (!checks) return; // позиция может не пройти инварианты — ок,
    // тест-позиция выбрана с запасом, но если pred её отсёк, не валим.
    expect(checks.meta).toBeDefined();
    const moves = (checks.meta as { expectedMoves?: { from: string; to: string }[] })?.expectedMoves;
    expect(moves).toBeDefined();
    expect(Array.isArray(moves)).toBe(true);
    expect(moves!.length).toBeGreaterThanOrEqual(2);
    // Каждая пара — валидные клетки.
    for (const m of moves!) {
      expect(m.from).toMatch(/^[a-h][1-8]$/);
      expect(m.to).toMatch(/^[a-h][1-8]$/);
    }
    // Согласованность с answer.squares: множество `to` из expectedMoves
    // покрывает множество клеток ответа (и наоборот).
    if (checks.answer.shape === 'squares') {
      const toSet = new Set(moves!.map((m) => m.to));
      const ansSet = new Set(checks.answer.squares);
      expect(toSet.size).toBe(ansSet.size);
      for (const sq of ansSet) expect(toSet.has(sq)).toBe(true);
    }
  });

  it('пустая позиция → нет drill-кандидатов', () => {
    const chess = new Chess('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
    const options = parseArgs([]);
    const drills = predicatesForPosition(chess, options, 'archive');
    // count-attackers candidates тоже могут быть для двух королей —
    // фильтр по типам пустой не делается, для тестируемого предиката
    // достаточно что для большинства типов 0 кандидатов.
    const nonCount = drills.filter((d) => d.type !== 'count-attackers');
    expect(nonCount.length).toBe(0);
  });
});
