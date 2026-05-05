import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';

/**
 * AppModule для tactic-worker (ADR-042 §1.2).
 *
 * NestJS standalone application: используется через
 * `NestFactory.createApplicationContext()` без HTTP-listener'а — у
 * воркера нет порта/CORS/middleware. CLI-диспатч живёт в `main.ts`.
 *
 * Подключаем ConfigModule (ENV из task-def Secrets Manager) и
 * PrismaModule (writer основной БД для `tactic_drills`, `puzzles`).
 *
 * Дополнительные модули будут добавляться по мере появления subcommand'ов:
 *   - StockfishModule (для sf-validate-drills, KS-2440 / §9.3 ADR);
 *   - PuzzleGeneratorModule (для KS-2431).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
    }),
    PrismaModule,
  ],
})
export class AppModule {}
