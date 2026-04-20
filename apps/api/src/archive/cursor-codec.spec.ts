import {
  decodeCursor,
  encodeCursor,
  isRecentCursor,
  isTopEloCursor,
  type RecentCursor,
  type TopEloCursor,
} from './cursor-codec';

describe('cursor-codec', () => {
  it('round-trips a recent cursor', () => {
    const c: RecentCursor = {
      t: '2025-03-01T12:00:00.000Z',
      g: '11111111-2222-3333-4444-555555555555',
    };
    const enc = encodeCursor(c);
    expect(typeof enc).toBe('string');
    expect(enc.length).toBeGreaterThan(0);

    const dec = decodeCursor(enc);
    expect(dec).toEqual(c);
    expect(isRecentCursor(dec)).toBe(true);
    expect(isTopEloCursor(dec)).toBe(false);
  });

  it('round-trips a topElo cursor', () => {
    const c: TopEloCursor = {
      e: 2700,
      g: '00000000-0000-0000-0000-000000000001',
    };
    const enc = encodeCursor(c);
    const dec = decodeCursor(enc);
    expect(dec).toEqual(c);
    expect(isTopEloCursor(dec)).toBe(true);
    expect(isRecentCursor(dec)).toBe(false);
  });

  it('preserves null time/elo (NULLS LAST block)', () => {
    const r: RecentCursor = { t: null, g: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
    expect(decodeCursor(encodeCursor(r))).toEqual(r);

    const e: TopEloCursor = { e: null, g: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
    expect(decodeCursor(encodeCursor(e))).toEqual(e);
  });

  it('returns null for empty / malformed input', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('not-base64!!')).toBeNull();
    // base64 of non-JSON text
    expect(decodeCursor(Buffer.from('hello', 'utf8').toString('base64url'))).toBeNull();
  });
});
