/**
 * KS-1690 e2e regression — все read-эндпоинты archive-controller отдают
 * `Cache-Control: no-cache, must-revalidate` и не ломают ETag/304.
 *
 * Без явного `Cache-Control` Express-приложение оставляет заголовок
 * пустым, и браузер применяет heuristic freshness (RFC 7234 §4.2.2) —
 * может кэшировать ответ неопределённое время. KS-1689 показал это как
 * stale-бейдж «based on N games» при другом значении totalGames в БД.
 *
 * Спек поднимает Nest-app с mock-ом `ArchiveService` (реальный
 * Prisma/Redis не нужен) и проходит по всем публичным GET через
 * supertest.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import type {
  ArchiveEventSearchResponse,
  ArchiveGameDetail,
  ArchiveGamesByPositionResponse,
  ArchiveGamesResponse,
  ArchivePlayerGamesResponse,
  ArchivePlayerProfileResponse,
  ArchivePlayerSearchResponse,
  ArchiveTreeResponse,
} from '@kingside/shared';
import { ArchiveController } from './archive.controller';
import { ArchiveService } from './archive.service';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const EXPECTED_CACHE_CONTROL = 'no-cache, must-revalidate';

const fakeTree: ArchiveTreeResponse = {
  fen: START_FEN,
  positionKey: 'bed6f817f1cd7bddd820b5a588e7cf9b',
  totalGames: 10048,
  moves: [],
  opening: null,
};

const fakeGames: ArchiveGamesResponse = {
  total: 0,
  items: [],
};

const fakeGamesByPosition: ArchiveGamesByPositionResponse = {
  fen: START_FEN,
  positionKey: 'bed6f817f1cd7bddd820b5a588e7cf9b',
  bucket: 'master',
  sort: 'recent',
  items: [],
  nextCursor: null,
  hasMore: false,
  totalApprox: 10048,
};

const fakeGameDetail: ArchiveGameDetail = {
  id: '00000000-0000-0000-0000-000000000001',
  white: { name: 'W', slug: 'w', elo: 2500, title: 'GM' },
  black: { name: 'B', slug: 'b', elo: 2500, title: 'GM' },
  result: '1-0',
  eco: 'C20',
  opening: null,
  event: null,
  date: null,
  plyCount: 40,
  pgn: '1. e4 e5',
  site: null,
  round: null,
};

const fakePlayerSearch: ArchivePlayerSearchResponse = { total: 0, items: [] };
const fakePlayerProfile: ArchivePlayerProfileResponse = {
  name: 'Carlsen, Magnus',
  slug: 'carlsen-magnus',
  gamesCount: 1234,
  peakElo: 2882,
  byColor: { white: 700, black: 534 },
  byResult: { wins: 600, draws: 500, losses: 134 },
  firstSeenAt: '2010-01-01T00:00:00.000Z',
  lastSeenAt: '2026-04-01T00:00:00.000Z',
};
const fakePlayerGames: ArchivePlayerGamesResponse = { total: 0, items: [] };
const fakeEventSearch: ArchiveEventSearchResponse = { total: 0, items: [] };

const mockService = {
  getTree: jest.fn().mockResolvedValue(fakeTree),
  getGames: jest.fn().mockResolvedValue(fakeGames),
  getGamesByPosition: jest.fn().mockResolvedValue(fakeGamesByPosition),
  getGameById: jest.fn().mockResolvedValue(fakeGameDetail),
  searchPlayers: jest.fn().mockResolvedValue(fakePlayerSearch),
  getPlayerProfile: jest.fn().mockResolvedValue(fakePlayerProfile),
  getPlayerGames: jest.fn().mockResolvedValue(fakePlayerGames),
  searchEvents: jest.fn().mockResolvedValue(fakeEventSearch),
};

describe('archive controller — Cache-Control headers (KS-1690)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ArchiveController],
      providers: [{ provide: ArchiveService, useValue: mockService }],
    }).compile();

    app = moduleRef.createNestApplication();
    // Тот же ValidationPipe, что и в проде (main.ts) — иначе DTO-биндинг
    // может тихо пропускать невалидные query, и тест был бы невалидной
    // регрессионной защитой.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const routes: Array<{ name: string; url: string }> = [
    {
      name: '/tree',
      url: `/tree?fen=${encodeURIComponent(START_FEN)}&bucket=master`,
    },
    {
      name: '/games',
      url: '/games?limit=10',
    },
    {
      name: '/games/by-position',
      url: `/games/by-position?fen=${encodeURIComponent(START_FEN)}&bucket=master`,
    },
    {
      name: '/games/:id',
      url: '/games/00000000-0000-0000-0000-000000000001',
    },
    {
      name: '/players/search',
      url: '/players/search?q=carlsen&limit=10',
    },
    {
      name: '/players/:slug',
      url: '/players/carlsen-magnus',
    },
    {
      name: '/players/:slug/games',
      url: '/players/carlsen-magnus/games?limit=20',
    },
    {
      name: '/events/search',
      url: '/events/search?q=tata&limit=10',
    },
  ];

  for (const route of routes) {
    it(`${route.name} отвечает 200 с Cache-Control: ${EXPECTED_CACHE_CONTROL}`, async () => {
      const res = await request(app.getHttpServer()).get(route.url).expect(200);
      expect(res.headers['cache-control']).toBe(EXPECTED_CACHE_CONTROL);
    });
  }

  it('/tree сохраняет ETag и обслуживает 304 на If-None-Match (KS-1690 не ломает revalidate)', async () => {
    const first = await request(app.getHttpServer())
      .get(`/tree?fen=${encodeURIComponent(START_FEN)}&bucket=master`)
      .expect(200);

    const etag = first.headers['etag'];
    expect(etag).toBeDefined();
    expect(typeof etag).toBe('string');
    // Express добавляет weak ETag по умолчанию (`W/"..."`).
    expect(etag).toMatch(/^W\/".+"$/);

    const second = await request(app.getHttpServer())
      .get(`/tree?fen=${encodeURIComponent(START_FEN)}&bucket=master`)
      .set('If-None-Match', etag)
      .expect(304);

    // В 304 тело пустое, но Cache-Control по RFC 7232 §4.1 обязан
    // отправляться — проверяем, что директива сохраняется и на
    // revalidation-ответе.
    expect(second.headers['cache-control']).toBe(EXPECTED_CACHE_CONTROL);
  });
});
