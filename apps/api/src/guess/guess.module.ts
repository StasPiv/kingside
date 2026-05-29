import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { GuessController } from './guess.controller';
import { GuessService } from './guess.service';

/**
 * KS-3409 / ADR-086 §9 B2. Модуль guess-the-move:
 * /guess/sessions (start/move/finish/review) + /guess/history.
 * Движок на сервере не запускается — server-trust по WDL с клиента.
 */
@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [GuessController],
  providers: [GuessService],
  exports: [GuessService],
})
export class GuessModule {}
