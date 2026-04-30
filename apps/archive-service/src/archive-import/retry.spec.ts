/**
 * KS-2156. Юнит-тесты retry helper'а: проверяем backoff-расписание,
 * предикаты транзиентности (40P01 / P1001 / P1002 / P2024) и
 * abort-семантику.
 */
import {
  isPostgresDeadlock,
  isPrismaTransientNetworkError,
  retryWithBackoff,
} from './retry';

describe('retryWithBackoff — KS-2156', () => {
  it('успех с первой попытки → op вызван 1 раз, sleep не вызывался', async () => {
    const op = jest.fn(async () => 'ok');
    const sleep = jest.fn(async () => undefined);

    const r = await retryWithBackoff(op, {
      isRetryable: () => true,
      sleep,
    });

    expect(r).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('транзиентная ошибка → ретрай с экспоненциальной задержкой 100/200/400', async () => {
    let calls = 0;
    const op = jest.fn(async () => {
      calls++;
      if (calls < 3) {
        const err = new Error('transient') as Error & { code: string };
        err.code = '40P01';
        throw err;
      }
      return 'ok';
    });
    const sleep = jest.fn(async () => undefined);
    const onRetry = jest.fn();

    const r = await retryWithBackoff(op, {
      isRetryable: isPostgresDeadlock,
      sleep,
      onRetry,
    });

    expect(r).toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    // Первая пауза 100ms (после первого fail), вторая 200ms.
    expect(sleep.mock.calls[0][0]).toBe(100);
    expect(sleep.mock.calls[1][0]).toBe(200);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('нетранзиентная ошибка → НЕ ретраится, бросается сразу', async () => {
    const fatal = new Error('boom') as Error & { code: string };
    fatal.code = 'P2002';
    const op = jest.fn(async () => {
      throw fatal;
    });
    const sleep = jest.fn();

    await expect(
      retryWithBackoff(op, {
        isRetryable: isPostgresDeadlock,
        sleep,
      }),
    ).rejects.toBe(fatal);

    expect(op).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('исчерпан maxAttempts → пробрасывается последняя ошибка', async () => {
    const transient = new Error('40P01: deadlock_detected') as Error & {
      code: string;
    };
    transient.code = '40P01';
    const op = jest.fn(async () => {
      throw transient;
    });
    const sleep = jest.fn(async () => undefined);

    await expect(
      retryWithBackoff(op, {
        isRetryable: isPostgresDeadlock,
        maxAttempts: 5,
        sleep,
      }),
    ).rejects.toBe(transient);

    expect(op).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it('задержка clamp\'ится по maxDelayMs', async () => {
    let calls = 0;
    const transient = new Error('40P01') as Error & { code: string };
    transient.code = '40P01';
    const op = jest.fn(async () => {
      calls++;
      if (calls < 5) throw transient;
      return 'ok';
    });
    const sleep = jest.fn(async () => undefined);

    await retryWithBackoff(op, {
      isRetryable: isPostgresDeadlock,
      sleep,
      initialDelayMs: 100,
      factor: 2,
      maxDelayMs: 300,
      maxAttempts: 5,
    });

    // 100, 200, 300 (capped from 400), 300 (capped from 800).
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200, 300, 300]);
  });

  it('signal.aborted ДО первой попытки → throw signal.reason, op не вызывался', async () => {
    const ac = new AbortController();
    const myReason = new Error('cancelled');
    ac.abort(myReason);
    const op = jest.fn(async () => 'ok');

    await expect(
      retryWithBackoff(op, {
        isRetryable: () => true,
        signal: ac.signal,
      }),
    ).rejects.toBe(myReason);
    expect(op).not.toHaveBeenCalled();
  });

  it('signal.aborted между попытками → пробрасывается последняя реальная ошибка', async () => {
    const ac = new AbortController();
    const transient = new Error('40P01') as Error & { code: string };
    transient.code = '40P01';

    const op = jest.fn(async () => {
      throw transient;
    });
    const sleep = jest.fn(async () => {
      // Симулируем потерю lock'а во время sleep между попытками.
      ac.abort(new Error('lock lost: test'));
    });

    await expect(
      retryWithBackoff(op, {
        isRetryable: isPostgresDeadlock,
        signal: ac.signal,
        sleep,
        maxAttempts: 5,
      }),
    ).rejects.toBe(transient);

    // Первая попытка: throw → sleep (внутри aborts) → check → throw lastErr.
    // op вызван 1 раз.
    expect(op).toHaveBeenCalledTimes(1);
  });
});

describe('isPostgresDeadlock — KS-2156', () => {
  it('код 40P01 (raw pg)', () => {
    expect(isPostgresDeadlock({ code: '40P01' })).toBe(true);
  });

  it('Prisma P2034 (transaction conflict — частный случай)', () => {
    expect(isPostgresDeadlock({ code: 'P2034' })).toBe(true);
  });

  it('Prisma error с meta.code=40P01', () => {
    expect(isPostgresDeadlock({ code: 'P2010', meta: { code: '40P01' } })).toBe(
      true,
    );
  });

  it('fallback по message-substring "deadlock_detected"', () => {
    expect(
      isPostgresDeadlock({ message: 'ERROR: deadlock_detected\nDETAIL: ...' }),
    ).toBe(true);
  });

  it('обычный P2002 (UNIQUE) → false', () => {
    expect(isPostgresDeadlock({ code: 'P2002' })).toBe(false);
  });

  it('null / undefined / non-object → false', () => {
    expect(isPostgresDeadlock(null)).toBe(false);
    expect(isPostgresDeadlock(undefined)).toBe(false);
    expect(isPostgresDeadlock('string-error')).toBe(false);
  });
});

describe('isPrismaTransientNetworkError — KS-2156', () => {
  it.each(['P1001', 'P1002', 'P2024'])('%s → true', (code) => {
    expect(isPrismaTransientNetworkError({ code })).toBe(true);
  });

  it('P2002 (UNIQUE), P2025 (record not found) → false', () => {
    expect(isPrismaTransientNetworkError({ code: 'P2002' })).toBe(false);
    expect(isPrismaTransientNetworkError({ code: 'P2025' })).toBe(false);
  });

  it('null / non-object → false', () => {
    expect(isPrismaTransientNetworkError(null)).toBe(false);
    expect(isPrismaTransientNetworkError(42)).toBe(false);
  });
});
