import { Module } from '@nestjs/common';

import { BoardRecognitionController } from './board-recognition.controller';
import {
  BOARD_RECOGNIZER,
  BoardRecognitionService,
} from './board-recognition.service';
import { ModelLoaderService } from './model-loader.service';
import { RecognizeUniversalProvider } from './recognize-universal.provider';

/**
 * KS-2363 / ADR-040 §5.1. POST /api/board-recognition.
 *
 * Модуль регистрируется в `app.module.ts` ВСЕГДА — graceful disable
 * включается внутри `BoardRecognitionService` на основе состояния
 * `ModelLoaderService` (см. `model-loader.service.ts`). Это даёт
 * предсказуемый routing и health-check без условной регистрации
 * модулей на уровне Nest.
 */
@Module({
  controllers: [BoardRecognitionController],
  providers: [
    ModelLoaderService,
    BoardRecognitionService,
    {
      provide: BOARD_RECOGNIZER,
      useClass: RecognizeUniversalProvider,
    },
  ],
  exports: [ModelLoaderService],
})
export class BoardRecognitionModule {}
