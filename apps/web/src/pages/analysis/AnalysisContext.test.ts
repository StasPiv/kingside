import { describe, it, expect } from 'vitest';

import { resolveAnalysisContext } from './AnalysisContext';

/**
 * KS-2867 (ADR-060 §3.1 FR4) — pure resolver. Хук тестируется через
 * AnalysisPage.test.tsx (там есть рабочая среда react-router).
 */

describe('resolveAnalysisContext (KS-2867)', () => {
  describe('review (route /games/:gameId)', () => {
    it('возвращает kind=review с gameId', () => {
      const ctx = resolveAnalysisContext({
        params: { gameId: 'g-123' },
        state: null,
        search: '',
      });
      expect(ctx.kind).toBe('review');
      if (ctx.kind === 'review') {
        expect(ctx.gameId).toBe('g-123');
        expect(ctx.readOnly).toBe(false);
      }
    });

    it('publicMode → readOnly=true', () => {
      const ctx = resolveAnalysisContext({
        params: { gameId: 'g-123' },
        state: null,
        search: '',
        publicMode: true,
      });
      expect(ctx.readOnly).toBe(true);
    });
  });

  describe('analysis (route /analysis/:id)', () => {
    it('возвращает kind=analysis с analysisId', () => {
      const ctx = resolveAnalysisContext({
        params: { id: 'a-456' },
        state: null,
        search: '',
      });
      expect(ctx.kind).toBe('analysis');
      if (ctx.kind === 'analysis') {
        expect(ctx.analysisId).toBe('a-456');
        expect(ctx.localId).toBe('a-456');
        expect(ctx.publicMode).toBe(false);
        expect(ctx.readOnly).toBe(false);
      }
    });

    it('id=new → analysisId=undefined', () => {
      const ctx = resolveAnalysisContext({
        params: { id: 'new' },
        state: null,
        search: '',
      });
      expect(ctx.kind).toBe('analysis');
      if (ctx.kind === 'analysis') {
        expect(ctx.analysisId).toBeUndefined();
      }
    });

    it('state.localId переопределяет id', () => {
      const ctx = resolveAnalysisContext({
        params: { id: 'a-456' },
        state: { localId: 'local-xyz' },
        search: '',
      });
      if (ctx.kind === 'analysis') {
        expect(ctx.localId).toBe('local-xyz');
        expect(ctx.analysisId).toBe('a-456');
      }
    });

    it('publicMode → readOnly=true', () => {
      const ctx = resolveAnalysisContext({
        params: { id: 'a-456' },
        state: null,
        search: '',
        publicMode: true,
      });
      if (ctx.kind === 'analysis') {
        expect(ctx.publicMode).toBe(true);
        expect(ctx.readOnly).toBe(true);
      }
    });

    it('даже когда есть ?fen=... — analysis-route выигрывает', () => {
      const ctx = resolveAnalysisContext({
        params: { id: 'a-456' },
        state: null,
        search: '?fen=rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR%20w%20KQkq%20-%200%201',
      });
      expect(ctx.kind).toBe('analysis');
    });
  });

  describe('puzzle (route /analysis с ?fen=)', () => {
    it('возвращает kind=puzzle с fen из URL', () => {
      const ctx = resolveAnalysisContext({
        params: {},
        state: null,
        search: '?fen=8/8/8/8/8/8/8/4K2k%20w%20-%20-%200%201&side=white',
      });
      expect(ctx.kind).toBe('puzzle');
      if (ctx.kind === 'puzzle') {
        expect(ctx.fen).toBe('8/8/8/8/8/8/8/4K2k w - - 0 1');
        expect(ctx.side).toBe('white');
        expect(ctx.readOnly).toBe(false);
      }
    });

    it('fen из state.puzzleFen имеет приоритет над URL', () => {
      const ctx = resolveAnalysisContext({
        params: {},
        state: { puzzleFen: 'state-fen', puzzlePgn: 'state-pgn' },
        search: '?fen=url-fen&pgn=url-pgn',
      });
      if (ctx.kind === 'puzzle') {
        expect(ctx.fen).toBe('state-fen');
        expect(ctx.pgn).toBe('state-pgn');
      }
    });

    it('moves и side читаются из URL', () => {
      const ctx = resolveAnalysisContext({
        params: {},
        state: null,
        search: '?fen=fen-x&moves=e2e4%20e7e5&side=black',
      });
      if (ctx.kind === 'puzzle') {
        expect(ctx.moves).toBe('e2e4 e7e5');
        expect(ctx.side).toBe('black');
      }
    });

    it('некорректный side → undefined', () => {
      const ctx = resolveAnalysisContext({
        params: {},
        state: null,
        search: '?fen=x&side=red',
      });
      if (ctx.kind === 'puzzle') {
        expect(ctx.side).toBeUndefined();
      }
    });
  });

  describe('fresh analysis (route /analysis без id и без ?fen=)', () => {
    it('возвращает kind=analysis без analysisId', () => {
      const ctx = resolveAnalysisContext({
        params: {},
        state: null,
        search: '',
      });
      expect(ctx.kind).toBe('analysis');
      if (ctx.kind === 'analysis') {
        expect(ctx.analysisId).toBeUndefined();
        expect(ctx.localId).toBeUndefined();
      }
    });

    it('state.localId сохраняется', () => {
      const ctx = resolveAnalysisContext({
        params: {},
        state: { localId: 'l-1' },
        search: '',
      });
      if (ctx.kind === 'analysis') {
        expect(ctx.localId).toBe('l-1');
      }
    });
  });

  describe('study (route /studies/:slug/:chapterId или /studies/c/:chapterId)', () => {
    it('slug + chapterId → kind=study, mode=editor, readOnly=false', () => {
      const ctx = resolveAnalysisContext({
        params: { slug: 'my-study', chapterId: 'ch-1' },
        state: null,
        search: '',
      });
      expect(ctx.kind).toBe('study');
      if (ctx.kind === 'study') {
        expect(ctx.slug).toBe('my-study');
        expect(ctx.chapterId).toBe('ch-1');
        expect(ctx.mode).toBe('editor');
        expect(ctx.readOnly).toBe(false);
      }
    });

    it('только chapterId (public-роут) → mode=public-readonly, readOnly=true', () => {
      const ctx = resolveAnalysisContext({
        params: { chapterId: 'ch-2' },
        state: null,
        search: '',
      });
      if (ctx.kind === 'study') {
        expect(ctx.slug).toBe('');
        expect(ctx.mode).toBe('public-readonly');
        expect(ctx.readOnly).toBe(true);
      }
    });

    it('явный studyMode=embed → readOnly=true', () => {
      const ctx = resolveAnalysisContext({
        params: { slug: 's', chapterId: 'c' },
        state: null,
        search: '',
        studyMode: 'embed',
      });
      if (ctx.kind === 'study') {
        expect(ctx.mode).toBe('embed');
        expect(ctx.readOnly).toBe(true);
      }
    });

    it('явный studyMode=editor при только chapterId — readOnly=false', () => {
      const ctx = resolveAnalysisContext({
        params: { chapterId: 'c' },
        state: null,
        search: '',
        studyMode: 'editor',
      });
      if (ctx.kind === 'study') {
        expect(ctx.readOnly).toBe(false);
      }
    });
  });

  describe('приоритет веток', () => {
    it('study (chapterId) > review (gameId) > analysis (id) > puzzle', () => {
      // Все параметры одновременно — выигрывает study.
      const ctx = resolveAnalysisContext({
        params: {
          chapterId: 'ch',
          gameId: 'g',
          id: 'a',
          slug: 's',
        },
        state: null,
        search: '?fen=x',
      });
      expect(ctx.kind).toBe('study');
    });

    it('review > analysis (id) > puzzle когда нет chapterId', () => {
      const ctx = resolveAnalysisContext({
        params: { gameId: 'g', id: 'a' },
        state: null,
        search: '?fen=x',
      });
      expect(ctx.kind).toBe('review');
    });

    it('analysis > puzzle когда есть id', () => {
      const ctx = resolveAnalysisContext({
        params: { id: 'a' },
        state: null,
        search: '?fen=x',
      });
      expect(ctx.kind).toBe('analysis');
    });
  });
});
