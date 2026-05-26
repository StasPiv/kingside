import { describe, it, expect } from 'vitest';
import {
  buildBackUrl,
  buildPrecisionNextParams,
  buildPrecisionPuzzleQuery,
  detectPuzzleSection,
} from './puzzleNav';

/**
 * KS-2688 / KS-3349. Тесты хелперов навигации между /precision и
 * /puzzle/:id и backwards.
 */

describe('detectPuzzleSection', () => {
  it('?source=precision → precision', () => {
    expect(
      detectPuzzleSection(new URLSearchParams('source=precision')),
    ).toBe('precision');
  });
  it('?source=play-vs-engine (legacy) → precision', () => {
    expect(
      detectPuzzleSection(new URLSearchParams('source=play-vs-engine')),
    ).toBe('precision');
  });
  it('пусто → puzzles', () => {
    expect(detectPuzzleSection(new URLSearchParams(''))).toBe('puzzles');
  });
  it('неизвестный source → puzzles', () => {
    expect(
      detectPuzzleSection(new URLSearchParams('source=other')),
    ).toBe('puzzles');
  });
});

describe('buildBackUrl', () => {
  it('без source → /puzzles', () => {
    expect(buildBackUrl(new URLSearchParams(''))).toBe('/puzzles');
  });
  it('source=precision → /precision', () => {
    expect(
      buildBackUrl(new URLSearchParams('source=precision')),
    ).toBe('/precision');
  });
  it('legacy mine/visibility сохраняются', () => {
    expect(
      buildBackUrl(
        new URLSearchParams('source=precision&mine=true&visibility=draft'),
      ),
    ).toBe('/precision?mine=true&visibility=draft');
  });
  it('KS-3349: scope/objective/blundererEloMin/Max/showSolved сохраняются', () => {
    const url = buildBackUrl(
      new URLSearchParams(
        'source=precision&scope=drafts&objective=convertAdvantage&blundererEloMin=1800&blundererEloMax=2200&showSolved=true',
      ),
    );
    expect(url).toContain('scope=drafts');
    expect(url).toContain('objective=convertAdvantage');
    expect(url).toContain('blundererEloMin=1800');
    expect(url).toContain('blundererEloMax=2200');
    expect(url).toContain('showSolved=true');
  });

  it('KS-3362: themes тоже сохраняются при возврате', () => {
    const url = buildBackUrl(
      new URLSearchParams('source=precision&themes=pin,fork'),
    );
    expect(url).toContain('themes=pin%2Cfork');
  });
});

describe('buildPrecisionPuzzleQuery', () => {
  it('пустой /precision → ?source=precision', () => {
    expect(
      buildPrecisionPuzzleQuery(new URLSearchParams('')),
    ).toBe('?source=precision');
  });
  it('сохраняет mine/visibility/scope/objective/elo/showSolved', () => {
    const qs = buildPrecisionPuzzleQuery(
      new URLSearchParams(
        'scope=drafts&objective=convertAdvantage&blundererEloMin=2000&showSolved=true',
      ),
    );
    expect(qs).toContain('source=precision');
    expect(qs).toContain('scope=drafts');
    expect(qs).toContain('objective=convertAdvantage');
    expect(qs).toContain('blundererEloMin=2000');
    expect(qs).toContain('showSolved=true');
  });
});

describe('buildPrecisionNextParams (KS-3349)', () => {
  it('пустой URL + гость → scope=server, без других полей', () => {
    expect(buildPrecisionNextParams(new URLSearchParams(''), false)).toEqual({
      scope: 'server',
    });
  });
  it('пустой URL + auth → scope=server + hideSolved=true (default invert)', () => {
    expect(buildPrecisionNextParams(new URLSearchParams(''), true)).toEqual({
      scope: 'server',
      hideSolved: true,
    });
  });
  it('?scope=drafts (auth) → scope=drafts', () => {
    expect(
      buildPrecisionNextParams(new URLSearchParams('scope=drafts'), true),
    ).toMatchObject({ scope: 'drafts' });
  });
  it('?scope=drafts (guest) → forced server (drafts недоступны гостю)', () => {
    expect(
      buildPrecisionNextParams(new URLSearchParams('scope=drafts'), false),
    ).toEqual({ scope: 'server' });
  });
  it('backward-compat: ?mine=true&visibility=draft (auth) → drafts', () => {
    expect(
      buildPrecisionNextParams(
        new URLSearchParams('mine=true&visibility=draft'),
        true,
      ),
    ).toMatchObject({ scope: 'drafts' });
  });
  it('backward-compat: ?mine=true&visibility=public (auth) → published', () => {
    expect(
      buildPrecisionNextParams(
        new URLSearchParams('mine=true&visibility=public'),
        true,
      ),
    ).toMatchObject({ scope: 'published' });
  });
  it('objective=convertAdvantage пробрасывается', () => {
    expect(
      buildPrecisionNextParams(
        new URLSearchParams('objective=convertAdvantage'),
        true,
      ),
    ).toMatchObject({ objective: 'convertAdvantage' });
  });
  it("objective=all → не пробрасывается", () => {
    const r = buildPrecisionNextParams(
      new URLSearchParams('objective=all'),
      true,
    );
    expect(r.objective).toBeUndefined();
  });
  it('blundererEloMin/Max пробрасываются как overrideRatingMin/Max', () => {
    expect(
      buildPrecisionNextParams(
        new URLSearchParams('blundererEloMin=1800&blundererEloMax=2200'),
        true,
      ),
    ).toMatchObject({ overrideRatingMin: 1800, overrideRatingMax: 2200 });
  });
  it('невалидный blundererEloMin → не пробрасывается', () => {
    const r = buildPrecisionNextParams(
      new URLSearchParams('blundererEloMin=abc'),
      true,
    );
    expect(r.overrideRatingMin).toBeUndefined();
  });
  it('?showSolved=true (auth) → hideSolved отсутствует', () => {
    const r = buildPrecisionNextParams(
      new URLSearchParams('showSolved=true'),
      true,
    );
    expect(r.hideSolved).toBeUndefined();
  });
  it('гость → hideSolved не выставляется (фильтр auth-only)', () => {
    const r = buildPrecisionNextParams(new URLSearchParams(''), false);
    expect(r.hideSolved).toBeUndefined();
  });

  it('KS-3362: ?themes=pin,fork (whitelist) → themesOr=[pin,fork]', () => {
    const r = buildPrecisionNextParams(
      new URLSearchParams('themes=pin,fork'),
      true,
    );
    expect(r.themesOr).toEqual(['pin', 'fork']);
  });

  it('KS-3362: пустой themes → themesOr не выставлен', () => {
    const r = buildPrecisionNextParams(
      new URLSearchParams('themes='),
      true,
    );
    expect(r.themesOr).toBeUndefined();
  });

  it('KS-3362: невалидная тема в URL → отброшена', () => {
    const r = buildPrecisionNextParams(
      new URLSearchParams('themes=pin,nonsense'),
      true,
    );
    expect(r.themesOr).toEqual(['pin']);
  });
});
