import { UserPreferencesController } from './user-preferences.controller';
import { UserPreferencesService } from './user-preferences.service';
import type { ArchiveFilters } from '@kingside/shared';

describe('UserPreferencesController', () => {
  function build(
    serviceOverrides: Partial<{
      getArchiveFilters: jest.Mock;
      saveArchiveFilters: jest.Mock;
    }> = {},
  ) {
    const service: UserPreferencesService = {
      getArchiveFilters:
        serviceOverrides.getArchiveFilters ??
        jest.fn().mockResolvedValue({}),
      saveArchiveFilters:
        serviceOverrides.saveArchiveFilters ??
        jest.fn().mockResolvedValue({}),
    } as unknown as UserPreferencesService;

    const controller = new UserPreferencesController(service);
    const fakeReq = { user: { id: 'user-uuid-1' } } as never;
    return { controller, service, fakeReq };
  }

  describe('GET archive-filters', () => {
    it('возвращает { filters: {} } если нет сохранённых', async () => {
      const { controller, fakeReq } = build({
        getArchiveFilters: jest.fn().mockResolvedValue({}),
      });
      const res = await controller.getArchiveFilters(fakeReq);
      expect(res).toEqual({ filters: {} });
    });

    it('возвращает сохранённые фильтры', async () => {
      const saved: ArchiveFilters = { player: 'Carlsen', minElo: 2700 };
      const { controller, fakeReq } = build({
        getArchiveFilters: jest.fn().mockResolvedValue(saved),
      });
      const res = await controller.getArchiveFilters(fakeReq);
      expect(res).toEqual({ filters: saved });
    });

    it('делегирует userId из JWT', async () => {
      const getMock = jest.fn().mockResolvedValue({});
      const { controller, fakeReq } = build({ getArchiveFilters: getMock });
      await controller.getArchiveFilters(fakeReq);
      expect(getMock).toHaveBeenCalledWith('user-uuid-1');
    });
  });

  describe('PUT archive-filters', () => {
    it('сохраняет фильтры и возвращает их', async () => {
      const filters: ArchiveFilters = { player: 'Nakamura', sort: 'recent' };
      const { controller, fakeReq } = build({
        saveArchiveFilters: jest.fn().mockResolvedValue(filters),
      });
      const res = await controller.saveArchiveFilters(fakeReq, filters as never);
      expect(res).toEqual({ filters });
    });

    it('делегирует userId + dto в сервис', async () => {
      const saveMock = jest.fn().mockResolvedValue({});
      const { controller, fakeReq } = build({ saveArchiveFilters: saveMock });
      const dto = { player: 'Firouzja', eco: 'B20' };
      await controller.saveArchiveFilters(fakeReq, dto as never);
      expect(saveMock).toHaveBeenCalledWith('user-uuid-1', dto);
    });

    it('пустой body → пустые фильтры', async () => {
      const saveMock = jest.fn().mockResolvedValue({});
      const { controller, fakeReq } = build({ saveArchiveFilters: saveMock });
      await controller.saveArchiveFilters(fakeReq, {} as never);
      expect(saveMock).toHaveBeenCalledWith('user-uuid-1', {});
    });
  });
});

describe('UserPreferencesService (unit)', () => {
  function buildService(
    prismaOverrides: Record<string, unknown> = {},
  ) {
    const { UserPreferencesService: Svc } =
      jest.requireActual<typeof import('./user-preferences.service')>(
        './user-preferences.service',
      );

    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        ...((prismaOverrides as { user?: unknown }).user ?? {}),
      },
    };

    const svc = new Svc(prisma as never);
    return { svc, prisma };
  }

  it('getArchiveFilters → {} если пользователь не найден', async () => {
    const { svc } = buildService();
    const res = await svc.getArchiveFilters('uid-1');
    expect(res).toEqual({});
  });

  it('getArchiveFilters → {} если archiveFilters=null', async () => {
    const { svc } = buildService({
      user: {
        findUnique: jest.fn().mockResolvedValue({ archiveFilters: null }),
      },
    });
    const res = await svc.getArchiveFilters('uid-1');
    expect(res).toEqual({});
  });

  it('getArchiveFilters → сохранённый объект', async () => {
    const stored: ArchiveFilters = { player: 'Anand', sort: 'topElo' };
    const { svc } = buildService({
      user: {
        findUnique: jest.fn().mockResolvedValue({ archiveFilters: stored }),
      },
    });
    const res = await svc.getArchiveFilters('uid-1');
    expect(res).toEqual(stored);
  });

  it('saveArchiveFilters вызывает prisma.user.update с правильными данными', async () => {
    const updateMock = jest.fn().mockResolvedValue({});
    const { svc } = buildService({
      user: { findUnique: jest.fn(), update: updateMock },
    });
    const dto = { player: 'Giri', minElo: 2600 };
    await svc.saveArchiveFilters('uid-1', dto as never);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'uid-1' },
      data: { archiveFilters: { player: 'Giri', minElo: 2600 } },
    });
  });

  it('saveArchiveFilters пропускает undefined, но оставляет null', async () => {
    const updateMock = jest.fn().mockResolvedValue({});
    const { svc } = buildService({
      user: { findUnique: jest.fn(), update: updateMock },
    });
    // player=null (явный сброс), event=undefined (не передан)
    const dto = { player: null, event: undefined, eco: 'A00' };
    await svc.saveArchiveFilters('uid-1', dto as never);
    const saved = updateMock.mock.calls[0][0].data.archiveFilters;
    expect(saved).toEqual({ player: null, eco: 'A00' });
    expect('event' in saved).toBe(false);
  });
});
