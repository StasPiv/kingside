/**
 * KS-4674 / ADR-146. Юнит-тесты `OpeningTrainerAdminController` —
 * проверка декораторов (guard, scope), делегирования в сервис.
 */
import { Reflector } from '@nestjs/core';
import { AdminOrServiceGuard } from '../../auth/admin-or-service.guard';
import { REQUIRED_SCOPE_METADATA } from '../../auth/required-scope.decorator';
import { SCOPES } from '../../auth/scopes';
import { OpeningTrainerAdminController } from './opening-trainer-admin.controller';

function makeAdminSvc() {
  return {
    list: jest.fn().mockResolvedValue([]),
    getById: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    setStatus: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue(undefined),
  };
}

describe('OpeningTrainerAdminController — decorators', () => {
  const reflector = new Reflector();

  it('class: защищён AdminOrServiceGuard', () => {
    const guards =
      reflector.get<unknown[]>('__guards__', OpeningTrainerAdminController) ?? [];
    expect(guards).toContain(AdminOrServiceGuard);
  });

  it.each(['create', 'update', 'setStatus', 'delete'] as const)(
    'mutating-метод %s требует scope REPERTOIRE_WRITE',
    (method) => {
      const scope = reflector.get<string>(
        REQUIRED_SCOPE_METADATA,
        OpeningTrainerAdminController.prototype[method],
      );
      expect(scope).toBe(SCOPES.REPERTOIRE_WRITE);
    },
  );

  it.each(['list', 'getOne'] as const)(
    'read-метод %s НЕ требует scope (доступно service-account с любым непустым scope)',
    (method) => {
      const scope = reflector.get<string | undefined>(
        REQUIRED_SCOPE_METADATA,
        OpeningTrainerAdminController.prototype[method],
      );
      expect(scope).toBeUndefined();
    },
  );
});

describe('OpeningTrainerAdminController — delegation', () => {
  it('GET / → admin.list с фильтрами из query', async () => {
    const svc = makeAdminSvc();
    const ctrl = new OpeningTrainerAdminController(svc as never);
    await ctrl.list('white', 'italian', true);
    expect(svc.list).toHaveBeenCalledWith({
      side: 'white',
      slug: 'italian',
      isPublished: true,
    });
  });

  it('GET /:id → admin.getById', async () => {
    const svc = makeAdminSvc();
    const ctrl = new OpeningTrainerAdminController(svc as never);
    await ctrl.getOne('rrrrrrrr-rrrr-4rrr-rrrr-rrrrrrrrrrrr');
    expect(svc.getById).toHaveBeenCalledWith(
      'rrrrrrrr-rrrr-4rrr-rrrr-rrrrrrrrrrrr',
    );
  });

  it('POST / → admin.create с body', async () => {
    const svc = makeAdminSvc();
    const ctrl = new OpeningTrainerAdminController(svc as never);
    await ctrl.create({
      slug: 'italian',
      title: 'Italian',
      side: 'white',
      pgn: 'p',
    } as never);
    expect(svc.create).toHaveBeenCalled();
  });

  it('PUT /:id → admin.update', async () => {
    const svc = makeAdminSvc();
    const ctrl = new OpeningTrainerAdminController(svc as never);
    await ctrl.update('rrrrrrrr-rrrr-4rrr-rrrr-rrrrrrrrrrrr', { title: 't' } as never);
    expect(svc.update).toHaveBeenCalledWith(
      'rrrrrrrr-rrrr-4rrr-rrrr-rrrrrrrrrrrr',
      { title: 't' },
    );
  });

  it('PATCH /:id/status → admin.setStatus', async () => {
    const svc = makeAdminSvc();
    const ctrl = new OpeningTrainerAdminController(svc as never);
    await ctrl.setStatus('rrrrrrrr-rrrr-4rrr-rrrr-rrrrrrrrrrrr', {
      isPublished: true,
    });
    expect(svc.setStatus).toHaveBeenCalledWith(
      'rrrrrrrr-rrrr-4rrr-rrrr-rrrrrrrrrrrr',
      { isPublished: true },
    );
  });

  it('DELETE /:id → admin.delete, 204 (void)', async () => {
    const svc = makeAdminSvc();
    const ctrl = new OpeningTrainerAdminController(svc as never);
    await ctrl.delete('rrrrrrrr-rrrr-4rrr-rrrr-rrrrrrrrrrrr');
    expect(svc.delete).toHaveBeenCalledWith(
      'rrrrrrrr-rrrr-4rrr-rrrr-rrrrrrrrrrrr',
    );
  });
});
