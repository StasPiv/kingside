import 'reflect-metadata';
import * as os from 'os';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { RedisIoAdapter } from './common/redis-io.adapter';

const INSTANCE_ID = os.hostname().slice(-12);

function shouldUseRedisAdapter(logger: Logger): boolean {
  const setting = (process.env.WS_USE_REDIS_ADAPTER || 'auto').toLowerCase();
  if (setting === 'true') { logger.log('Redis adapter forced'); return true; }
  if (setting === 'false') { logger.log('In-memory adapter forced'); return false; }
  const taskCount = parseInt(process.env.ECS_TASK_COUNT || '1', 10);
  const useRedis = taskCount > 1;
  logger.log(`WS_USE_REDIS_ADAPTER=auto, ECS_TASK_COUNT=${taskCount} → ${useRedis ? 'Redis' : 'in-memory'}`);
  return useRedis;
}

async function bootstrap() {
  const logger = new Logger('GameService');
  logger.log(`Instance: ${INSTANCE_ID} (hostname: ${os.hostname()})`);

  const app = await NestFactory.create(AppModule);
  // No global prefix — Game Service is WS-primary, health at /health
  app.enableCors({ origin: '*', credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.useGlobalFilters(new AllExceptionsFilter());

  const useRedisAdapter = shouldUseRedisAdapter(logger);
  if (useRedisAdapter) {
    try {
      const redisAdapter = new RedisIoAdapter(app);
      await redisAdapter.connectToRedis();
      app.useWebSocketAdapter(redisAdapter);
      logger.log('Socket.IO Redis adapter enabled');
    } catch (e: unknown) {
      logger.warn(`Redis adapter failed: ${(e as Error).message}`);
    }
  }

  const port = process.env.PORT || 3002;
  await app.listen(port, '0.0.0.0');
  logger.log(`Game Service running on http://0.0.0.0:${port} [${INSTANCE_ID}]`);
}

bootstrap();
