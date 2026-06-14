import { IoAdapter } from '@nestjs/platform-socket.io';
import { INestApplicationContext, Logger } from '@nestjs/common';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';

/**
 * Socket.io Redis adapter (ADR-021 §2.3).
 *
 * Причина: broadcast-service запускается в ECS несколькими инстансами за ALB
 * с sticky sessions. Sticky session гарантирует, что один клиент приходит к
 * одному инстансу, но:
 *   1. Когда sync-loop (`BroadcastSyncService`) публикует `broadcast:move`
 *      в Redis, событие нужно доставить всем инстансам — иначе клиенты,
 *      привязанные к другому инстансу, не получат обновлений.
 *   2. Если нужно отправить сообщение всем клиентам конкретной комнаты
 *      (`broadcast:{roundId}`), это должно работать cross-instance.
 *
 * Redis adapter решает обе проблемы: `@socket.io/redis-adapter` использует
 * Redis pub/sub под капотом и синхронизирует room-сообщения между всеми
 * инстансами socket.io-сервера.
 *
 * Для gateway.subscribe() из `RedisService` мы по-прежнему подписываемся на
 * собственные каналы `broadcast:move` / `broadcast:sync` — это отдельный
 * контракт с sync-loop (`BroadcastSyncService`), не путать с внутренними
 * каналами `socket.io-#/#` redis-adapter'а.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private pubClient?: Redis;
  private subClient?: Redis;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6380', 10);

    this.pubClient = new Redis({ host, port });
    this.subClient = this.pubClient.duplicate();

    this.pubClient.on('error', (err) =>
      this.logger.error(`Redis adapter pub error: ${err.message}`),
    );
    this.subClient.on('error', (err) =>
      this.logger.error(`Redis adapter sub error: ${err.message}`),
    );

    this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
    this.logger.log(`Socket.io Redis adapter connected to ${host}:${port}`);
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
