/**
 * KS-2182. Тесты `InternalUsersController` (GET synthetic-users +
 * POST synthetic-presence).
 *
 * Покрывает GWT-сценарии:
 *   3. список synthetic-юзеров
 *   4. batch presence на 50 synthetic'ах
 *   5. presence с примесью non-synthetic → 403, ничего не обновлено
 */
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { InternalUsersController } from './internal-users.controller';
import type { PrismaService } from '../prisma/prisma.service';
import type { SyntheticPresenceBatchDto } from './dto/synthetic-presence.dto';

function makeReq(): Request {
  return {
    headers: {},
    ip: '10.0.0.5',
  } as unknown as Request;
}

function uuid(suffix: number): string {
  return `00000000-0000-4000-b000-${String(suffix).padStart(12, '0')}`;
}

describe('InternalUsersController — KS-2182', () => {
  describe('GET /internal/synthetic-users', () => {
    it('GWT-сценарий 3: возвращает только synthetic, с rating-объектом', async () => {
      // Имитируем 200 synthetic-юзеров (как «после v1 они уже есть»).
      const fakeUsers = Array.from({ length: 200 }, (_, i) => ({
        id: uuid(i + 1),
        username: `bot-${String(i + 1).padStart(3, '0')}`,
        ratingBullet: 1500 + i,
        ratingBlitz: 1500 + i,
        ratingRapid: 1500 + i,
        ratingClassical: 1500 + i,
      }));

      const findMany = jest.fn(async (args: { where: any }) => {
        // Эмулируем, что Prisma возвращает только записи с
        // isSynthetic=true и username !== null.
        expect(args.where).toMatchObject({
          isSynthetic: true,
          username: { not: null },
        });
        return fakeUsers;
      });

      const prisma = {
        user: { findMany },
      } as unknown as PrismaService;

      const ctrl = new InternalUsersController(prisma);
      const result = await ctrl.listSyntheticUsers();

      expect(result).toHaveLength(200);
      expect(result[0]).toEqual({
        id: uuid(1),
        username: 'bot-001',
        rating: {
          bullet: 1500,
          blitz: 1500,
          rapid: 1500,
          classical: 1500,
        },
      });
    });

    it('username=null отфильтровывается на TS-уровне (защита от nullable-схемы)', async () => {
      const findMany = jest.fn(async () => [
        { id: uuid(1), username: 'bot-001', ratingBullet: 1500, ratingBlitz: 1500, ratingRapid: 1500, ratingClassical: 1500 },
        { id: uuid(2), username: null, ratingBullet: 1500, ratingBlitz: 1500, ratingRapid: 1500, ratingClassical: 1500 },
      ]);
      const prisma = { user: { findMany } } as unknown as PrismaService;
      const ctrl = new InternalUsersController(prisma);
      const result = await ctrl.listSyntheticUsers();
      expect(result).toHaveLength(1);
      expect(result[0].username).toBe('bot-001');
    });
  });

  describe('POST /internal/synthetic-presence', () => {
    it('GWT-сценарий 4: 50 synthetic → updated=50, lastSeenAt обновлён у всех', async () => {
      const ids = Array.from({ length: 50 }, (_, i) => uuid(i + 1));
      const findMany = jest.fn(async () =>
        ids.map((id) => ({ id, isSynthetic: true })),
      );
      const update = jest.fn(async (args: any) => ({ id: args.where.id }));
      // $transaction([updates...]) — promise-array semantics: мы получаем
      // массив update-promises (см. реализацию контроллера) и должны
      // вернуть массив результатов.
      const transaction = jest.fn(async (promises: Promise<unknown>[]) =>
        Promise.all(promises),
      );
      const prisma = {
        user: { findMany, update },
        $transaction: transaction,
      } as unknown as PrismaService;

      const ctrl = new InternalUsersController(prisma);
      const dto: SyntheticPresenceBatchDto = {
        updates: ids.map((id) => ({
          userId: id,
          lastSeenAt: '2026-04-30T18:00:00.000Z',
        })),
      };
      const result = await ctrl.updateSyntheticPresence(dto, makeReq());

      expect(result).toEqual({ updated: 50 });
      expect(update).toHaveBeenCalledTimes(50);
      // Проверяем, что lastSeenAt пишется как Date.
      expect(update).toHaveBeenLastCalledWith({
        where: { id: ids[49] },
        data: { lastSeenAt: new Date('2026-04-30T18:00:00.000Z') },
        select: { id: true },
      });
    });

    it('GWT-сценарий 5: 49 synthetic + 1 non-synthetic → ForbiddenException, ни одна запись не обновлена', async () => {
      const ids = Array.from({ length: 50 }, (_, i) => uuid(i + 1));
      // Последний — обычный user.
      const findMany = jest.fn(async () =>
        ids.map((id, i) => ({ id, isSynthetic: i !== 49 })),
      );
      const update = jest.fn();
      const transaction = jest.fn();
      const prisma = {
        user: { findMany, update },
        $transaction: transaction,
      } as unknown as PrismaService;

      const ctrl = new InternalUsersController(prisma);
      const dto: SyntheticPresenceBatchDto = {
        updates: ids.map((id) => ({
          userId: id,
          lastSeenAt: '2026-04-30T18:00:00.000Z',
        })),
      };

      await expect(
        ctrl.updateSyntheticPresence(dto, makeReq()),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(update).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });

    it('один из userId не найден в БД → ForbiddenException, ничего не обновлено', async () => {
      const ids = [uuid(1), uuid(2), uuid(3)];
      // findMany возвращает только 2 из 3 (один пропущен).
      const findMany = jest.fn(async () => [
        { id: ids[0], isSynthetic: true },
        { id: ids[1], isSynthetic: true },
      ]);
      const update = jest.fn();
      const transaction = jest.fn();
      const prisma = {
        user: { findMany, update },
        $transaction: transaction,
      } as unknown as PrismaService;

      const ctrl = new InternalUsersController(prisma);
      const dto: SyntheticPresenceBatchDto = {
        updates: ids.map((id) => ({
          userId: id,
          lastSeenAt: '2026-04-30T18:00:00.000Z',
        })),
      };

      await expect(
        ctrl.updateSyntheticPresence(dto, makeReq()),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(update).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });
  });
});
