/**
 * KS-3148 unit-tests чистых функций backfill-CLI (без NestJS-контекста).
 * Высокоуровневый `runBackfillPuzzleObjective` использует PrismaService —
 * его интеграционный smoke прогоняется отдельно в staging.
 */
import {
  addObjectiveTag,
  computeObjectiveFromMetadata,
} from './backfill-puzzle-objective.cli';

describe('computeObjectiveFromMetadata (KS-3148)', () => {
  it('wdlAfter с W=0.85 → convertAdvantage (по determinePuzzleObjective)', () => {
    expect(
      computeObjectiveFromMetadata({ wdlAfter: { w: 850, d: 100, l: 50 } }),
    ).toBe('convertAdvantage');
  });

  it('wdlAfter с W=0 D=0.952 (39. d6) → saveEquality', () => {
    expect(
      computeObjectiveFromMetadata({ wdlAfter: { w: 0, d: 952, l: 48 } }),
    ).toBe('saveEquality');
  });

  it('legacy без wdlAfter — fallback по wdlAfterBlunder ≥ 0.5 → convertAdvantage', () => {
    expect(
      computeObjectiveFromMetadata({ wdlAfterBlunder: 0.78 }),
    ).toBe('convertAdvantage');
  });

  it('legacy без wdlAfter — fallback по wdlAfterBlunder < 0.5 → saveEquality', () => {
    expect(
      computeObjectiveFromMetadata({ wdlAfterBlunder: 0.2 }),
    ).toBe('saveEquality');
  });

  it('границы fallback: wdlAfterBlunder=0.5 → convertAdvantage (включителен)', () => {
    expect(
      computeObjectiveFromMetadata({ wdlAfterBlunder: 0.5 }),
    ).toBe('convertAdvantage');
  });

  it('нет ни wdlAfter, ни wdlAfterBlunder → null (skip)', () => {
    expect(computeObjectiveFromMetadata({})).toBeNull();
    expect(computeObjectiveFromMetadata({ blunderMove: 'e2e4' })).toBeNull();
  });

  it('битый wdlAfter (нет w) → null', () => {
    expect(
      computeObjectiveFromMetadata({ wdlAfter: { d: 100, l: 50 } }),
    ).toBeNull();
  });

  it('wdlAfterBlunder не число → null', () => {
    expect(
      computeObjectiveFromMetadata({ wdlAfterBlunder: 'high' as unknown }),
    ).toBeNull();
  });
});

describe('addObjectiveTag (KS-3148)', () => {
  it('добавляет тег в конец и сортирует', () => {
    expect(addObjectiveTag('playVsEngine pin', 'convertAdvantage')).toBe(
      'convertAdvantage pin playVsEngine',
    );
  });

  it('не дублирует существующий тег', () => {
    expect(
      addObjectiveTag('convertAdvantage playVsEngine', 'convertAdvantage'),
    ).toBe('convertAdvantage playVsEngine');
  });

  it('пустые themes — становится только тегом', () => {
    expect(addObjectiveTag('', 'saveEquality')).toBe('saveEquality');
    expect(addObjectiveTag(null, 'saveEquality')).toBe('saveEquality');
  });

  it('дубли в исходной строке схлопываются (Set + sorted)', () => {
    expect(addObjectiveTag('pin pin sacrifice', 'saveEquality')).toBe(
      'pin sacrifice saveEquality',
    );
  });
});
