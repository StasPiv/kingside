import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { RedisIoAdapter } from './common/redis-io.adapter';
// KS-4251 / ADR-131 A2a. Префикс /archive при Host=archive.kingside.site
// для совместимости со старым фронтом (apps/web ходит на поддомен без
// явного префикса; ALB не умеет path-rewrite).
import { archiveHostPrefixMiddleware } from './archive/archive-host-prefix.middleware';

/**
 * Determine whether to use Redis adapter for Socket.IO.
 * WS_USE_REDIS_ADAPTER: 'auto' (default) | 'true' | 'false'
 *   - 'true'  → always use Redis adapter
 *   - 'false' → always use in-memory adapter
 *   - 'auto'  → use Redis adapter only when ECS_TASK_COUNT > 1
 * ECS_TASK_COUNT: number of running ECS tasks (set by infra), default 1
 */
function shouldUseRedisAdapter(logger: Logger): boolean {
  const setting = (process.env.WS_USE_REDIS_ADAPTER || 'auto').toLowerCase();

  if (setting === 'true') {
    logger.log('WS_USE_REDIS_ADAPTER=true → forcing Redis adapter');
    return true;
  }
  if (setting === 'false') {
    logger.log('WS_USE_REDIS_ADAPTER=false → forcing in-memory adapter');
    return false;
  }

  // auto: check ECS_TASK_COUNT
  const taskCount = parseInt(process.env.ECS_TASK_COUNT || '1', 10);
  const useRedis = taskCount > 1;
  logger.log(`WS_USE_REDIS_ADAPTER=auto, ECS_TASK_COUNT=${taskCount} → ${useRedis ? 'Redis' : 'in-memory'} adapter`);
  return useRedis;
}

async function bootstrap() {
  // KS-3059: startup-timing telemetry для прода (CloudWatch). Помогает
  // отделить «модули резолвятся медленно» от «слишком много блокирующих
  // OnModuleInit»: если разница (T_listen − T_create) маленькая, узкое
  // место — DI/RouterExplorer; если большая — какой-то OnModuleInit.
  const T0 = Date.now();
  const logger = new Logger('Bootstrap');
  logger.log(`[startup-timing] T0=process-start (pid=${process.pid})`);

  const app = await NestFactory.create(AppModule);
  const T1 = Date.now();
  logger.log(
    `[startup-timing] NestFactory.create done at +${T1 - T0}ms (modules+DI+RouterExplorer)`,
  );
  const corsOrigins: (string | RegExp)[] = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
    : [];
  if (process.env.NODE_ENV !== 'production') {
    corsOrigins.push(/^http:\/\/localhost:\d+$/);
  }
  app.enableCors({
    origin: corsOrigins,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
    credentials: true,
  });
  // KS-4251 / ADR-131 A2a. Префикс /archive по Host'у — ДО body-parser'ов
  // и controllers, иначе RouterExplorer уже сматчит маршрут.
  app.use(archiveHostPrefixMiddleware);
  // KS-3629: подняли лимит body-parser с дефолтных 100KB до 1MB.
  // Под `/api/analyses/review/comments` приходит расширенный shape
  // FactsInput (MVP-2: ~325 байт/факт) × несколько десятков фактов
  // на партию. Дефолт упирался уже на средних разборах. Защита от
  // перегруза остаётся через JWT + rate-limit в ReviewCommentService.
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.useGlobalFilters(new AllExceptionsFilter());

  // Socket.IO adapter selection: Redis for multi-instance, in-memory for single
  const useRedisAdapter = shouldUseRedisAdapter(logger);
  if (useRedisAdapter) {
    try {
      const redisAdapter = new RedisIoAdapter(app);
      await redisAdapter.connectToRedis();
      app.useWebSocketAdapter(redisAdapter);
      logger.log('Socket.IO Redis adapter enabled');
    } catch (e: unknown) {
      logger.warn(`Redis adapter failed, using in-memory: ${(e as Error).message}`);
    }
  } else {
    logger.log('Socket.IO using in-memory adapter (single instance mode)');
  }

  const port = process.env.PORT || 3001;
  await app.listen(port, '0.0.0.0');
  const T2 = Date.now();
  logger.log(
    `[startup-timing] app.listen ready at +${T2 - T0}ms (this is the moment /health starts answering)`,
  );
  console.log(`Server running on http://0.0.0.0:${port}`);
}

bootstrap();
