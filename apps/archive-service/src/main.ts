import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

/**
 * archive-service bootstrap.
 *
 * Особенности (ADR-018 §2.4):
 * - БЕЗ `setGlobalPrefix` — публичные пути `/tree`, `/games`, `/games/:id`,
 *   `/games/by-position`. Служебные под префиксом `/_` (health, metrics).
 * - CORS: только GET/HEAD, `credentials: false`. Origin-ы — из
 *   `CORS_ORIGIN` (comma-separated).
 * - Аутентификации нет — endpoints публичные.
 */
async function bootstrap() {
  const logger = new Logger('ArchiveService');
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

  const port = process.env.ARCHIVE_SERVICE_PORT || 3003;
  await app.listen(port, '0.0.0.0');
  logger.log(`archive-service listening on http://0.0.0.0:${port}`);
}

bootstrap();
