/**
 * KS-4130. Тесты единого маппера toPublicDto.
 */
import { toPublicDto, PRIVATE_DTO_FIELDS } from './public-dto.mapper';

describe('toPublicDto', () => {
  describe('viewer === authorized', () => {
    it('возвращает entity как есть (включая приватные поля)', () => {
      const entity = {
        id: 'u1',
        username: 'alice',
        email: 'alice@example.com',
        privateNotes: 'модератор пометил',
      };
      const result = toPublicDto(entity, { id: 'viewer-1' });
      expect(result).toEqual(entity);
    });
  });

  describe('viewer === guest (null/undefined)', () => {
    it('режет все поля из PRIVATE_DTO_FIELDS на верхнем уровне', () => {
      const entity = {
        id: 'u1',
        username: 'alice',
        email: 'a@b.c',
        emailVerified: true,
        phone: '+1',
        phoneVerified: false,
        oauthIds: { google: 'g1' },
        googleId: 'g1',
        facebookId: 'f1',
        telegramId: 12345,
        privateNotes: 'x',
        internalNotes: 'y',
        subscription: { plan: 'pro' },
        paymentMethod: { type: 'card' },
        lastInvoice: { amount: 9 },
        lastSeenAt: new Date(),
        lastIp: '127.0.0.1',
        userAgent: 'curl',
        privacyFlags: { hideEmail: true },
        friends: ['u2'],
        blockedUsers: ['u3'],
        rating: 1500, // публичное — должно сохраниться
      };
      const result = toPublicDto(entity, null) as Record<string, unknown>;
      // Все приватные поля удалены
      for (const k of PRIVATE_DTO_FIELDS) {
        expect(result).not.toHaveProperty(k);
      }
      // Публичные остались
      expect(result.id).toBe('u1');
      expect(result.username).toBe('alice');
      expect(result.rating).toBe(1500);
    });

    it('режет приватные поля во вложенных объектах', () => {
      const comment = {
        id: 'c1',
        text: 'хороший ход',
        author: {
          id: 'u1',
          username: 'alice',
          email: 'a@b.c',
          telegramId: 99,
          privateNotes: 'mod',
          rating: 2000,
        },
      };
      const result = toPublicDto(comment, undefined) as {
        id: string;
        text: string;
        author: Record<string, unknown>;
      };
      expect(result.id).toBe('c1');
      expect(result.text).toBe('хороший ход');
      expect(result.author.id).toBe('u1');
      expect(result.author.username).toBe('alice');
      expect(result.author.rating).toBe(2000);
      expect(result.author).not.toHaveProperty('email');
      expect(result.author).not.toHaveProperty('telegramId');
      expect(result.author).not.toHaveProperty('privateNotes');
    });

    it('режет приватные поля в массиве объектов', () => {
      const players = [
        { id: 'u1', email: 'a@b.c', rating: 1500 },
        { id: 'u2', email: 'd@e.f', rating: 1700 },
      ];
      const result = toPublicDto(players, null) as Array<Record<string, unknown>>;
      expect(result).toHaveLength(2);
      for (const p of result) {
        expect(p).not.toHaveProperty('email');
        expect(p).toHaveProperty('rating');
      }
    });

    it('не ломает примитивы / null / Date', () => {
      expect(toPublicDto('string', null)).toBe('string');
      expect(toPublicDto(123, null)).toBe(123);
      expect(toPublicDto(null, null)).toBeNull();
      expect(toPublicDto(undefined, null)).toBeUndefined();
      const d = new Date('2026-06-15T00:00:00Z');
      expect(toPublicDto(d, null)).toBe(d);
    });

    it('Buffer сохраняется как есть, не разбирается по байтам', () => {
      const buf = Buffer.from('hello');
      expect(toPublicDto(buf, null)).toBe(buf);
    });
  });
});
