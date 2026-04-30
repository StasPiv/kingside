import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

/**
 * Bootstrap synthetic-bot-service.
 *
 * Graceful shutdown:
 *   - app.enableShutdownHooks() включает реакцию на SIGTERM/SIGINT.
 *   - ECS stopTimeout = 120 сек (см. ADR-034-v2 §5.4).
 *   - В B2v2 BotManager регистрирует onModuleDestroy hook для drain'а активных ботов.
 *
 * Порт liveness: HEALTH_PORT (по умолчанию 3010).
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('SyntheticBotService');

  const app = await NestFactory.create(AppModule);

  // Slушаем SIGTERM/SIGINT и вызываем onModuleDestroy у провайдеров.
  app.enableShutdownHooks();

  const port = parseInt(process.env.HEALTH_PORT || '3010', 10);
  await app.listen(port, '0.0.0.0');

  logger.log(`Synthetic Bot Service listening on http://0.0.0.0:${port}`);
  logger.log(`taskId=${process.env.ECS_TASK_ID || 'local'} pid=${process.pid}`);

  // Лог реакции на SIGTERM — без вызова process.exit. Nest сам корректно закроет
  // приложение через enableShutdownHooks() и event-loop опустеет.
  const onSignal = (signal: NodeJS.Signals): void => {
    logger.log(`Received ${signal}, shutting down gracefully`);
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed', err);
  process.exit(1);
});
