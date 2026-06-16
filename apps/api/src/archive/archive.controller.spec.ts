/**
 * KS-4247 / ADR-131 A1. Контроллерные тесты для нового
 * `apps/api/src/archive/archive.controller.ts`. Здесь проверяется:
 *   - префикс `/archive` через Reflector;
 *   - порядок объявлений (literal-маршруты `games/by-position` /
 *     `players/search` / `players/:slug/games` зарегистрированы до
 *     соответствующих параметрических `games/:id` / `players/:slug`);
 *   - делегация в `ArchiveService` (вызов проходит).
 *
 * Сложные сценарии БД покрываются `archive.service.spec.ts` (копия из
 * apps/archive-service).
 */

import { Test } from '@nestjs/testing';
import { ArchiveController } from './archive.controller';
import { ArchiveService } from './archive.service';

describe('ArchiveController (KS-4247)', () => {
  const archiveMock = {
    getTree: jest.fn().mockResolvedValue({ items: [] }),
    getGames: jest.fn().mockResolvedValue({ items: [] }),
    getGameById: jest.fn().mockResolvedValue({ id: 'x', pgn: 'pgn' }),
    getGamesByPosition: jest
      .fn()
      .mockResolvedValue({ items: [], hasMore: false }),
    searchPlayers: jest.fn().mockResolvedValue({ items: [] }),
    getPlayerProfile: jest.fn().mockResolvedValue({ slug: 'x' }),
    getPlayerGames: jest.fn().mockResolvedValue({ items: [] }),
    searchEvents: jest.fn().mockResolvedValue({ items: [] }),
  };

  let controller: ArchiveController;

  beforeEach(async () => {
    Object.values(archiveMock).forEach((m) => m.mockClear?.());
    const mod = await Test.createTestingModule({
      controllers: [ArchiveController],
      providers: [
        { provide: ArchiveService, useValue: archiveMock },
      ],
    }).compile();
    controller = mod.get(ArchiveController);
  });

  it('@Controller имеет префикс "archive"', () => {
    const prefix = Reflect.getMetadata('path', ArchiveController);
    expect(prefix).toBe('archive');
  });

  it('getTree делегирует в ArchiveService.getTree', async () => {
    const q = { fen: 'startpos' } as never;
    await controller.getTree(q);
    expect(archiveMock.getTree).toHaveBeenCalledWith(q);
  });

  it('getGames делегирует в ArchiveService.getGames', async () => {
    const q = { limit: 10 } as never;
    await controller.getGames(q);
    expect(archiveMock.getGames).toHaveBeenCalledWith(q);
  });

  it('getGame делегирует getGameById с id из @Param', async () => {
    await controller.getGame('game-id');
    expect(archiveMock.getGameById).toHaveBeenCalledWith('game-id');
  });

  it('getGamesByPosition делегирует getGamesByPosition с query', async () => {
    const q = { fen: 'rnbq' } as never;
    await controller.getGamesByPosition(q);
    expect(archiveMock.getGamesByPosition).toHaveBeenCalledWith(q);
  });

  it('searchPlayers / getPlayerProfile / getPlayerGames / searchEvents — делегируют', async () => {
    const psq = { q: 'magnus' } as never;
    await controller.searchPlayers(psq);
    expect(archiveMock.searchPlayers).toHaveBeenCalledWith(psq);

    await controller.getPlayerProfile('carlsen');
    expect(archiveMock.getPlayerProfile).toHaveBeenCalledWith('carlsen');

    const pgq = { limit: 5 } as never;
    await controller.getPlayerGames('carlsen', pgq);
    expect(archiveMock.getPlayerGames).toHaveBeenCalledWith('carlsen', pgq);

    const evq = { q: 'world championship' } as never;
    await controller.searchEvents(evq);
    expect(archiveMock.searchEvents).toHaveBeenCalledWith(evq);
  });

  it('порядок методов: literal-маршруты идут до параметрических', () => {
    // KS-4247 / ADR-131: NestJS RouterExplorer регистрирует routes в
    // порядке объявления — `games/by-position` ДО `games/:id`, иначе
    // `by-position` уйдёт в `:id`. Аналогично `players/search` ДО
    // `players/:slug` и `players/:slug/games` ДО `players/:slug`.
    const methodNames = Object.getOwnPropertyNames(
      ArchiveController.prototype,
    ).filter((m) => m !== 'constructor');
    expect(methodNames.indexOf('getGamesByPosition')).toBeLessThan(
      methodNames.indexOf('getGame'),
    );
    expect(methodNames.indexOf('searchPlayers')).toBeLessThan(
      methodNames.indexOf('getPlayerProfile'),
    );
    expect(methodNames.indexOf('getPlayerGames')).toBeLessThan(
      methodNames.indexOf('getPlayerProfile'),
    );
  });
});
