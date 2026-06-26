/**
 * KS-4672. Юнит-тесты `BlogAdminRecomputeController` —
 * `X-Admin-Token` (`BROADCAST_ADMIN_TOKEN`) защита и делегирование
 * в `BlogAdminService.recomputeHtmlForAllPosts`.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { BlogAdminRecomputeController } from './blog-admin-recompute.controller';

function makeAdmin(result = { total: 0, updated: 0, unchanged: 0 }) {
  return {
    recomputeHtmlForAllPosts: jest.fn().mockResolvedValue(result),
  };
}

function makeConfig(env: Record<string, string | undefined>) {
  return {
    get: jest.fn((key: string) => env[key]),
  };
}

const TOKEN = 'super-secret-token';

describe('BlogAdminRecomputeController', () => {
  it('верный X-Admin-Token → делегирует и возвращает summary', async () => {
    const admin = makeAdmin({ total: 7, updated: 3, unchanged: 4 });
    const ctrl = new BlogAdminRecomputeController(
      admin as never,
      makeConfig({ BROADCAST_ADMIN_TOKEN: TOKEN }) as never,
    );
    const r = await ctrl.recomputeHtml(TOKEN);
    expect(r).toEqual({ total: 7, updated: 3, unchanged: 4 });
    expect(admin.recomputeHtmlForAllPosts).toHaveBeenCalledTimes(1);
  });

  it('неверный X-Admin-Token → 403 forbidden, сервис не вызван', async () => {
    const admin = makeAdmin();
    const ctrl = new BlogAdminRecomputeController(
      admin as never,
      makeConfig({ BROADCAST_ADMIN_TOKEN: TOKEN }) as never,
    );
    try {
      await ctrl.recomputeHtml('wrong');
      fail('expected HttpException');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(HttpStatus.FORBIDDEN);
    }
    expect(admin.recomputeHtmlForAllPosts).not.toHaveBeenCalled();
  });

  it('пустой X-Admin-Token → 403 forbidden', async () => {
    const admin = makeAdmin();
    const ctrl = new BlogAdminRecomputeController(
      admin as never,
      makeConfig({ BROADCAST_ADMIN_TOKEN: TOKEN }) as never,
    );
    await expect(ctrl.recomputeHtml(undefined)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(admin.recomputeHtmlForAllPosts).not.toHaveBeenCalled();
  });

  it('BROADCAST_ADMIN_TOKEN не настроен → 503 service_unavailable', async () => {
    const admin = makeAdmin();
    const ctrl = new BlogAdminRecomputeController(
      admin as never,
      makeConfig({ BROADCAST_ADMIN_TOKEN: '' }) as never,
    );
    try {
      await ctrl.recomputeHtml(TOKEN);
      fail('expected HttpException');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  });
});
