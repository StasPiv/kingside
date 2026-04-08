import { IoAdapter } from '@nestjs/platform-socket.io';
import { INestApplication, Logger } from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import { ServerOptions } from 'socket.io';
import Redis, { RedisOptions } from 'ioredis';

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
    return server;
  }
}
