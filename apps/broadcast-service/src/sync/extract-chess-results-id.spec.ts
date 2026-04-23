import { extractChessResultsTournamentId } from './extract-chess-results-id';

/**
 * KS-1735 — спека на pure-функцию извлечения chess-results tournament-id
 * из `Broadcast.standingsUrl`. Используется в `BroadcastSyncService.upsertBroadcast`.
 */
describe('extractChessResultsTournamentId', () => {
  describe('matched (URL chess-results.com)', () => {
    it('базовый URL chess-results.com → id извлечён', () => {
      const r = extractChessResultsTournamentId(
        'https://chess-results.com/tnr1394105.aspx',
      );
      expect(r).toEqual({
        tournamentId: '1394105',
        status: 'matched',
        host: null,
      });
    });

    it('s1.chess-results.com (субдомен балансировки) → matched', () => {
      const r = extractChessResultsTournamentId(
        'https://s1.chess-results.com/tnr1396652.aspx?art=0',
      );
      expect(r).toEqual({
        tournamentId: '1396652',
        status: 'matched',
        host: null,
      });
    });

    it('s2.chess-results.com → matched', () => {
      const r = extractChessResultsTournamentId(
        'https://s2.chess-results.com/tnr999.aspx',
      );
      expect(r.status).toBe('matched');
      expect(r.tournamentId).toBe('999');
    });

    it('http (не https) → matched (схема не важна)', () => {
      const r = extractChessResultsTournamentId(
        'http://chess-results.com/tnr12345.aspx',
      );
      expect(r.status).toBe('matched');
      expect(r.tournamentId).toBe('12345');
    });

    it('hostname в верхнем регистре → matched (case-insensitive)', () => {
      const r = extractChessResultsTournamentId(
        'https://CHESS-RESULTS.COM/tnr111.aspx',
      );
      expect(r.status).toBe('matched');
      expect(r.tournamentId).toBe('111');
    });

    it('путь `.ASPX` в верхнем регистре → matched', () => {
      const r = extractChessResultsTournamentId(
        'https://chess-results.com/TNR42.ASPX',
      );
      expect(r.status).toBe('matched');
      expect(r.tournamentId).toBe('42');
    });

    it('URL с query и fragment → matched, id чистый', () => {
      const r = extractChessResultsTournamentId(
        'https://chess-results.com/tnr800000.aspx?lan=1&art=4#players',
      );
      expect(r).toEqual({
        tournamentId: '800000',
        status: 'matched',
        host: null,
      });
    });
  });

  describe('unsupported (другой домен)', () => {
    it('ergebnisdienst.schachbund.de → unsupported, host опубликован', () => {
      const r = extractChessResultsTournamentId(
        'https://ergebnisdienst.schachbund.de/saison/2024-25/standings.html',
      );
      expect(r).toEqual({
        tournamentId: null,
        status: 'unsupported',
        host: 'ergebnisdienst.schachbund.de',
      });
    });

    it('www-префикс снимается из host (нормализация для метрики)', () => {
      const r = extractChessResultsTournamentId(
        'https://www.example.org/tournaments/abc',
      );
      expect(r.status).toBe('unsupported');
      expect(r.host).toBe('example.org');
    });

    it('host в верхнем регистре нормализуется в нижний', () => {
      const r = extractChessResultsTournamentId(
        'https://Example.ORG/foo',
      );
      expect(r.host).toBe('example.org');
    });

    it('не повторяет chess-results host для дочерних доменов "chess-results.com.evil.io"', () => {
      // Защита от поддельного хоста: `chess-results.com.evil.io` НЕ должен
      // считаться chess-results — иначе любой может опубликовать `tnrID`
      // под своим контролем и подсунуть нам левый id.
      const r = extractChessResultsTournamentId(
        'https://chess-results.com.evil.io/tnr1.aspx',
      );
      expect(r.status).toBe('unsupported');
      expect(r.host).toBe('chess-results.com.evil.io');
    });
  });

  describe('missing (URL пустой/невалидный)', () => {
    it('null → missing', () => {
      expect(extractChessResultsTournamentId(null)).toEqual({
        tournamentId: null,
        status: 'missing',
        host: null,
      });
    });

    it('undefined → missing', () => {
      expect(extractChessResultsTournamentId(undefined)).toEqual({
        tournamentId: null,
        status: 'missing',
        host: null,
      });
    });

    it('"" → missing', () => {
      expect(extractChessResultsTournamentId('')).toEqual({
        tournamentId: null,
        status: 'missing',
        host: null,
      });
    });

    it('"   " (whitespace only) → missing', () => {
      expect(extractChessResultsTournamentId('   ')).toEqual({
        tournamentId: null,
        status: 'missing',
        host: null,
      });
    });

    it('невалидный URL ("not a url") → missing (не unsupported, нет hostname)', () => {
      const r = extractChessResultsTournamentId('not a url');
      expect(r.status).toBe('missing');
      expect(r.host).toBeNull();
    });
  });

  describe('chess-results host без tnrID-пути', () => {
    it('главная страница chess-results.com → missing (не unsupported)', () => {
      // chess-results-домен корректный, но id извлечь нечего.
      // Не считаем `unsupported` — иначе chess-results.com засорит
      // dashboard `unsupported_source_total{host="chess-results.com"}`,
      // что сбивает с толку при анализе.
      const r = extractChessResultsTournamentId('https://chess-results.com/');
      expect(r).toEqual({
        tournamentId: null,
        status: 'missing',
        host: null,
      });
    });

    it('какой-то другой раздел chess-results → missing', () => {
      const r = extractChessResultsTournamentId(
        'https://chess-results.com/SomeOtherPage.aspx',
      );
      expect(r.status).toBe('missing');
      expect(r.host).toBeNull();
    });

    it('опечатка в path "tournament" вместо "tnr" → missing', () => {
      const r = extractChessResultsTournamentId(
        'https://chess-results.com/tournament123.aspx',
      );
      expect(r.status).toBe('missing');
    });
  });
});
