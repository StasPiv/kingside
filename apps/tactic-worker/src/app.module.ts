import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { StockfishModule } from './stockfish/stockfish.module';

/**
 * AppModule для tactic-worker (ADR-042 §1.2).
 *
 * NestJS standalone application: используется через
 * `NestFactory.createApplicationContext()` без HTTP-listener'а — у
 * воркера нет порта/CORS/middleware. CLI-диспатч живёт в `main.ts`.
 *
 * Подключаем ConfigModule (ENV из task-def Secrets Manager),
 * PrismaModule (writer основной БД), StockfishModule (нужен для
 * puzzle-generator KS-2431 и sf-validator §9.3 ADR-042 / KS-2440).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
    }),
    PrismaModule,
    StockfishModule,
  ],
})
export class AppModule {}
