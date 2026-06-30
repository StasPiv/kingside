/**
 * KS-4807 / ADR-153 §2.2. Юнит-тесты на `MessageGateway.emitHintShow`:
 *   - читает `server.sockets.adapter.rooms.get('user:<id>')?.size`;
 *   - при size>0 — emit + delivered:true + observe размер;
 *   - при size=0 — НЕ emit, delivered:false, inc empty-counter.
 *
 * Остальной gateway-логики не касаемся — handshake/online-tracking и
 * challenges покрываются e2e.
 */
import { MessageGateway } from './message.gateway';

function makeGateway(opts: {
  rooms?: Map<string, Set<string>>;
} = {}): {
  gw: MessageGateway;
  emit: jest.Mock;
  hintsMetrics: any;
} {
  const emit = jest.fn();
  const toFn = jest.fn().mockReturnValue({ emit });
  const adapterRooms = opts.rooms ?? new Map<string, Set<string>>();
  // KS-4818: `this.server` для namespace-gateway — это Namespace, у
  // которого adapter лежит на `.adapter` (не `.sockets.adapter`).
  const server: any = {
    to: toFn,
    adapter: {
      rooms: adapterRooms,
    },
  };
  const hintsMetrics = {
    emitRoomEmpty: { inc: jest.fn() },
    emitRoomSize: { observe: jest.fn() },
  } as any;

  // Минимально живой gateway: подменяем все зависимости пустышками, нам
  // нужен только `server` и `hintsMetrics`.
  const gw = new MessageGateway(
    {} as any, // jwtService
    {} as any, // redis
    {} as any, // prisma
    {} as any, // gameService
    {} as any, // notifications
    {} as any, // hints
    hintsMetrics,
  );
  (gw as unknown as { server: typeof server }).server = server;
  return { gw, emit, hintsMetrics };
}

describe('MessageGateway.emitHintShow — KS-4807 / ADR-153 §2.2', () => {
  it('room.size>0 → emit, delivered=true, observed=size', () => {
    const rooms = new Map<string, Set<string>>([
      ['user:u-1', new Set(['sock-1', 'sock-2'])],
    ]);
    const { gw, emit, hintsMetrics } = makeGateway({ rooms });

    const result = gw.emitHintShow('u-1', { hintId: 'h-1' });

    expect(result).toEqual({ delivered: true });
    expect(emit).toHaveBeenCalledWith('hint:show', { hintId: 'h-1' });
    expect(hintsMetrics.emitRoomSize.observe).toHaveBeenCalledWith({ actor_type: 'user' }, 2);
    expect(hintsMetrics.emitRoomEmpty.inc).not.toHaveBeenCalled();
  });

  it('room.size=0 → НЕ emit, delivered=false, empty-counter++', () => {
    // Пустой adapter — нет room user:u-1.
    const { gw, emit, hintsMetrics } = makeGateway();

    const result = gw.emitHintShow('u-1', { hintId: 'h-1' });

    expect(result).toEqual({ delivered: false });
    expect(emit).not.toHaveBeenCalled();
    expect(hintsMetrics.emitRoomSize.observe).toHaveBeenCalledWith({ actor_type: 'user' }, 0);
    expect(hintsMetrics.emitRoomEmpty.inc).toHaveBeenCalledWith({ actor_type: 'user' });
  });

  it('actorType=guest пробрасывается в метрики', () => {
    const rooms = new Map<string, Set<string>>([['user:g-1', new Set(['s'])]]);
    const { gw, hintsMetrics } = makeGateway({ rooms });
    gw.emitHintShow('g-1', { hintId: 'h-1' }, 'guest');
    expect(hintsMetrics.emitRoomSize.observe).toHaveBeenCalledWith({ actor_type: 'guest' }, 1);
  });

  it('размер room=1 → observed=1, не empty', () => {
    const rooms = new Map<string, Set<string>>([['user:u-1', new Set(['s'])]]);
    const { gw, hintsMetrics, emit } = makeGateway({ rooms });
    const r = gw.emitHintShow('u-1', { hintId: 'h-1' });
    expect(r.delivered).toBe(true);
    expect(emit).toHaveBeenCalled();
    expect(hintsMetrics.emitRoomSize.observe).toHaveBeenCalledWith({ actor_type: 'user' }, 1);
    expect(hintsMetrics.emitRoomEmpty.inc).not.toHaveBeenCalled();
  });

  it('hintsMetrics undefined (DI без HintsModule) → не падает, поведение тоже работает', () => {
    const rooms = new Map<string, Set<string>>([['user:u-1', new Set(['s'])]]);
    const emit = jest.fn();
    const server: any = {
      to: jest.fn().mockReturnValue({ emit }),
      adapter: { rooms },
    };
    const gw = new MessageGateway({} as any, {} as any, {} as any, {} as any, {} as any, {} as any /* hintsMetrics undefined */);
    (gw as unknown as { server: typeof server }).server = server;
    const r = gw.emitHintShow('u-1', { hintId: 'h-1' });
    expect(r.delivered).toBe(true);
    expect(emit).toHaveBeenCalled();
  });
});
