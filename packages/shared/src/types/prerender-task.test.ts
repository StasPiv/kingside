import { describe, it, expect } from 'vitest';
import {
  isPrerenderTask,
  resolvePrerenderRoute,
  type PrerenderTask,
} from './prerender-task.js';

const base = 'https://kingside.site';

describe('resolvePrerenderRoute', () => {
  it('broadcast только tid → /broadcasts/:tid + broadcasts/<tid>.html', () => {
    expect(
      resolvePrerenderRoute({ kind: 'broadcast', tid: 'abc' }, base),
    ).toEqual({
      url: 'https://kingside.site/broadcasts/abc',
      s3Key: 'broadcasts/abc.html',
    });
  });

  it('broadcast tid+rid+gid → ключ детализируется по самому глубокому уровню', () => {
    expect(
      resolvePrerenderRoute(
        { kind: 'broadcast', tid: 't1', rid: 'r2', gid: 'g3' },
        base,
      ),
    ).toEqual({
      url: 'https://kingside.site/broadcasts/t1/r2/g3',
      s3Key: 'broadcasts/t1/r2/g3.html',
    });
  });

  it('tournament', () => {
    expect(
      resolvePrerenderRoute({ kind: 'tournament', id: 'tn1' }, base),
    ).toEqual({
      url: 'https://kingside.site/tournaments/tn1',
      s3Key: 'tournaments/tn1.html',
    });
  });

  it('coach (KS-4232: single /coach/, не /coaches/)', () => {
    expect(
      resolvePrerenderRoute({ kind: 'coach', username: 'alice' }, base),
    ).toEqual({
      url: 'https://kingside.site/coach/alice',
      s3Key: 'coach/alice.html',
    });
  });

  it('lecture', () => {
    expect(
      resolvePrerenderRoute({ kind: 'lecture', id: 'lec1' }, base),
    ).toEqual({
      url: 'https://kingside.site/lectures/lec1',
      s3Key: 'lectures/lec1.html',
    });
  });

  it('player (KS-4232: single /player/, не /players/)', () => {
    expect(
      resolvePrerenderRoute({ kind: 'player', username: 'bob' }, base),
    ).toEqual({
      url: 'https://kingside.site/player/bob',
      s3Key: 'player/bob.html',
    });
  });

  it('archive-game', () => {
    expect(
      resolvePrerenderRoute({ kind: 'archive-game', id: 'ag1' }, base),
    ).toEqual({
      url: 'https://kingside.site/archive/games/ag1',
      s3Key: 'archive/games/ag1.html',
    });
  });

  it('archive-player', () => {
    expect(
      resolvePrerenderRoute(
        { kind: 'archive-player', slug: 'carlsen' },
        base,
      ),
    ).toEqual({
      url: 'https://kingside.site/archive/players/carlsen',
      s3Key: 'archive/players/carlsen.html',
    });
  });

  it('analysis-public (KS-4253)', () => {
    expect(
      resolvePrerenderRoute(
        { kind: 'analysis-public', id: 'a-uuid' },
        base,
      ),
    ).toEqual({
      url: 'https://kingside.site/analysis/public/a-uuid',
      s3Key: 'analysis/public/a-uuid.html',
    });
  });

  it('list: каждая route в namespace list/*.html', () => {
    expect(
      resolvePrerenderRoute({ kind: 'list', route: '/broadcasts' }, base),
    ).toEqual({
      url: 'https://kingside.site/broadcasts',
      s3Key: 'list/broadcasts.html',
    });
    expect(
      resolvePrerenderRoute({ kind: 'list', route: '/archive' }, base),
    ).toEqual({
      url: 'https://kingside.site/archive',
      s3Key: 'list/archive.html',
    });
  });

  it('baseUrl с trailing-slash зачищается', () => {
    expect(
      resolvePrerenderRoute(
        { kind: 'tournament', id: 't' },
        'https://kingside.site/',
      ),
    ).toEqual({
      url: 'https://kingside.site/tournaments/t',
      s3Key: 'tournaments/t.html',
    });
  });
});

describe('isPrerenderTask', () => {
  const valid: PrerenderTask[] = [
    { kind: 'broadcast', tid: 't' },
    { kind: 'broadcast', tid: 't', rid: 'r' },
    { kind: 'broadcast', tid: 't', rid: 'r', gid: 'g' },
    { kind: 'tournament', id: 'x' },
    { kind: 'coach', username: 'u' },
    { kind: 'lecture', id: 'x' },
    { kind: 'player', username: 'u' },
    { kind: 'archive-game', id: 'x' },
    { kind: 'archive-player', slug: 's' },
    { kind: 'analysis-public', id: 'x' },
    { kind: 'list', route: '/broadcasts' },
    { kind: 'list', route: '/archive' },
  ];

  for (const task of valid) {
    it(`принимает валидное ${task.kind}`, () => {
      expect(isPrerenderTask(task)).toBe(true);
    });
  }

  const invalid: unknown[] = [
    null,
    undefined,
    'string',
    42,
    {},
    { kind: 'unknown' },
    { kind: 'tournament' },
    { kind: 'tournament', id: '' },
    { kind: 'tournament', id: 42 },
    { kind: 'broadcast' },
    { kind: 'broadcast', tid: 't', rid: 42 },
    { kind: 'list', route: '/unknown' },
    { kind: 'archive-player', slug: 0 },
  ];

  for (let i = 0; i < invalid.length; i++) {
    it(`отвергает мусор #${i}`, () => {
      expect(isPrerenderTask(invalid[i])).toBe(false);
    });
  }
});
