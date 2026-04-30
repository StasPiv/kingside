/**
 * KS-2179 follow-up. Standalone CLI:
 *   `node dist/synthetic/cli/remirror-avatars.js`
 *
 * Перезаливает аватары в S3 для ВСЕХ существующих `is_synthetic=true`
 * пользователей. Нужен после `aws s3 rm s3://kingside-synthetic-avatars
 * --recursive` (либо после первой раскатки mirror'а на уже-сидированную
 * БД), потому что обычный `seed:synthetic` отрабатывает no-op
 * (`totalBefore=200 ≥ target=200`) и мимо mirror'а проходит.
 *
 * Логика — идемпотентна и за счёт `mirror.mirror()`:
 *   - для каждого synthetic'а делает `HEAD <bucket>/<username>.png`,
 *   - если объект уже там — пропускает PUT, лог `skipped (already
 *     in S3)`,
 *   - иначе скачивает DiceBear → PUT в S3, лог `uploaded`.
 *   - на любую ошибку — лог warn, продолжает следующий.
 *
 * Без флага `SYNTHETIC_AVATARS_MIRRORING_ENABLED=true` сервис вернёт
 * `null` на каждый вызов — CLI напишет общий warn и выйдет с
 * exitCode=2 (явный сигнал «вы забыли env, ничего не сделано»).
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SyntheticModule } from '../synthetic.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { SyntheticAvatarMirrorService } from '../synthetic-avatar-mirror.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
    }),
    PrismaModule,
    SyntheticModule,
  ],
})
class RemirrorAppModule {}

const PROGRESS_LOG_EVERY = 25;

interface Stats {
  total: number;
  uploaded: number;
  skippedExisting: number;
  failed: number;
}

async function main(): Promise<number> {
  const logger = new Logger('cli:remirror-avatars');
  const app = await NestFactory.createApplicationContext(RemirrorAppModule, {
    logger: ['error', 'warn', 'log'],
  });
  let exitCode = 0;
  try {
    const prisma = app.get(PrismaService);
    const mirror = app.get(SyntheticAvatarMirrorService);
    if (!mirror.enabled()) {
      logger.error(
        'SYNTHETIC_AVATARS_MIRRORING_ENABLED != "true" — cannot remirror, ' +
          'set the env and re-run',
      );
      return 2;
    }
    const bucket = mirror.bucket();
    if (!bucket) {
      logger.error(
        'SYNTHETIC_AVATARS_S3_BUCKET not set — cannot remirror',
      );
      return 2;
    }

    const synthetics = await prisma.user.findMany({
      where: { isSynthetic: true },
      select: { id: true, username: true },
    });
    if (synthetics.length === 0) {
      logger.warn('No synthetic users found in DB — nothing to remirror');
      return 0;
    }
    logger.log(
      `remirror start: ${synthetics.length} synthetic users, bucket=${bucket}`,
    );

    const stats: Stats = {
      total: synthetics.length,
      uploaded: 0,
      skippedExisting: 0,
      failed: 0,
    };
    const startMs = Date.now();

    for (let i = 0; i < synthetics.length; i++) {
      const u = synthetics[i];
      if (!u.username) {
        // synthetic'и в KS-2162 всегда с username — но защищаемся.
        stats.failed++;
        continue;
      }
      try {
        // mirror.mirror() сам делает HEAD → PUT/skip; возвращает URL
        // либо null. Чтобы понять «новый PUT» vs «skip already
        // existing», смотрим на счётчик файла в S3 — но это лишний
        // round-trip. Для CLI достаточно знать факт успешности: URL
        // не null = успех (любой). Скип vs PUT внутри — детали mirror'а.
        const url = await mirror.mirror(u.username);
        if (url) {
          // Differentiate skip vs upload через дополнительный HEAD —
          // overhead на бесплатный round-trip; не делаем. На каждый
          // успех считаем uploaded; skip нумерация в логе у mirror'а
          // же есть («S3 mirror: object exists, skip PUT»). Для CLI
          // важнее total успехов, не разбивка.
          stats.uploaded++;
        } else {
          stats.failed++;
        }
      } catch (err) {
        stats.failed++;
        logger.warn(
          `remirror failed for ${u.username}: ${(err as Error).message}`,
        );
      }
      if ((i + 1) % PROGRESS_LOG_EVERY === 0) {
        logger.log(
          `remirror progress: ${i + 1}/${stats.total} ` +
            `uploaded=${stats.uploaded} failed=${stats.failed}`,
        );
      }
    }

    const durationSec = Math.round((Date.now() - startMs) / 1000);
    logger.log(
      `remirror done: total=${stats.total} uploaded=${stats.uploaded} ` +
        `failed=${stats.failed} durationSec=${durationSec}`,
    );
    if (stats.failed > 0 && stats.uploaded === 0) {
      // Все сломалось — exit code 2.
      exitCode = 2;
    } else if (stats.failed > 0) {
      // Частично прошло — exit code 1.
      exitCode = 1;
    }
  } catch (err) {
    logger.error(`remirror fatal: ${(err as Error).message}`);
    exitCode = 1;
  } finally {
    await app.close().catch(() => undefined);
  }
  return exitCode;
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}
