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
    expect(o.types.size).toBe(8);
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
  it('back-rank mate FEN → возвращает find-mate-in-one-square drill', () => {
    const chess = new Chess('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
    const options = parseArgs([]);
    const drills = predicatesForPosition(chess, options, 'archive');
    const mate = drills.find((d) => d.type === 'find-mate-in-one-square');
    expect(mate).toBeDefined();
    if (mate) {
      expect(mate.answer.shape).toBe('square');
      expect(mate.fen).toBe(chess.fen());
      expect(mate.difficulty).toBeGreaterThanOrEqual(1);
      expect(mate.difficulty).toBeLessThanOrEqual(5);
    }
  });

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
    // count-attackers candidates тоже могут быть для двух королей —
    // фильтр по типам пустой не делается, для тестируемого предиката
    // достаточно что для большинства типов 0 кандидатов.
    const nonCount = drills.filter((d) => d.type !== 'count-attackers');
    expect(nonCount.length).toBe(0);
  });
});
