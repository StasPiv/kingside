/**
 * Unit-тесты `computeAdvanceLinks` (KS-1824).
 *
 * Покрытие:
 *   - single-elimination (main-сетка): quarter → semi → final → grand_final (+reset);
 *   - double-elimination: winners_quarter → winners_semi → winners_final → grand_final;
 *                         losers-цепочка, winners_<stage> → losers_<same size>;
 *   - неполные данные (одиночные стадии без продолжения);
 *   - round-robin (пар нет, stage=null) — пустой результат;
 *   - grand_final_reset как последняя точка цепи.
 */

import { computeAdvanceLinks, stageSide, stageSize } from './compute-advance-links';

function pair(bracketPairId: string, bracketStage: string) {
  return { bracketPairId, bracketStage };
}

describe('stageSize / stageSide', () => {
  it('round_of_16 → 16, quarter → 8, semi → 4, final → 2', () => {
    expect(stageSize('round_of_16')).toBe(16);
    expect(stageSize('quarter')).toBe(8);
    expect(stageSize('semi')).toBe(4);
    expect(stageSize('final')).toBe(2);
    expect(stageSize('grand_final')).toBe(1);
    expect(stageSize('grand_final_reset')).toBe(0);
  });

  it('winners_quarter → winners, losers_final → losers', () => {
    expect(stageSide('winners_quarter')).toBe('winners');
    expect(stageSide('losers_final')).toBe('losers');
    expect(stageSide('quarter')).toBe('main');
    expect(stageSide('grand_final')).toBe('grand');
    expect(stageSide('grand_final_reset')).toBe('grand');
  });
});

describe('computeAdvanceLinks — single-elimination', () => {
  it('quarter → semi → final: 4 QF → 2 SF → 1 F', () => {
    const pairs = [
      pair('quarter:a|b', 'quarter'),
      pair('quarter:c|d', 'quarter'),
      pair('quarter:e|f', 'quarter'),
      pair('quarter:g|h', 'quarter'),
      pair('semi:ab|cd', 'semi'),
      pair('semi:ef|gh', 'semi'),
      pair('final:abcd|efgh', 'final'),
    ];
    const { byPair, links } = computeAdvanceLinks(pairs);

    // 4 QF пар попарно идут в 2 SF: первые две по лекс.сортировке → semi:ab|cd,
    // последние две → semi:ef|gh.
    const qfSorted = ['quarter:a|b', 'quarter:c|d', 'quarter:e|f', 'quarter:g|h'];
    expect(byPair.get(qfSorted[0])!.advanceToPairId).toBe('semi:ab|cd');
    expect(byPair.get(qfSorted[1])!.advanceToPairId).toBe('semi:ab|cd');
    expect(byPair.get(qfSorted[2])!.advanceToPairId).toBe('semi:ef|gh');
    expect(byPair.get(qfSorted[3])!.advanceToPairId).toBe('semi:ef|gh');

    // 2 SF → 1 F
    expect(byPair.get('semi:ab|cd')!.advanceToPairId).toBe('final:abcd|efgh');
    expect(byPair.get('semi:ef|gh')!.advanceToPairId).toBe('final:abcd|efgh');

    // final без grand_final → advance null.
    expect(byPair.get('final:abcd|efgh')!.advanceToPairId).toBeNull();

    // Рёбра winners-типа (в single-elim main все рёбра winner).
    expect(links.every((l) => l.kind === 'winner')).toBe(true);
    // Дедупликация: 4 QF → 2 уникальных ребра к SF + 2 ребра SF → F.
    // Итого 4 + 2 = 6 уникальных рёбер.
    expect(links).toHaveLength(6);
  });

  it('final → grand_final → grand_final_reset (цепочка до reset)', () => {
    const pairs = [
      pair('final:abcd|efgh', 'final'),
      pair('grand_final:winner|loser', 'grand_final'),
      pair('grand_final_reset:winner|loser', 'grand_final_reset'),
    ];
    const { byPair } = computeAdvanceLinks(pairs);
    expect(byPair.get('final:abcd|efgh')!.advanceToPairId).toBe(
      'grand_final:winner|loser',
    );
    expect(byPair.get('grand_final:winner|loser')!.advanceToPairId).toBe(
      'grand_final_reset:winner|loser',
    );
    expect(byPair.get('grand_final_reset:winner|loser')!.advanceToPairId).toBeNull();
  });
});

describe('computeAdvanceLinks — double-elimination', () => {
  it('winners chain: quarter → semi → final → grand_final', () => {
    const pairs = [
      pair('winners_quarter:a|b', 'winners_quarter'),
      pair('winners_quarter:c|d', 'winners_quarter'),
      pair('winners_semi:ab|cd', 'winners_semi'),
      pair('winners_final:ab|cd', 'winners_final'),
      pair('grand_final:x|y', 'grand_final'),
    ];
    const { byPair } = computeAdvanceLinks(pairs);
    expect(byPair.get('winners_quarter:a|b')!.advanceToPairId).toBe(
      'winners_semi:ab|cd',
    );
    expect(byPair.get('winners_quarter:c|d')!.advanceToPairId).toBe(
      'winners_semi:ab|cd',
    );
    expect(byPair.get('winners_semi:ab|cd')!.advanceToPairId).toBe(
      'winners_final:ab|cd',
    );
    expect(byPair.get('winners_final:ab|cd')!.advanceToPairId).toBe(
      'grand_final:x|y',
    );
  });

  it('losers_final → grand_final (одним ребром kind=winner)', () => {
    const pairs = [
      pair('winners_final:a|b', 'winners_final'),
      pair('losers_final:c|d', 'losers_final'),
      pair('grand_final:x|y', 'grand_final'),
    ];
    const { byPair, links } = computeAdvanceLinks(pairs);
    expect(byPair.get('winners_final:a|b')!.advanceToPairId).toBe('grand_final:x|y');
    expect(byPair.get('losers_final:c|d')!.advanceToPairId).toBe('grand_final:x|y');
    expect(
      links.some(
        (l) => l.fromPairId === 'losers_final:c|d' && l.toPairId === 'grand_final:x|y' && l.kind === 'winner',
      ),
    ).toBe(true);
  });

  it('winners → losers по совпадающему размеру стадии (loserToPairId)', () => {
    const pairs = [
      pair('winners_quarter:a|b', 'winners_quarter'),
      pair('winners_quarter:c|d', 'winners_quarter'),
      pair('losers_quarter:p|q', 'losers_quarter'),
      pair('losers_quarter:r|s', 'losers_quarter'),
    ];
    const { byPair, links } = computeAdvanceLinks(pairs);
    expect(byPair.get('winners_quarter:a|b')!.loserToPairId).toBe(
      'losers_quarter:p|q',
    );
    expect(byPair.get('winners_quarter:c|d')!.loserToPairId).toBe(
      'losers_quarter:r|s',
    );
    // losers-пары получают loser null (только winners падают в losers).
    expect(byPair.get('losers_quarter:p|q')!.loserToPairId).toBeNull();
    // В `links` появляются рёбра kind='loser'.
    expect(
      links.filter((l) => l.kind === 'loser'),
    ).toHaveLength(2);
  });

  it('полная double-elim сетка с grand_final_reset — все связи на месте', () => {
    const pairs = [
      // Winners QF (2 пары)
      pair('winners_quarter:a|b', 'winners_quarter'),
      pair('winners_quarter:c|d', 'winners_quarter'),
      // Winners SF (1 пара)
      pair('winners_semi:ab|cd', 'winners_semi'),
      // Losers QF (2 пары)
      pair('losers_quarter:p|q', 'losers_quarter'),
      pair('losers_quarter:r|s', 'losers_quarter'),
      // Losers SF
      pair('losers_semi:pq|rs', 'losers_semi'),
      // Grand + reset
      pair('grand_final:f1|f2', 'grand_final'),
      pair('grand_final_reset:f1|f2', 'grand_final_reset'),
    ];
    const { byPair, links } = computeAdvanceLinks(pairs);

    expect(byPair.get('winners_quarter:a|b')!.advanceToPairId).toBe(
      'winners_semi:ab|cd',
    );
    expect(byPair.get('winners_quarter:a|b')!.loserToPairId).toBe(
      'losers_quarter:p|q',
    );
    expect(byPair.get('winners_semi:ab|cd')!.advanceToPairId).toBe(
      'grand_final:f1|f2',
    );
    expect(byPair.get('losers_semi:pq|rs')!.advanceToPairId).toBe(
      'grand_final:f1|f2',
    );
    expect(byPair.get('grand_final:f1|f2')!.advanceToPairId).toBe(
      'grand_final_reset:f1|f2',
    );

    // Обеспечиваем, что все уникальные рёбра в `links` присутствуют.
    const linkSet = new Set(
      links.map((l) => `${l.kind}:${l.fromPairId}->${l.toPairId}`),
    );
    expect(linkSet.has('winner:winners_quarter:a|b->winners_semi:ab|cd')).toBe(true);
    expect(linkSet.has('loser:winners_quarter:a|b->losers_quarter:p|q')).toBe(true);
    expect(linkSet.has('winner:losers_semi:pq|rs->grand_final:f1|f2')).toBe(true);
    expect(linkSet.has('winner:grand_final:f1|f2->grand_final_reset:f1|f2')).toBe(
      true,
    );
  });
});

describe('computeAdvanceLinks — edge cases', () => {
  it('пустой вход → пустые map/links', () => {
    const res = computeAdvanceLinks([]);
    expect(res.byPair.size).toBe(0);
    expect(res.links).toEqual([]);
  });

  it('одна пара без продолжения → advance null, loser null', () => {
    const res = computeAdvanceLinks([pair('final:a|b', 'final')]);
    expect(res.byPair.get('final:a|b')).toEqual({
      advanceToPairId: null,
      loserToPairId: null,
    });
    expect(res.links).toEqual([]);
  });

  it('дубли pairId дедуплицируются', () => {
    // В реальном мире одна пара даёт несколько партий — в input
    // мы их подаём как дубли по pairId. computeAdvanceLinks должен
    // обработать каждую пару один раз.
    const pairs = [
      pair('winners_quarter:a|b', 'winners_quarter'),
      pair('winners_quarter:a|b', 'winners_quarter'),
      pair('winners_quarter:a|b', 'winners_quarter'),
      pair('winners_semi:ab|ab', 'winners_semi'),
    ];
    const { byPair, links } = computeAdvanceLinks(pairs);
    expect(byPair.size).toBe(2);
    expect(links).toHaveLength(1);
  });

  it('нечётное количество пар: лишняя без advance', () => {
    // 3 QF при наличии 1 SF: первые две в bucket[0] → semi:x|y,
    // третья — в bucket[1], следующей стадии нет → advance null.
    const pairs = [
      pair('quarter:a|b', 'quarter'),
      pair('quarter:c|d', 'quarter'),
      pair('quarter:e|f', 'quarter'),
      pair('semi:ab|cd', 'semi'),
    ];
    const { byPair } = computeAdvanceLinks(pairs);
    expect(byPair.get('quarter:a|b')!.advanceToPairId).toBe('semi:ab|cd');
    expect(byPair.get('quarter:c|d')!.advanceToPairId).toBe('semi:ab|cd');
    expect(byPair.get('quarter:e|f')!.advanceToPairId).toBeNull();
  });

  it('stage с неизвестным форматом → не мешает остальным', () => {
    const pairs = [
      pair('weird:a|b', 'totally_unexpected'),
      pair('final:c|d', 'final'),
      pair('grand_final:x|y', 'grand_final'),
    ];
    const { byPair } = computeAdvanceLinks(pairs);
    expect(byPair.get('weird:a|b')).toEqual({
      advanceToPairId: null,
      loserToPairId: null,
    });
    expect(byPair.get('final:c|d')!.advanceToPairId).toBe('grand_final:x|y');
  });
});

describe('computeAdvanceLinks — интеграция на «28-раундовом» фикстуре', () => {
  // Упрощённая double-elim сетка на 16 участников: winners R16 (8 пар),
  // winners QF (4), winners SF (2), winners F (1); losers-зеркало + grand.
  // Проверяем, что все стадии связаны в одну цельную цепь.
  it('16-team double-elimination: каждая winners-пара имеет advance + loser, grand_final связан с losers_final и winners_final', () => {
    const pairs: Array<{ bracketPairId: string; bracketStage: string }> = [];
    // Winners round_of_16 (8 пар)
    for (let i = 0; i < 8; i++) {
      pairs.push(pair(`winners_round_of_16:${i.toString().padStart(2, '0')}`, 'winners_round_of_16'));
    }
    // Winners QF (4)
    for (let i = 0; i < 4; i++) {
      pairs.push(pair(`winners_quarter:${i.toString().padStart(2, '0')}`, 'winners_quarter'));
    }
    // Winners SF (2)
    for (let i = 0; i < 2; i++) {
      pairs.push(pair(`winners_semi:${i.toString().padStart(2, '0')}`, 'winners_semi'));
    }
    // Winners F (1)
    pairs.push(pair('winners_final:00', 'winners_final'));
    // Losers зеркало
    for (let i = 0; i < 8; i++) {
      pairs.push(pair(`losers_round_of_16:${i.toString().padStart(2, '0')}`, 'losers_round_of_16'));
    }
    for (let i = 0; i < 4; i++) {
      pairs.push(pair(`losers_quarter:${i.toString().padStart(2, '0')}`, 'losers_quarter'));
    }
    for (let i = 0; i < 2; i++) {
      pairs.push(pair(`losers_semi:${i.toString().padStart(2, '0')}`, 'losers_semi'));
    }
    pairs.push(pair('losers_final:00', 'losers_final'));
    pairs.push(pair('grand_final:00', 'grand_final'));

    const { byPair, links } = computeAdvanceLinks(pairs);

    // Каждая winners-пара из нижних стадий имеет и advance, и loser.
    for (let i = 0; i < 8; i++) {
      const p = `winners_round_of_16:${i.toString().padStart(2, '0')}`;
      expect(byPair.get(p)!.advanceToPairId).toBeTruthy();
      expect(byPair.get(p)!.loserToPairId).toBeTruthy();
    }
    // winners_final → grand_final.
    expect(byPair.get('winners_final:00')!.advanceToPairId).toBe('grand_final:00');
    // losers_final → grand_final.
    expect(byPair.get('losers_final:00')!.advanceToPairId).toBe('grand_final:00');

    // Все losers-пары имеют loserToPairId=null (только winners падают в losers).
    for (const [id, data] of byPair) {
      if (id.startsWith('losers_')) {
        expect(data.loserToPairId).toBeNull();
      }
    }

    // Ребра winner и loser разделены.
    const winnerLinks = links.filter((l) => l.kind === 'winner');
    const loserLinks = links.filter((l) => l.kind === 'loser');
    expect(winnerLinks.length).toBeGreaterThan(0);
    expect(loserLinks.length).toBeGreaterThan(0);
  });
});
