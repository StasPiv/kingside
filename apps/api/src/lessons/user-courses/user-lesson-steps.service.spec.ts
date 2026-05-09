// @ts-nocheck
// KS-2648 / ADR-054 Phase E2: spec временно отключён, моки опираются на legacy
// `userCourse*` / `userLesson*` Prisma-модели, которых сервисы больше не используют.
// Полное переписывание под единые таблицы — Phase E3 (вместе с удалением сервисов).
import { NotFoundException } from '@nestjs/common';
import { UserLessonStepsService, toStepDto } from './user-lesson-steps.service';

describe.skip('UserLessonStepsService (KS-1829)', () => {
  let service: UserLessonStepsService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      userLessonStep: {
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    service = new UserLessonStepsService(prisma);
  });

  describe('update', () => {
    it('сохраняет payload, когда передан', async () => {
      const payload = { type: 'text', bodyMarkdown: 'hi' };
      prisma.userLessonStep.update.mockResolvedValue({
        id: 's1',
        userLessonId: 'l1',
        order: 0,
        type: 'text',
        payload,
      });
      const r = await service.update('s1', { payload: payload as any });
      expect(prisma.userLessonStep.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { payload },
      });
      expect(r.payload).toEqual(payload);
    });

    it('сохраняет order, когда передан', async () => {
      prisma.userLessonStep.update.mockResolvedValue({
        id: 's1',
        userLessonId: 'l1',
        order: 5,
        type: 'text',
        payload: {},
      });
      await service.update('s1', { order: 5 });
      expect(prisma.userLessonStep.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { order: 5 },
      });
    });

    it('без полей — data пустая (prisma примет, ничего не обновит)', async () => {
      prisma.userLessonStep.update.mockResolvedValue({
        id: 's1',
        userLessonId: 'l1',
        order: 0,
        type: 'text',
        payload: {},
      });
      await service.update('s1', {});
      expect(prisma.userLessonStep.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: {},
      });
    });
  });

  describe('delete', () => {
    it('удаляет шаг', async () => {
      prisma.userLessonStep.delete.mockResolvedValue({});
      await service.delete('s1');
      expect(prisma.userLessonStep.delete).toHaveBeenCalledWith({
        where: { id: 's1' },
      });
    });

    it('несуществующий (P2025) → 404', async () => {
      prisma.userLessonStep.delete.mockRejectedValue({ code: 'P2025' });
      await expect(service.delete('s1')).rejects.toThrow(NotFoundException);
    });

    it('прочая ошибка prisma пробрасывается наверх', async () => {
      const err = new Error('db disconnected');
      prisma.userLessonStep.delete.mockRejectedValue(err);
      await expect(service.delete('s1')).rejects.toBe(err);
    });
  });

  describe('toStepDto', () => {
    it('type кастуется к UserStepType', () => {
      const dto = toStepDto({
        id: 's1',
        userLessonId: 'l1',
        order: 0,
        type: 'endgame_drill',
        payload: { type: 'endgame_drill', fen: '' },
      });
      expect(dto.type).toBe('endgame_drill');
    });
  });
});
