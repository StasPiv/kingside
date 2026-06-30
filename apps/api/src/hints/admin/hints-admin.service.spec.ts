/**
 * KS-4702: HintsAdminService — CRUD + DSL validation + sanitize.
 * Моки owner-Prisma на уровне hint.create/update/findUnique/findMany.
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { HintsAdminService } from './hints-admin.service';

function mkOwner(over: Partial<any> = {}): any {
  return {
    hint: {
      create: jest.fn(async (args: any) => ({
        id: 'h1',
        ...args.data,
        createdAt: new Date('2026-06-27'),
        updatedAt: new Date('2026-06-27'),
        deletedAt: null,
      })),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(async (args: any) => ({
        id: args.where.id,
        key: 'k',
        i18n: {},
        cta: null,
        anchor: 'landing-signup-button',
        placement: 'top',
        rule: {},
        priority: 0,
        enabled: true,
        acceptedBy: [],
        targetActorTypes: ['user', 'guest'],
        cooldownSec: 86400,
        ttlSec: 0,
        maxShows: 3,
        createdAt: new Date('2026-06-27'),
        updatedAt: new Date('2026-06-27'),
        deletedAt: null,
        ...args.data,
      })),
    },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    ...over,
  };
}

function mkSvc(owner: any): HintsAdminService {
  const prismaSvc = { getOwner: () => owner } as any;
  return new HintsAdminService(prismaSvc);
}

const VALID_RULE = { actorType: { equals: 'guest' as const } };
const VALID_I18N = { ru: { title: 'Заголовок', body: 'Текст' } };

describe('HintsAdminService.create', () => {
  it('валидный create → запись с дефолтами', async () => {
    const owner = mkOwner();
    const svc = mkSvc(owner);
    const r = await svc.create({
      key: 'test-hint',
      i18n: VALID_I18N,
      anchor: 'landing-signup-button',
      placement: 'top',
      rule: VALID_RULE,
    });
    expect(owner.hint.create).toHaveBeenCalled();
    const args = owner.hint.create.mock.calls[0][0];
    expect(args.data.targetActorTypes).toEqual(['user', 'guest']);
    expect(args.data.cooldownSec).toBe(86400);
    expect(args.data.maxShows).toBe(3);
    expect(r.key).toBe('test-hint');
  });

  it('KS-4731 / ADR-148: новый произвольный anchor принимается без правок shared', async () => {
    const owner = mkOwner();
    const svc = mkSvc(owner);
    const r = await svc.create({
      key: 'k',
      i18n: VALID_I18N,
      anchor: 'analysis-bridge-promo',
      placement: 'top',
      rule: VALID_RULE,
    });
    expect(r.key).toBe('k');
    const args = owner.hint.create.mock.calls[0][0];
    expect(args.data.anchor).toBe('analysis-bridge-promo');
  });

  it('невалидный rule → BadRequest с сообщением парсера', async () => {
    const svc = mkSvc(mkOwner());
    await expect(svc.create({
      key: 'k',
      i18n: VALID_I18N,
      anchor: 'landing-signup-button',
      placement: 'top',
      rule: { bogus: {} } as any,
    })).rejects.toThrow(/неизвестный оператор/);
  });

  it('sanitize: HTML в i18n.title удаляется', async () => {
    const owner = mkOwner();
    const svc = mkSvc(owner);
    await svc.create({
      key: 'k',
      i18n: { ru: { title: '<script>alert(1)</script>Привет', body: '<b>Bold</b>' } },
      anchor: 'landing-signup-button',
      placement: 'top',
      rule: VALID_RULE,
    });
    const args = owner.hint.create.mock.calls[0][0];
    expect(args.data.i18n.ru.title).not.toContain('<');
    expect(args.data.i18n.ru.title).toBe('Привет');
    expect(args.data.i18n.ru.body).toBe('Bold');
  });

  // KS-4825 / ADR-154 §2.8: валидация шаблонов
  describe('validateTemplates (KS-4825)', () => {
    const ruleWithGameEnd = {
      all: [
        { actorType: { equals: 'user' } },
        { count: { event: 'game_end', where: { result: 'loss' }, gte: 3, windowDays: 7 } },
      ],
    };
    const rulePuzzleFailed = {
      count: { event: 'puzzle_failed', gte: 1, windowDays: 1 },
    };
    const noEventRule = { actorType: { equals: 'guest' } };

    it('cta.href c {{game_id}} + rule с game_end → ок', async () => {
      const owner = mkOwner();
      const svc = mkSvc(owner);
      await svc.create({
        key: 'k',
        i18n: VALID_I18N,
        cta: { href: '/game/{{game_id}}/review' },
        anchor: 'a',
        placement: 'top',
        rule: ruleWithGameEnd as any,
      });
      expect(owner.hint.create).toHaveBeenCalled();
    });

    it('cta.href с {{user_email}} (не в whitelist) → 400', async () => {
      const svc = mkSvc(mkOwner());
      await expect(svc.create({
        key: 'k',
        i18n: VALID_I18N,
        cta: { href: '/{{user_email}}' },
        anchor: 'a',
        placement: 'top',
        rule: ruleWithGameEnd as any,
      })).rejects.toThrow(/user_email/);
    });

    it('{{game_id}} в i18n.ru.ctaLabel при rule puzzle_failed → 400 (var не в этом whitelist)', async () => {
      const svc = mkSvc(mkOwner());
      await expect(svc.create({
        key: 'k',
        i18n: { ru: { title: 'T', body: 'B', ctaLabel: 'Открыть {{game_id}}' } },
        anchor: 'a',
        placement: 'top',
        rule: rulePuzzleFailed as any,
      })).rejects.toThrow(/game_id/);
    });

    it('{{puzzle_id}} в i18n.en.instructionBody при rule puzzle_failed → ок', async () => {
      const owner = mkOwner();
      const svc = mkSvc(owner);
      await svc.create({
        key: 'k',
        i18n: {
          ru: { title: 'T', body: 'B' },
          en: { title: 'T', body: 'B', instructionBody: 'Open puzzle {{puzzle_id}}' },
        },
        anchor: 'a',
        placement: 'top',
        rule: rulePuzzleFailed as any,
      });
      expect(owner.hint.create).toHaveBeenCalled();
    });

    it('rule БЕЗ event-имени (только actorType) + {{game_id}} в любом шаблоне → 400', async () => {
      const svc = mkSvc(mkOwner());
      await expect(svc.create({
        key: 'k',
        i18n: VALID_I18N,
        cta: { href: '/g/{{game_id}}' },
        anchor: 'a',
        placement: 'top',
        rule: noEventRule as any,
      })).rejects.toThrow(/game_id|no event triggers/);
    });

    it('fallbackHref тоже проверяется', async () => {
      const svc = mkSvc(mkOwner());
      await expect(svc.create({
        key: 'k',
        i18n: VALID_I18N,
        cta: { href: '/static', fallbackHref: '/{{nope}}' },
        anchor: 'a',
        placement: 'top',
        rule: ruleWithGameEnd as any,
      })).rejects.toThrow(/nope/);
    });

    it('шаблонов нет → ничего не проверяется, ок даже с пустым rule-events', async () => {
      const owner = mkOwner();
      const svc = mkSvc(owner);
      await svc.create({
        key: 'k',
        i18n: VALID_I18N,
        cta: { href: '/static' },
        anchor: 'a',
        placement: 'top',
        rule: noEventRule as any,
      });
      expect(owner.hint.create).toHaveBeenCalled();
    });
  });

  it('дубль key → Conflict через Prisma P2002', async () => {
    const owner = mkOwner({
      hint: {
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      },
    });
    const svc = mkSvc(owner);
    await expect(svc.create({
      key: 'dup',
      i18n: VALID_I18N,
      anchor: 'landing-signup-button',
      placement: 'top',
      rule: VALID_RULE,
    })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('HintsAdminService.update / setStatus / delete', () => {
  const HINT_ROW = {
    id: 'h1',
    key: 'k',
    i18n: VALID_I18N,
    cta: null,
    anchor: 'landing-signup-button',
    placement: 'top',
    rule: VALID_RULE,
    priority: 0,
    enabled: true,
    acceptedBy: [],
    targetActorTypes: ['user', 'guest'],
    cooldownSec: 86400,
    ttlSec: 0,
    maxShows: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  it('update неизвестный id → NotFound', async () => {
    const owner = mkOwner({ hint: { ...mkOwner().hint, findUnique: jest.fn().mockResolvedValue(null) } });
    const svc = mkSvc(owner);
    await expect(svc.update('h1', { enabled: false }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('update валидный rule → пройдёт; невалидный → BadRequest', async () => {
    const owner = mkOwner({
      hint: {
        ...mkOwner().hint,
        findUnique: jest.fn().mockResolvedValue(HINT_ROW),
      },
    });
    const svc = mkSvc(owner);
    await expect(svc.update('h1', { rule: VALID_RULE })).resolves.toBeDefined();
    await expect(svc.update('h1', { rule: { bogus: {} } as any }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('setStatus enabled=true с deletedAt → восстанавливает (deletedAt=null)', async () => {
    const owner = mkOwner({
      hint: {
        ...mkOwner().hint,
        findUnique: jest.fn().mockResolvedValue({ ...HINT_ROW, deletedAt: new Date() }),
      },
    });
    const svc = mkSvc(owner);
    await svc.setStatus('h1', { enabled: true });
    const args = owner.hint.update.mock.calls[0][0];
    expect(args.data.deletedAt).toBeNull();
  });

  it('delete: soft-delete + idempotent', async () => {
    const owner = mkOwner({
      hint: {
        ...mkOwner().hint,
        findUnique: jest.fn()
          .mockResolvedValueOnce(HINT_ROW)
          .mockResolvedValueOnce({ ...HINT_ROW, deletedAt: new Date() }),
      },
    });
    const svc = mkSvc(owner);
    await svc.delete('h1');
    expect(owner.hint.update).toHaveBeenCalled();
    owner.hint.update.mockClear();
    await svc.delete('h1');
    expect(owner.hint.update).not.toHaveBeenCalled();
  });

  it('delete: несуществующий → NotFound', async () => {
    const owner = mkOwner();
    const svc = mkSvc(owner);
    await expect(svc.delete('h1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('HintsAdminService.previewTrigger', () => {
  it('невалидный rule → BadRequest', async () => {
    const svc = mkSvc(mkOwner());
    await expect(svc.previewTrigger({ bogus: {} } as any))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('успешный preview: возвращает { estimate, sampled, capped }', async () => {
    const owner = mkOwner({
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        { actor_id: 'u1', actor_type: 'user' },
        { actor_id: 'g1', actor_type: 'guest' },
      ]),
    });
    const svc = mkSvc(owner);
    const r = await svc.previewTrigger({ actorType: { equals: 'guest' } });
    expect(r.sampled).toBe(2);
    expect(r.capped).toBe(false);
    // evaluateRule actorType=guest вернёт true только для guest → 1
    expect(r.estimate).toBe(1);
  });
});
