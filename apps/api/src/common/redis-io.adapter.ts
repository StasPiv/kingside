import { IoAdapter } from '@nestjs/platform-socket.io';
import { INestApplication, Logger } from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import { ServerOptions } from 'socket.io';
import Redis, { RedisOptions } from 'ioredis';
import { ScalingService } from './scaling.service';

export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;

  constructor(app: INestApplication) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const redisUrl = process.env.REDIS_URL;
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '6380', 10);

    let opts: RedisOptions;
    let connLabel: string;

    if (redisUrl) {
      // Parse REDIS_URL (supports redis:// and rediss:// for TLS)
      const isTls = redisUrl.startsWith('rediss://');
      opts = {
        ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
      };
      connLabel = redisUrl.replace(/\/\/.*:.*@/, '//***@'); // hide password in logs

      const pubClient = new Redis(redisUrl, opts);
      const subClient = new Redis(redisUrl, opts);

      pubClient.on('error', (err) => this.logger.error(`Redis pub error: ${err.message}`));
      subClient.on('error', (err) => this.logger.error(`Redis sub error: ${err.message}`));

      await Promise.all([
        new Promise<void>((resolve) => pubClient.on('ready', resolve)),
        new Promise<void>((resolve) => subClient.on('ready', resolve)),
      ]);

      this.adapterConstructor = createAdapter(pubClient, subClient);
    } else {
      connLabel = `${redisHost}:${redisPort}`;
      const pubClient = new Redis({ host: redisHost, port: redisPort });
      const subClient = pubClient.duplicate();

      pubClient.on('error', (err) => this.logger.error(`Redis pub error: ${err.message}`));
      subClient.on('error', (err) => this.logger.error(`Redis sub error: ${err.message}`));

      await Promise.all([
        new Promise<void>((resolve) => pubClient.on('ready', resolve)),
        new Promise<void>((resolve) => subClient.on('ready', resolve)),
      ]);

      this.adapterConstructor = createAdapter(pubClient, subClient);
    }

    this.logger.log(`Redis adapter connected (${connLabel})`);
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }

    const maxConnections = parseInt(process.env.WS_MAX_CONNECTIONS || '500', 10);
    const maxPendingHandshakes = parseInt(process.env.WS_MAX_PENDING_HANDSHAKES || '20', 10);
    let pendingHandshakes = 0;

    // Connection admission control + handshake rate limiting
    server.use((socket: any, next: (err?: Error) => void) => {
      // 0. Reject if ScalingService reports server is busy (scale-up in progress)
      if (ScalingService.busy) {
        this.logger.warn('Admission control: rejecting connection (server busy, scale-up in progress)');
        return next(new Error(JSON.stringify({ type: 'server_busy', retryAfter: 60 })));
      }

      // 1. Admission control: reject if too many connections
      const clientsCount = server.engine?.clientsCount ?? 0;
      if (clientsCount >= maxConnections) {
        this.logger.warn(`Admission control: rejecting connection (${clientsCount}/${maxConnections})`);
        return next(new Error(JSON.stringify({ type: 'server_busy', retryAfter: 60 })));
      }

      // 2. Handshake rate limiting: reject if too many pending
      if (pendingHandshakes >= maxPendingHandshakes) {
        this.logger.warn(`Handshake rate limit: rejecting (${pendingHandshakes}/${maxPendingHandshakes} pending)`);
        return next(new Error(JSON.stringify({ type: 'server_busy', retryAfter: 5 })));
      }

      pendingHandshakes++;
      socket.once('disconnect', () => { /* cleanup handled below */ });

      // Decrease pending count after handshake completes (next tick)
      setImmediate(() => {
        pendingHandshakes = Math.max(0, pendingHandshakes - 1);
      });

      next();
    });

    this.logger.log(`Admission control: maxConnections=${maxConnections}, maxPendingHandshakes=${maxPendingHandshakes}`);

    return server;
  }
}
