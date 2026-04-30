/**
 * KS-2182. Тесты `InternalAuthController`.
 *
 * Покрывает GWT-сценарии 1 (успешная выдача токена) и 2 (попытка выдать
 * для не-synthetic user → 403). Дополнительно — 404 для несуществующего
 * user и проверка содержимого payload (sub/username).
 *
 * `InternalKeyGuard` тестируется отдельно (`internal-key.guard.spec.ts`).
 * Здесь имитируем ситуацию, в которой guard уже пропустил (контроллер
 * вызывается напрямую).
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import {
  InternalAuthController,
  parseExpiresInSeconds,
} from './internal-auth.controller';
import type { PrismaService } from '../prisma/prisma.service';
import type { SyntheticTokenDto } from './dto/synthetic-token.dto';

function makeReq(): Request {
  return {
    headers: {},
    ip: '10.0.0.5',
  } as unknown as Request;
}

function makePrisma(found: { id: string; username: string | null; isSynthetic: boolean } | null): PrismaService {
  return {
    user: {
      findUnique: jest.fn(async () => found),
    },
  } as unknown as PrismaService;
}

function makeJwt(token: string): JwtService {
  return {
    sign: jest.fn().mockReturnValue(token),
  } as unknown as JwtService;
}

function makeConfig(expiresIn: string): ConfigService {
  return {
    get: (key: string, fallback?: string) =>
      key === 'JWT_EXPIRES_IN' ? expiresIn : fallback,
  } as unknown as ConfigService;
}

describe('InternalAuthController — KS-2182', () => {
  const SYNTH_USER = {
    id: '00000000-0000-4000-b000-000000000001',
    username: 'bot-001',
    isSynthetic: true,
  };
  const HUMAN_USER = {
    id: '11111111-1111-4111-a111-111111111111',
    username: 'john',
    isSynthetic: false,
  };

  it('GWT-сценарий 1: synthetic user → 201 {accessToken, expiresIn=900}', async () => {
    const prisma = makePrisma(SYNTH_USER);
    const jwt = makeJwt('signed.jwt.value');
    const ctrl = new InternalAuthController(prisma, jwt, makeConfig('15m'));

    const result = await ctrl.issueSyntheticToken(
      { botUserId: SYNTH_USER.id } as SyntheticTokenDto,
      makeReq(),
    );

    expect(result.accessToken).toBe('signed.jwt.value');
    expect(result.expiresIn).toBe(900);
    expect(jwt.sign).toHaveBeenCalledWith(
      { sub: SYNTH_USER.id, username: SYNTH_USER.username },
      { expiresIn: 900 },
    );
  });

  it('GWT-сценарий 2: non-synthetic user → ForbiddenException, токен не выдан', async () => {
    const prisma = makePrisma(HUMAN_USER);
    const jwt = makeJwt('should-not-be-issued');
    const ctrl = new InternalAuthController(prisma, jwt, makeConfig('15m'));

    await expect(
      ctrl.issueSyntheticToken(
        { botUserId: HUMAN_USER.id } as SyntheticTokenDto,
        makeReq(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('user не существует → NotFoundException', async () => {
    const prisma = makePrisma(null);
    const jwt = makeJwt('should-not-be-issued');
    const ctrl = new InternalAuthController(prisma, jwt, makeConfig('15m'));

    await expect(
      ctrl.issueSyntheticToken(
        { botUserId: '99999999-9999-4999-a999-999999999999' } as SyntheticTokenDto,
        makeReq(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('JWT_EXPIRES_IN=1h → expiresIn=3600', async () => {
    const prisma = makePrisma(SYNTH_USER);
    const jwt = makeJwt('jwt');
    const ctrl = new InternalAuthController(prisma, jwt, makeConfig('1h'));

    const result = await ctrl.issueSyntheticToken(
      { botUserId: SYNTH_USER.id } as SyntheticTokenDto,
      makeReq(),
    );

    expect(result.expiresIn).toBe(3600);
  });
});

describe('parseExpiresInSeconds — KS-2182', () => {
  it.each([
    ['15m', 900],
    ['900s', 900],
    ['1h', 3600],
    ['7d', 7 * 86400],
    ['600', 600],
    [600, 600],
  ] as Array<[string | number, number]>)(
    '%p → %p сек',
    (input, expected) => {
      expect(parseExpiresInSeconds(input)).toBe(expected);
    },
  );

  it('некорректное значение → fallback 900', () => {
    expect(parseExpiresInSeconds('garbage')).toBe(900);
  });
});
