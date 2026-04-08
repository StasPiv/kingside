import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { RedisIoAdapter } from './common/redis-io.adapter';

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
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
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
  console.log(`Server running on http://0.0.0.0:${port}`);
}

bootstrap();
