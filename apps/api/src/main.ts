import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { RedisIoAdapter } from './common/redis-io.adapter';

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

  // Socket.IO Redis adapter for horizontal scaling
  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisPort = parseInt(process.env.REDIS_PORT || '6380', 10);
  try {
    const redisAdapter = new RedisIoAdapter(app, redisHost, redisPort);
    await redisAdapter.connectToRedis();
    app.useWebSocketAdapter(redisAdapter);
    logger.log('Socket.IO Redis adapter enabled');
  } catch (e: unknown) {
    logger.warn(`Redis adapter failed, using in-memory: ${(e as Error).message}`);
  }

  const port = process.env.PORT || 3001;
  await app.listen(port, '0.0.0.0');
  console.log(`Server running on http://0.0.0.0:${port}`);
}

bootstrap();
