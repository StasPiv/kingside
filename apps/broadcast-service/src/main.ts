import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { RedisIoAdapter } from './redis/redis-io.adapter';

/**
 * broadcast-service bootstrap (ADR-021 §2.3).
 *
 * Особенности:
 * - Публичные пути (KS-1702, без префикса `/broadcasts`): `/`, `/:id`,
 *   `/:id/rounds`, `/:id/rounds/:roundId/games`, `/:id/standings`.
 *   Служебные — под `/_` (health, metrics).
 * - WS default namespace `/` (KS-1702, без `/broadcast`) через `RedisIoAdapter` —
 *   на ECS за ALB с sticky sessions всё равно возможно переключение инстансов
 *   между HTTP и WS, и sync-loop (`BroadcastSyncService`) публикует
 *   `broadcast:move` / `broadcast:sync` в Redis, а socket.io-rooms должны
 *   быть синхронизированы между всеми инстансами.
 * - Аутентификации нет — данные public read-only (ADR-021 §2.1).
 * - CORS: GET/HEAD, credentials=false. Origin-ы из `CORS_ORIGIN`.
 */
async function bootstrap() {
  const logger = new Logger('BroadcastService');
  const app = await NestFactory.create(AppModule);

  const corsOriginEnv = process.env.CORS_ORIGIN;
  const isProd = process.env.NODE_ENV === 'production';
  const corsOrigins: (string | RegExp)[] = corsOriginEnv
    ? corsOriginEnv
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    : [];

  if (corsOrigins.length === 0) {
    if (isProd) {
      logger.error(
        'CORS_ORIGIN env variable is required in production (comma-separated list of allowed origins)',
      );
      throw new Error('CORS_ORIGIN is not set');
    }
    corsOrigins.push(/^http:\/\/localhost:\d+$/);
    logger.warn(
      'CORS_ORIGIN not set — using dev default http://localhost:<any-port>',
    );
  }

  app.enableCors({
    origin: corsOrigins,
    methods: ['GET', 'HEAD'],
    credentials: false,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());

  // Redis pub/sub adapter — нужен для sync ws-rooms между ECS-инстансами
  // и для получения событий broadcast:move / broadcast:sync от sync-loop
  // (ADR-022: sync-loop живёт в том же процессе под флагом
  // BROADCAST_SYNC_ENABLED).
  const redisAdapter = new RedisIoAdapter(app);
  await redisAdapter.connectToRedis();
  app.useWebSocketAdapter(redisAdapter);

  // ADR-022 §2.4.4: включаем shutdown hooks, чтобы на SIGTERM отрабатывали
  // OnModuleDestroy у BroadcastSyncService (clearInterval, abort streams,
  // redis.del локов, pubRedis.quit), BroadcastGateway (subRedis.quit) и
  // прочих сервисов. Без этого Node просто exitнется, соединения останутся
  // «грязными».
  app.enableShutdownHooks();

  const port = process.env.PORT || process.env.BROADCAST_SERVICE_PORT || 3004;
  await app.listen(port, '0.0.0.0');
  logger.log(`broadcast-service listening on http://0.0.0.0:${port}`);
}

bootstrap();
