import { describe, it, expect } from 'vitest';
import {
  migrateLegacyPrecisionParams,
  readPrecisionScope,
  scopeToLegacyFilters,
} from './precisionUrlMigrate';

describe('migrateLegacyPrecisionParams', () => {
  it('migrates ?mine=true&visibility=draft → ?scope=drafts', () => {
    const next = migrateLegacyPrecisionParams(
      new URLSearchParams('mine=true&visibility=draft'),
    );
    expect(next).not.toBeNull();
    expect(next!.get('scope')).toBe('drafts');
    expect(next!.has('mine')).toBe(false);
    expect(next!.has('visibility')).toBe(false);
  });

  it('migrates ?mine=true&visibility=public → ?scope=published', () => {
    const next = migrateLegacyPrecisionParams(
      new URLSearchParams('mine=true&visibility=public'),
    );
    expect(next!.get('scope')).toBe('published');
  });

  it('migrates ?mine=true (без visibility) → ?scope=drafts (default mine был draft)', () => {
    const next = migrateLegacyPrecisionParams(new URLSearchParams('mine=true'));
    expect(next!.get('scope')).toBe('drafts');
  });

  it('migrates ?visibility=public (без mine) → ?scope=server', () => {
    const next = migrateLegacyPrecisionParams(
      new URLSearchParams('visibility=public'),
    );
    expect(next!.get('scope')).toBe('server');
  });

  it('возвращает null если scope уже в URL (идемпотентно)', () => {
    expect(
      migrateLegacyPrecisionParams(new URLSearchParams('scope=drafts')),
    ).toBeNull();
  });

  it('возвращает null если нет legacy-параметров', () => {
    expect(migrateLegacyPrecisionParams(new URLSearchParams(''))).toBeNull();
    expect(
      migrateLegacyPrecisionParams(new URLSearchParams('objective=convertAdvantage')),
    ).toBeNull();
  });

  it('сохраняет non-legacy параметры при миграции', () => {
    const next = migrateLegacyPrecisionParams(
      new URLSearchParams('mine=true&visibility=draft&objective=convertAdvantage&showSolved=true'),
    );
    expect(next!.get('scope')).toBe('drafts');
    expect(next!.get('objective')).toBe('convertAdvantage');
    expect(next!.get('showSolved')).toBe('true');
  });
});

describe('readPrecisionScope', () => {
  it('возвращает server по умолчанию', () => {
    expect(readPrecisionScope(new URLSearchParams(''), true)).toBe('server');
  });

  it('возвращает drafts/published из URL', () => {
    expect(
      readPrecisionScope(new URLSearchParams('scope=drafts'), true),
    ).toBe('drafts');
    expect(
      readPrecisionScope(new URLSearchParams('scope=published'), true),
    ).toBe('published');
  });

  it('гостю всегда server (даже при scope=drafts в URL)', () => {
    expect(
      readPrecisionScope(new URLSearchParams('scope=drafts'), false),
    ).toBe('server');
  });

  it('некорректное значение → server', () => {
    expect(
      readPrecisionScope(new URLSearchParams('scope=invalid'), true),
    ).toBe('server');
  });

  it('backward-compat: ?mine=true&visibility=draft → drafts (без scope)', () => {
    expect(
      readPrecisionScope(
        new URLSearchParams('mine=true&visibility=draft'),
        true,
      ),
    ).toBe('drafts');
  });

  it('backward-compat: ?mine=true&visibility=public → published', () => {
    expect(
      readPrecisionScope(
        new URLSearchParams('mine=true&visibility=public'),
        true,
      ),
    ).toBe('published');
  });

  it('backward-compat: ?mine=true без visibility → drafts (default)', () => {
    expect(
      readPrecisionScope(new URLSearchParams('mine=true'), true),
    ).toBe('drafts');
  });

  it('backward-compat: гостю всё равно server (даже при ?mine=true)', () => {
    expect(
      readPrecisionScope(new URLSearchParams('mine=true'), false),
    ).toBe('server');
  });
});

describe('scopeToLegacyFilters', () => {
  it('server → mine/visibility undefined (backend default = public-only)', () => {
    expect(scopeToLegacyFilters('server')).toEqual({
      mine: undefined,
      visibility: undefined,
    });
  });
  it('drafts → mine=true, visibility=draft', () => {
    expect(scopeToLegacyFilters('drafts')).toEqual({
      mine: true,
      visibility: 'draft',
    });
  });
  it('published → mine=true, visibility=public', () => {
    expect(scopeToLegacyFilters('published')).toEqual({
      mine: true,
      visibility: 'public',
    });
  });
});
