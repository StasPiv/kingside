import { describe, it, expect } from 'vitest';
import {
  EVENT_CATALOG,
  EVENT_CATEGORIES,
  SYSTEM_EVENT_TYPES,
  findEventMeta,
  resolveEventCategory,
  type EventCategory,
} from './event-catalog.js';

describe('EVENT_CATALOG', () => {
  it('каждый `type` уникален', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const m of EVENT_CATALOG) {
      if (seen.has(m.type)) dupes.push(m.type);
      seen.add(m.type);
    }
    expect(dupes).toEqual([]);
  });

  it('каждый `type` совпадает с серверной грамматикой `^[a-z][a-z0-9_]*$` ≤64', () => {
    const re = /^[a-z][a-z0-9_]*$/;
    for (const m of EVENT_CATALOG) {
      expect(m.type, m.type).toMatch(re);
      expect(m.type.length, m.type).toBeLessThanOrEqual(64);
    }
  });

  it('каждый `category` входит в `EVENT_CATEGORIES`', () => {
    const set = new Set<EventCategory>(EVENT_CATEGORIES);
    for (const m of EVENT_CATALOG) {
      expect(set.has(m.category), `${m.type}.category=${m.category}`).toBe(true);
    }
  });

  it('каждый `titleKey` начинается с `event.`', () => {
    for (const m of EVENT_CATALOG) {
      expect(m.titleKey, m.type).toMatch(/^event\./);
    }
  });
});

describe('findEventMeta', () => {
  it('возвращает мету для известного типа', () => {
    const meta = findEventMeta('game_end');
    expect(meta?.type).toBe('game_end');
    expect(meta?.category).toBe('game');
    expect(meta?.titleKey).toBe('event.game_end');
  });

  it('возвращает undefined для неизвестного типа (fallback на стороне UI)', () => {
    expect(findEventMeta('never_emitted_event_xyz')).toBeUndefined();
    expect(findEventMeta('')).toBeUndefined();
  });

  it('тип регистр-чувствителен — `GAME_END` не известно', () => {
    expect(findEventMeta('GAME_END')).toBeUndefined();
  });
});

describe('resolveEventCategory', () => {
  it('возвращает категорию известного типа', () => {
    expect(resolveEventCategory('puzzle_solved')).toBe('puzzle');
    expect(resolveEventCategory('hint_shown')).toBe('hint');
    expect(resolveEventCategory('page_view')).toBe('session');
  });

  it('для неизвестного типа возвращает `other`', () => {
    expect(resolveEventCategory('mystery_type')).toBe('other');
  });
});

describe('SYSTEM_EVENT_TYPES', () => {
  it('содержит page_view, session_idle, session_start', () => {
    expect(SYSTEM_EVENT_TYPES).toContain('page_view');
    expect(SYSTEM_EVENT_TYPES).toContain('session_idle');
    expect(SYSTEM_EVENT_TYPES).toContain('session_start');
  });

  it('все элементы есть в каталоге (нельзя помечать как системное событие, которого нет)', () => {
    for (const t of SYSTEM_EVENT_TYPES) {
      expect(findEventMeta(t), t).toBeDefined();
    }
  });

  it('все элементы — `session`-категория', () => {
    for (const t of SYSTEM_EVENT_TYPES) {
      expect(findEventMeta(t)?.category, t).toBe('session');
    }
  });
});

describe('hrefBuilder — game', () => {
  it('game_end с game_id → /game/<id>', () => {
    const meta = findEventMeta('game_end')!;
    expect(meta.hrefBuilder?.({ game_id: 'abc-123' })).toBe('/game/abc-123');
  });

  it('game_end без game_id → null', () => {
    const meta = findEventMeta('game_end')!;
    expect(meta.hrefBuilder?.({})).toBeNull();
    expect(meta.hrefBuilder?.({ game_id: '' })).toBeNull();
    expect(meta.hrefBuilder?.({ game_id: 42 })).toBeNull();
  });

  it('game_start/resign/draw_offered тоже маршрутят на /game/<id>', () => {
    for (const type of ['game_start', 'resign', 'draw_offered']) {
      expect(findEventMeta(type)?.hrefBuilder?.({ game_id: 'g1' }), type)
        .toBe('/game/g1');
    }
  });
});

describe('hrefBuilder — puzzle', () => {
  it('puzzle_solved/puzzle_failed/puzzle_start с puzzle_id → /puzzle/<id>', () => {
    for (const type of ['puzzle_solved', 'puzzle_failed', 'puzzle_start']) {
      expect(findEventMeta(type)?.hrefBuilder?.({ puzzle_id: 'pz-9' }), type)
        .toBe('/puzzle/pz-9');
    }
  });

  it('без puzzle_id → null', () => {
    expect(findEventMeta('puzzle_solved')?.hrefBuilder?.({})).toBeNull();
  });
});

describe('hrefBuilder — puzzle-rush', () => {
  it('rush_finish с score_id → /puzzle-rush/review/<id>', () => {
    const meta = findEventMeta('rush_finish')!;
    expect(meta.hrefBuilder?.({ score_id: 's-42' }))
      .toBe('/puzzle-rush/review/s-42');
  });

  it('rush_finish без score_id → /puzzle-rush (общий лобби)', () => {
    const meta = findEventMeta('rush_finish')!;
    expect(meta.hrefBuilder?.({})).toBe('/puzzle-rush');
  });

  it('rush_start всегда → /puzzle-rush', () => {
    expect(findEventMeta('rush_start')?.hrefBuilder?.({})).toBe('/puzzle-rush');
  });

  it('rush_streak_broken не имеет href', () => {
    expect(findEventMeta('rush_streak_broken')?.hrefBuilder).toBeUndefined();
  });
});

describe('hrefBuilder — lesson', () => {
  it('lesson_complete с course_slug+lesson_slug → /lessons/<course>/<lesson>', () => {
    const meta = findEventMeta('lesson_complete')!;
    expect(meta.hrefBuilder?.({ course_slug: 'caro-kann', lesson_slug: 'intro' }))
      .toBe('/lessons/caro-kann/intro');
  });

  it('lesson_complete только с course_slug → /lessons/<course>', () => {
    const meta = findEventMeta('lesson_complete')!;
    expect(meta.hrefBuilder?.({ course_slug: 'caro-kann' }))
      .toBe('/lessons/caro-kann');
  });

  it('lesson_complete без полей → null', () => {
    expect(findEventMeta('lesson_complete')?.hrefBuilder?.({})).toBeNull();
  });
});

describe('hrefBuilder — analysis', () => {
  it('analysis_open: analysis_id приоритетнее game_id', () => {
    const meta = findEventMeta('analysis_open')!;
    expect(meta.hrefBuilder?.({ analysis_id: 'a1', game_id: 'g1' }))
      .toBe('/analysis/a1');
  });

  it('analysis_open: fallback на /game/<id>/review если только game_id', () => {
    const meta = findEventMeta('analysis_open')!;
    expect(meta.hrefBuilder?.({ game_id: 'g1' })).toBe('/game/g1/review');
  });

  it('analysis_open без полей → null', () => {
    expect(findEventMeta('analysis_open')?.hrefBuilder?.({})).toBeNull();
  });
});

describe('hrefBuilder — page_view', () => {
  it('page_view возвращает payload.path как есть', () => {
    const meta = findEventMeta('page_view')!;
    expect(meta.hrefBuilder?.({ path: '/lobby' })).toBe('/lobby');
    expect(meta.hrefBuilder?.({ path: '/game/uuid-123' }))
      .toBe('/game/uuid-123');
  });

  it('page_view без path → null', () => {
    expect(findEventMeta('page_view')?.hrefBuilder?.({})).toBeNull();
    expect(findEventMeta('page_view')?.hrefBuilder?.({ path: '' })).toBeNull();
  });
});

describe('hrefBuilder — guard от не-string payload', () => {
  it('payload.game_id не string → null (защита от мусора в БД)', () => {
    const meta = findEventMeta('game_end')!;
    expect(meta.hrefBuilder?.({ game_id: null as unknown as string })).toBeNull();
    expect(meta.hrefBuilder?.({ game_id: 42 as unknown as string })).toBeNull();
    expect(meta.hrefBuilder?.({ game_id: {} as unknown as string })).toBeNull();
  });
});

describe('hint/session/guest/other — без href по умолчанию', () => {
  const noHref = ['hint_shown', 'hint_acted', 'hint_used',
    'session_idle', 'session_start',
    'guest_landing_viewed', 'guest_play_attempted',
    'feature_used', 'no_lives',
    'engine_started'];
  for (const type of noHref) {
    it(`${type} не имеет hrefBuilder`, () => {
      expect(findEventMeta(type)?.hrefBuilder, type).toBeUndefined();
    });
  }
});
