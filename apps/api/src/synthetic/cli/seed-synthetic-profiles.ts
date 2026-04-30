/**
 * KS-2162. Standalone CLI: `node dist/synthetic/cli/seed-synthetic-profiles.js [count]`.
 *
 * Поднимает минимальный Nest-context (PrismaService + SyntheticProfileSeederService),
 * вызывает `seed(count ?? 200)`, печатает отчёт, выходит.
 *
 * Под `npm run seed:synthetic` нужно добавить script в `apps/api/package.json`:
 *   "seed:synthetic": "node dist/synthetic/cli/seed-synthetic-profiles.js"
 * (devops при подключении).
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { SyntheticModule } from '../synthetic.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { SyntheticProfileSeederService } from '../synthetic-profile-seeder.service';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

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
class SeedAppModule {}

async function main(): Promise<number> {
  const logger = new Logger('cli:seed-synthetic');
  const args = process.argv.slice(2);
  const count = args[0] ? Number.parseInt(args[0], 10) : 200;
  if (!Number.isFinite(count) || count <= 0) {
    logger.error(`Invalid count: ${args[0]}`);
    return 1;
  }

  const app = await NestFactory.createApplicationContext(SeedAppModule, {
    logger: ['error', 'warn', 'log'],
  });
  let exitCode = 0;
  try {
    const seeder = app.get(SyntheticProfileSeederService);
    const report = await seeder.seed(count);
    logger.log(
      `seed report: created=${report.created} legacyBackfilled=${report.legacyBotsBackfilled} ` +
        `totalBefore=${report.totalBefore} totalAfter=${report.totalAfter} noop=${report.noop}`,
    );
  } catch (err) {
    logger.error(`seed failed: ${(err as Error).message}`);
    exitCode = 1;
  } finally {
    await app.close().catch(() => undefined);
  }
  return exitCode;
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}
