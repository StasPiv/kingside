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

      this.adapterConstructor = createAdapter(pubClient, subClient, { key: 'socket.io-game' });
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

      this.adapterConstructor = createAdapter(pubClient, subClient, { key: 'socket.io-game' });
    }

    this.logger.log(`Redis adapter connected (${connLabel})`);
  }

  /** Cached server — single Socket.IO Server for all namespaces */
  private cachedServer: any = null;

  createIOServer(port: number, options?: ServerOptions) {
    // Return cached server for subsequent namespace registrations
    if (this.cachedServer) {
      this.logger.log(`createIOServer: reusing cached server`);
      return this.cachedServer;
    }

    this.logger.log(`createIOServer called: port=${port}`);
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }

    server.on('new_namespace', (nsp: any) => {
      this.logger.log(`Namespace registered: ${nsp.name}`);
    });

    const maxConnections = parseInt(process.env.WS_MAX_CONNECTIONS || '500', 10);
    const maxPendingHandshakes = parseInt(process.env.WS_MAX_PENDING_HANDSHAKES || '20', 10);
    let pendingHandshakes = 0;

    server.use((socket: any, next: (err?: Error) => void) => {
      if (ScalingService.busy) {
        this.logger.warn('Admission control: rejecting connection (server busy)');
        return next(new Error(JSON.stringify({ type: 'server_busy', retryAfter: 60 })));
      }
      const clientsCount = server.engine?.clientsCount ?? 0;
      if (clientsCount >= maxConnections) {
        this.logger.warn(`Admission control: rejecting (${clientsCount}/${maxConnections})`);
        return next(new Error(JSON.stringify({ type: 'server_busy', retryAfter: 60 })));
      }
      if (pendingHandshakes >= maxPendingHandshakes) {
        this.logger.warn(`Handshake rate limit: rejecting (${pendingHandshakes}/${maxPendingHandshakes})`);
        return next(new Error(JSON.stringify({ type: 'server_busy', retryAfter: 5 })));
      }
      pendingHandshakes++;
      setImmediate(() => { pendingHandshakes = Math.max(0, pendingHandshakes - 1); });
      next();
    });

    this.logger.log(`Admission control: maxConnections=${maxConnections}, maxPendingHandshakes=${maxPendingHandshakes}`);
    this.cachedServer = server;

    return server;
  }
}
