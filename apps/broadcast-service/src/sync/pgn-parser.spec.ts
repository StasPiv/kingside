/**
 * KS-3230: регрессионные тесты parsePgnGames на реальных PGN-фикстурах
 * из 5 разных broadcast'ов. Цель — не дать пропустить регрессию вида
 * KS-3229 (один lichessGameId на все партии раунда из-за того, что
 * `[Site]` оказался не URL'ом).
 *
 * Фикстуры лежат в __fixtures__/ (5 broadcast'ов, по 5 партий каждый).
 * Все взяты из реальных Lichess broadcast PGN и охватывают разные
 * варианты заполнения [Site] / [GameURL] header'ов.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  parsePgnGames,
  extractLichessGameId,
  findDuplicateGameIds,
  parseElo,
} from './pgn-parser';

const FIXTURES_DIR = path.join(__dirname, '__fixtures__');

interface Fixture {
  file: string;
  label: string;
  expectedGames: number;
  siteFormat: 'venue' | 'domain' | 'url';
}

const FIXTURES: Fixture[] = [
  {
    file: 'p3ctK4xS_Vos7UzKR.pgn',
    label: 'GCT Romania 2026 (Site=venue, KS-3229 баг-сценарий)',
    expectedGames: 5,
    siteFormat: 'venue',
  },
  {
    file: '7UYcfQYR_RTWSWjS2.pgn',
    label: 'Cherry Blossom 2026 (Site=venue "Sterling, VA, USA")',
    expectedGames: 5,
    siteFormat: 'venue',
  },
  {
    file: 'IcMaEOQ6_iaerhuyL.pgn',
    label: 'Steinitz Open 2026 (Site=domain "idChess.com")',
    expectedGames: 5,
    siteFormat: 'domain',
  },
  {
    file: 'EjNNnI1w_jsaXdPo2.pgn',
    label: 'Buenos Aires Open (Site=URL, старый формат)',
    expectedGames: 5,
    siteFormat: 'url',
  },
  {
    file: 'cza55jXo_EiaC0Sb2.pgn',
    label: '5th Karshi Open (Site=URL, старый формат)',
    expectedGames: 5,
    siteFormat: 'url',
  },
];

describe('KS-3230 parsePgnGames — реальные broadcast-фикстуры', () => {
  describe.each(FIXTURES)('$label', (fx) => {
    let pgn: string;
    let games: ReturnType<typeof parsePgnGames>;

    beforeAll(() => {
      pgn = fs.readFileSync(path.join(FIXTURES_DIR, fx.file), 'utf8');
      games = parsePgnGames(pgn);
    });

    it(`парсит ровно ${fx.expectedGames} партий`, () => {
      expect(games).toHaveLength(fx.expectedGames);
    });

    it('все lichessGameId уникальны (KS-3229 регрессия)', () => {
      const ids = games.map((g) => g.lichessGameId);
      const unique = new Set(ids);
      // Если этот assertion упадёт — значит парсер схлопнул несколько
      // партий на один id, и upsert в processPgnUpdate перезапишет их
      // друг другом. Точно тот же баг, что чинили в KS-3229.
      expect(unique.size).toBe(ids.length);
    });

    it('каждый lichessGameId — не пустая строка', () => {
      for (const g of games) {
        expect(g.lichessGameId).not.toBeNull();
        expect(g.lichessGameId).not.toBe('');
      }
    });

    it('у каждой партии есть white/black/result', () => {
      for (const g of games) {
        expect(g.white).not.toBe('Unknown');
        expect(g.black).not.toBe('Unknown');
        expect(g.result).not.toBe('');
      }
    });

    it('findDuplicateGameIds возвращает пустой массив', () => {
      expect(findDuplicateGameIds(games)).toEqual([]);
    });
  });
});

describe('KS-3230 extractLichessGameId — цепочка fallback', () => {
  it('предпочитает GameURL даже если Site = URL', () => {
    const id = extractLichessGameId({
      GameURL: 'https://lichess.org/broadcast/x/round-1/RID/GAME_FROM_URL',
      Site: 'https://lichess.org/broadcast/x/round-1/RID/GAME_FROM_SITE',
    });
    expect(id).toBe('GAME_FROM_URL');
  });

  it('падает на Site если GameURL отсутствует и Site = URL', () => {
    const id = extractLichessGameId({
      Site: 'https://lichess.org/broadcast/x/round-1/RID/GAME_FROM_SITE',
    });
    expect(id).toBe('GAME_FROM_SITE');
  });

  it('игнорирует Site без слэшей и идёт на pseudo-id из Round (KS-3229)', () => {
    // Точный сценарий Romania: Site = "Bucharest, Romania", без слэшей,
    // без GameURL — id строится из [Round "X.Y"].
    const id = extractLichessGameId({
      Site: 'Bucharest, Romania',
      Round: '1.3',
    });
    expect(id).toBe('round:1.3');
  });

  it('возвращает null если нет ни одного источника', () => {
    expect(extractLichessGameId({})).toBeNull();
  });

  it('Romania-сценарий с GameURL даёт настоящий base62 id (не venue)', () => {
    const id = extractLichessGameId({
      GameURL:
        'https://lichess.org/broadcast/gct-super-chess-classic-romania-2026/round-1/Vos7UzKR/LhpNkgC9',
      Site: 'Bucharest, Romania',
      Round: '1.1',
    });
    expect(id).toBe('LhpNkgC9');
  });
});

describe('KS-3230 findDuplicateGameIds', () => {
  it('пустой массив — нет дублей', () => {
    expect(findDuplicateGameIds([])).toEqual([]);
  });

  it('уникальные id — пустой результат', () => {
    const games = ['a', 'b', 'c'].map((id, i) => ({
      index: i,
      white: 'w',
      black: 'b',
      whiteElo: null,
      blackElo: null,
      result: '*',
      fen: 'fen',
      uci: '',
      pgn: '',
      lichessGameId: id,
      whiteClockMs: null,
      blackClockMs: null,
    }));
    expect(findDuplicateGameIds(games)).toEqual([]);
  });

  it('дубль обнаруживается (исторический баг Romania)', () => {
    const games = ['Bucharest, Romania', 'Bucharest, Romania', 'Bucharest, Romania']
      .map((id, i) => ({
        index: i,
        white: 'w',
        black: 'b',
        whiteElo: null,
        blackElo: null,
        result: '*',
        fen: 'fen',
        uci: '',
        pgn: '',
        lichessGameId: id,
        whiteClockMs: null,
        blackClockMs: null,
      }));
    expect(findDuplicateGameIds(games)).toEqual(['Bucharest, Romania']);
  });

  it('null id не считаются дублями', () => {
    const games = [null, null, 'x'].map((id, i) => ({
      index: i,
      white: 'w',
      black: 'b',
      whiteElo: null,
      blackElo: null,
      result: '*',
      fen: 'fen',
      uci: '',
      pgn: '',
      lichessGameId: id,
      whiteClockMs: null,
      blackClockMs: null,
    }));
    expect(findDuplicateGameIds(games)).toEqual([]);
  });
});

describe('KS-3230 strict-mode integration: parsePgnGames + findDuplicateGameIds', () => {
  it('синтетический regression-PGN (2 партии с одинаковым GameURL) → дубли пойманы', () => {
    // Точная репликация бага KS-3229: два сегмента, у обоих [Site] =
    // одна и та же строка-адрес, [GameURL] отсутствует, [Round] тоже
    // одинаковый. parsePgnGames вернёт обе с одинаковым null-fallback,
    // findDuplicateGameIds — поймает.
    const pgn = `[Event "Test"]
[Site "Bucharest, Romania"]
[Round "1.1"]
[White "A"]
[Black "B"]
[Result "1-0"]

1. e4 e5 1-0

[Event "Test"]
[Site "Bucharest, Romania"]
[Round "1.1"]
[White "C"]
[Black "D"]
[Result "0-1"]

1. d4 d5 0-1`;
    const games = parsePgnGames(pgn);
    expect(games).toHaveLength(2);
    // Оба ID должны быть pseudo-id из Round (одинаковые) — это
    // правильное поведение, defensive fallback. Дальше strict-mode в
    // processPgnUpdate увидит дубль и skip'нёт раунд.
    expect(games[0].lichessGameId).toBe('round:1.1');
    expect(games[1].lichessGameId).toBe('round:1.1');
    expect(findDuplicateGameIds(games)).toEqual(['round:1.1']);
  });

  it('симуляция оригинального KS-3229 бага: Site=venue, нет GameURL и Round → null id', () => {
    // Если ни GameURL, ни Site-URL, ни Round нет, и Site содержит
    // только venue без слэшей — id вообще не определён. Старая логика
    // `site.split('/').pop()` вернула бы саму строку venue и схлопнула
    // партии. Новая — возвращает null, и findDuplicateGameIds
    // молчит (null исключён), но processPgnUpdate всё равно скипнет
    // партию через `if (game.lichessGameId)`.
    const pgn = `[Event "Test"]
[Site "Bucharest, Romania"]
[White "A"]
[Black "B"]
[Result "1-0"]

1. e4 e5 1-0`;
    const games = parsePgnGames(pgn);
    expect(games).toHaveLength(1);
    expect(games[0].lichessGameId).toBeNull();
  });
});

describe('KS-3230 parseElo', () => {
  it.each([
    ['2650', 2650],
    ['  2650  ', 2650],
    ['?', null],
    ['-', null],
    ['', null],
    [undefined, null],
    ['0', null],
    ['5000', null],
    ['abc', null],
  ])('parseElo(%j) → %j', (input, expected) => {
    expect(parseElo(input)).toBe(expected);
  });
});
