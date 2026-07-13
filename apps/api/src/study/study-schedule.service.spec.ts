import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StudyScheduleService } from './study-schedule.service';
import { UpsertStudyScheduleDto } from './dto/upsert-study-schedule.dto';

/**
 * KS-4927 / ADR-163. Unit-тесты CRUD тренировок: лимит 5 тренировок,
 * лимит/валидация слотов, пересечение (день, время) внутри запроса и
 * с чужими слотами, replace-on-write, принадлежность пользователю.
 * Prisma и генератор — ручные моки, БД не нужна.
 */

interface MockPrisma {
  studySchedule: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  studyScheduleSlot: { findMany: jest.Mock; deleteMany: jest.Mock };
  studySession: { deleteMany: jest.Mock };
  $transaction: jest.Mock;
}

function makePrisma(): MockPrisma {
  return {
    studySchedule: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    studyScheduleSlot: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    studySession: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $transaction: jest.fn(),
  };
}

const generator = {
  generateForSchedule: jest
    .fn()
    .mockResolvedValue({ created: 0, outcomes: [] }),
};

function makeService(prisma: MockPrisma): StudyScheduleService {
  return new StudyScheduleService(
    prisma as never,
    generator as never,
  );
}

function scheduleRow(over: Record<string, unknown> = {}) {
  return {
    id: 'sch-1',
    userId: 'user-1',
    name: 'Тактика',
    timezone: 'Europe/Prague',
    sessionMinutes: 30,
    focus: null,
    active: true,
    createdAt: new Date('2026-07-13T00:00:00Z'),
    updatedAt: new Date('2026-07-13T00:00:00Z'),
    slots: [
      {
        id: 'slot-1',
        daysOfWeek: [1, 3],
        timeLocal: '19:00',
        sessionMinutes: null,
        createdAt: new Date('2026-07-13T00:00:00Z'),
      },
    ],
    ...over,
  };
}

function dto(over: Partial<UpsertStudyScheduleDto> = {}): UpsertStudyScheduleDto {
  return {
    name: 'Тактика',
    timezone: 'Europe/Prague',
    slots: [{ daysOfWeek: [1, 3], timeLocal: '19:00' }],
    ...over,
  } as UpsertStudyScheduleDto;
}

describe('StudyScheduleService (KS-4927 / ADR-163)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('создаёт тренировку со слотами и запускает немедленную генерацию', async () => {
      const prisma = makePrisma();
      prisma.studySchedule.create.mockResolvedValue(scheduleRow());
      const svc = makeService(prisma);

      const result = await svc.create('user-1', dto());

      expect(prisma.studySchedule.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            name: 'Тактика',
            slots: {
              create: [
                { daysOfWeek: [1, 3], timeLocal: '19:00', sessionMinutes: null },
              ],
            },
          }),
        }),
      );
      expect(generator.generateForSchedule).toHaveBeenCalled();
      expect(result.slots).toHaveLength(1);
      expect(result.name).toBe('Тактика');
    });

    it('400 при превышении лимита 5 тренировок', async () => {
      const prisma = makePrisma();
      prisma.studySchedule.count.mockResolvedValue(5);
      const svc = makeService(prisma);

      await expect(svc.create('user-1', dto())).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.studySchedule.create).not.toHaveBeenCalled();
    });

    it('400 при пересечении слотов внутри запроса (день+время)', async () => {
      const prisma = makePrisma();
      const svc = makeService(prisma);

      await expect(
        svc.create(
          'user-1',
          dto({
            slots: [
              { daysOfWeek: [1, 2], timeLocal: '19:00' },
              { daysOfWeek: [2, 4], timeLocal: '19:00' }, // день 2 дублируется
            ],
          }),
        ),
      ).rejects.toThrow(/Overlapping slots/);
    });

    it('400 при пересечении со слотом другой тренировки пользователя', async () => {
      const prisma = makePrisma();
      prisma.studyScheduleSlot.findMany.mockResolvedValue([
        {
          daysOfWeek: [3],
          timeLocal: '19:00',
          schedule: { name: 'Эндшпили' },
        },
      ]);
      const svc = makeService(prisma);

      await expect(svc.create('user-1', dto())).rejects.toThrow(
        /already used by training "Эндшпили"/,
      );
    });

    it('одинаковое время в РАЗНЫЕ дни — не пересечение', async () => {
      const prisma = makePrisma();
      prisma.studyScheduleSlot.findMany.mockResolvedValue([
        { daysOfWeek: [0, 6], timeLocal: '19:00', schedule: { name: 'B' } },
      ]);
      prisma.studySchedule.create.mockResolvedValue(scheduleRow());
      const svc = makeService(prisma);

      await expect(svc.create('user-1', dto())).resolves.toBeDefined();
    });

    it('дедуплицирует и сортирует дни слота', async () => {
      const prisma = makePrisma();
      prisma.studySchedule.create.mockResolvedValue(scheduleRow());
      const svc = makeService(prisma);

      await svc.create(
        'user-1',
        dto({ slots: [{ daysOfWeek: [5, 1, 5, 3], timeLocal: '08:30' }] }),
      );

      expect(prisma.studySchedule.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            slots: {
              create: [
                {
                  daysOfWeek: [1, 3, 5],
                  timeLocal: '08:30',
                  sessionMinutes: null,
                },
              ],
            },
          }),
        }),
      );
    });

    it('400 на неизвестную IANA-таймзону', async () => {
      const svc = makeService(makePrisma());
      await expect(
        svc.create('user-1', dto({ timezone: 'Mars/Olympus' })),
      ).rejects.toThrow(/Unknown IANA timezone/);
    });
  });

  describe('update', () => {
    it('404 на чужую/несуществующую тренировку', async () => {
      const prisma = makePrisma();
      prisma.studySchedule.findFirst.mockResolvedValue(null);
      const svc = makeService(prisma);

      await expect(svc.update('user-1', 'sch-x', dto())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('replace-on-write: старые слоты удаляются, новые создаются транзакцией', async () => {
      const prisma = makePrisma();
      prisma.studySchedule.findFirst.mockResolvedValue({ id: 'sch-1' });
      prisma.$transaction.mockResolvedValue([{ count: 1 }, scheduleRow()]);
      const svc = makeService(prisma);

      await svc.update('user-1', 'sch-1', dto());

      expect(prisma.studyScheduleSlot.deleteMany).toHaveBeenCalledWith({
        where: { scheduleId: 'sch-1' },
      });
      expect(prisma.studySchedule.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'sch-1' } }),
      );
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('слоты редактируемой тренировки не участвуют в проверке пересечений', async () => {
      const prisma = makePrisma();
      prisma.studySchedule.findFirst.mockResolvedValue({ id: 'sch-1' });
      prisma.$transaction.mockResolvedValue([{ count: 1 }, scheduleRow()]);
      const svc = makeService(prisma);

      await svc.update('user-1', 'sch-1', dto());

      expect(prisma.studyScheduleSlot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            schedule: expect.objectContaining({ id: { not: 'sch-1' } }),
          }),
        }),
      );
    });
  });

  describe('delete', () => {
    it('404 на чужую тренировку', async () => {
      const prisma = makePrisma();
      prisma.studySchedule.findFirst.mockResolvedValue(null);
      const svc = makeService(prisma);

      await expect(svc.delete('user-1', 'sch-x')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.studySchedule.delete).not.toHaveBeenCalled();
    });

    it('удаляет свою тренировку', async () => {
      const prisma = makePrisma();
      prisma.studySchedule.findFirst.mockResolvedValue({ id: 'sch-1' });
      prisma.studySchedule.delete.mockResolvedValue({});
      const svc = makeService(prisma);

      await svc.delete('user-1', 'sch-1');

      expect(prisma.studySchedule.delete).toHaveBeenCalledWith({
        where: { id: 'sch-1' },
      });
    });
  });
});
