import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AnalysisController } from './analysis.controller';
import { AnalysisPublicController } from './analysis-public.controller';
import { AnalysisService } from './analysis.service';

describe('AnalysisPublicController (KS-2601)', () => {
  // KS-2601: контроллер `analyses/public/:id` НЕ должен иметь
  // JWT-гарда (ни на классе, ни на методе) — анонимный доступ
  // обязателен. Параллельно фиксируем, что приватный контроллер
  // продолжает требовать JwtAuthGuard на классе (регрессия).

  it('AnalysisPublicController: НЕ имеет JwtAuthGuard на классе', () => {
    const reflector = new Reflector();
    const guards = reflector.get<unknown[]>('__guards__', AnalysisPublicController);
    // Декоратор @UseGuards проставляет ключ '__guards__'. Если ничего
    // не объявлено — Reflect.getMetadata вернёт undefined.
    expect(guards).toBeUndefined();
  });

  it('AnalysisPublicController.findPublic: НЕ имеет JwtAuthGuard на методе', () => {
    const reflector = new Reflector();
    const guards = reflector.get<unknown[]>(
      '__guards__',
      AnalysisPublicController.prototype.findPublic,
    );
    expect(guards).toBeUndefined();
  });

  it('AnalysisController (приватный): сохраняет JwtAuthGuard на классе', () => {
    const reflector = new Reflector();
    const guards = reflector.get<unknown[]>('__guards__', AnalysisController);
    // Защита от регрессии в KS-2601: при добавлении публичного
    // контроллера приватный не должен потерять guard.
    expect(guards).toBeDefined();
    expect(guards).toContain(JwtAuthGuard);
  });

  it('AnalysisPublicController.findPublic делегирует в service.findPublic', async () => {
    const service = {
      findPublic: jest.fn().mockResolvedValue({ id: 'pub-1' }),
    } as unknown as AnalysisService;
    const controller = new AnalysisPublicController(service);

    const result = await controller.findPublic('pub-1');

    expect(service.findPublic).toHaveBeenCalledWith('pub-1');
    expect(result).toEqual({ id: 'pub-1' });
  });
});
