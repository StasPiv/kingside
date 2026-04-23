/**
 * CLI: `node dist/sync-once.js` — один tick BroadcastSyncService и выход.
 *
 * Зачем нужен: dev-окружение хочет вручную «затянуть Lichess top-20
 * broadcasts» без ожидания 5-минутного интервала планировщика. Этот CLI
 * делает один immediate sync и завершает процесс.
 *
 * Алгоритм:
 *   1. Bootstrap NestJS application context (без HTTP-сервера, без
 *      Socket.IO, без таймеров `BroadcastSyncService.start`).
 *   2. Достаём `BroadcastSyncService` через DI.
 *   3. Вручную вызываем `start()` — он делает immediate `syncBroadcasts()`
 *      AWAIT'ом, затем ставит `setInterval`.
 *   4. Сразу вызываем `stop()` — clear timer, abort streams, quit pubRedis.
 *   5. Закрываем app context, exit(0).
 *
 * Контракт фича-флага: устанавливаем `BROADCAST_SYNC_ENABLED='true'` ДО
 * bootstrap, чтобы `onModuleInit` сам вызвал `start()`. Если оставить
 * флаг false — `onModuleInit` пропустит инициализацию (HTTP-only mode), и
 * у нас не будет pubRedis, и `processPgnUpdate.publishMove` молча
 * проглотит publish'ы (что не критично для одного tick'а — публикации
 * нужны фронту, который в dev и так ничего не подписан).
 *
 * Параллельно sync-loop в проде/dev НЕ затрагивается — этот CLI запускает
 * собственный shortlived процесс, чужой процесс свой scheduler ведёт сам.
 * Дедуп через Redis-lock `broadcast:sync:lock` (TTL 4 мин) защитит от
 * параллельного запуска двух sync'ов.
 */

import 'reflect-metadata';
import { Logger, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { BroadcastSyncService } from './sync/broadcast-sync.service';

async function bootstrap(): Promise<number> {
  const logger = new Logger('sync-once');

  // Включаем sync-флаг до bootstrap — иначе onModuleInit пропустит start().
  process.env.BROADCAST_SYNC_ENABLED = 'true';

  let app: INestApplicationContext | null = null;
  try {
    app = await NestFactory.createApplicationContext(AppModule, {
      bufferLogs: false,
    });
    const sync = app.get(BroadcastSyncService);
    // start() в OnModuleInit уже мог вызваться (мы выставили флаг). Но он
    // запустил syncBroadcasts() fire-and-forget вместе с timer'ом. Чтобы
    // дождаться первого tick'а — вызовем syncBroadcasts() ещё раз
    // (Redis-lock защитит от двойного выполнения, второй вызов вернётся с
    // skipped). Альтернатива — start() уже сделал await на первом tick'е,
    // поэтому к моменту инжекта он завершён. Делаем дополнительный явный
    // вызов как страховку.
    logger.log('Triggering one explicit syncBroadcasts() tick…');
    await sync.syncBroadcasts();
    logger.log('Tick complete.');
    return 0;
  } catch (err: unknown) {
    const msg = (err as Error).message;
    logger.error(`sync-once failed: ${msg}`);
    return 1;
  } finally {
    if (app) {
      try {
        // app.close() запустит OnModuleDestroy у BroadcastSyncService →
        // stop() → clearInterval + activeStreams.abort() + pubRedis.quit().
        // Также закроет PrismaService и RedisService.
        await app.close();
      } catch (err: unknown) {
        // eslint-disable-next-line no-console
        console.error('app.close error:', (err as Error).message);
      }
    }
  }
}

if (require.main === module) {
  bootstrap()
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[sync-once] Unhandled:', err);
      process.exit(1);
    });
}
