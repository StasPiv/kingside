/**
 * KS-2197. Тест message-handler'а для канала
 * `MATCHMAKER_NO_OPPONENTS_CHANNEL`. Цель — убедиться, что:
 *   - Server → Client получает корректный payload `WsMatchmakingNoOpponentsPayload`.
 *   - `PLAYER_QUEUES_KEY`-индекс в Redis чистится (server-side LEAVE).
 *
 * Поднимать полноценный socket.io сервер не нужно: вызываем приватный
 * `handleNoOpponentsMessage` напрямую, проверяя side-effects.
 */
jest.mock('../redis/redis.service', () => ({
  RedisService: jest.fn(),
}));
jest.mock('@nestjs/jwt', () => ({
  JwtService: jest.fn(),
}));
jest.mock('nestjs-i18n', () => ({
  I18nService: jest.fn(),
}));

import { MatchmakingGateway } from './matchmaking.gateway';
import { MatchmakingEvents, type WsMatchmakingNoOpponentsPayload } from '@kingside/shared';

describe('MatchmakingGateway — KS-2197 no_opponents handler', () => {
  let gateway: MatchmakingGateway;
  let emit: jest.Mock;
  let to: jest.Mock;
  let hdel: jest.Mock;

  beforeEach(() => {
    emit = jest.fn();
    to = jest.fn().mockReturnValue({ emit });
    hdel = jest.fn().mockResolvedValue(1);

    const matchmakingService = {} as any;
    const jwtService = {} as any;
    const i18n = { t: (k: string) => k } as any;
    const redis = { hdel } as any;

    gateway = new MatchmakingGateway(
      matchmakingService,
      jwtService,
      i18n,
      redis,
    );
    (gateway as any).server = { to };
  });

  it('handleNoOpponentsMessage эмитит NO_OPPONENTS и чистит player_queues', () => {
    const message = JSON.stringify({
      userId: '11111111-1111-4111-a111-111111111111',
      category: 'bullet',
      timeInitial: 60,
      increment: 0,
      waitedMs: 60_500,
    });

    (gateway as unknown as { handleNoOpponentsMessage: (m: string) => void })
      .handleNoOpponentsMessage(message);

    expect(to).toHaveBeenCalledWith('user:11111111-1111-4111-a111-111111111111');
    expect(emit).toHaveBeenCalledTimes(1);
    const [event, payload] = emit.mock.calls[0];
    expect(event).toBe(MatchmakingEvents.NO_OPPONENTS);
    const expected: WsMatchmakingNoOpponentsPayload = {
      category: 'bullet',
      tc: { timeInitial: 60, increment: 0 },
      waitedMs: 60_500,
    };
    expect(payload).toEqual(expected);

    expect(hdel).toHaveBeenCalledWith(
      'matchmaking:player_queues',
      '11111111-1111-4111-a111-111111111111',
    );
  });
});
