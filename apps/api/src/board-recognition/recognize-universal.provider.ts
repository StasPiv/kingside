import { Injectable, Logger } from '@nestjs/common';

import {
  BoardRecognizer,
  RecognizeUniversalResult,
} from './board-recognition.service';
import { BoardRecognitionProfile } from './dto/recognize-board.dto';

/**
 * Реальная реализация `BoardRecognizer`, делегирующая в
 * `recognizeUniversal()` из `@kingside/board-image-to-fen`.
 *
 * Импортируем пакет лениво (`await import(...)`), потому что:
 *   1. Он ESM (`type: module`), а apps/api скомпилирован в CommonJS —
 *      `await import()` корректно работает в CJS-окружении.
 *   2. Disabled-режим (без модели) не должен загружать пакет в память
 *      и его транзитивные зависимости.
 */
@Injectable()
export class RecognizeUniversalProvider implements BoardRecognizer {
  private readonly logger = new Logger(RecognizeUniversalProvider.name);
  private universalFn:
    | ((
        imagePath: string,
        options: Record<string, unknown>,
      ) => Promise<unknown>)
    | null = null;

  async recognize(
    imagePath: string,
    options: {
      profile: BoardRecognitionProfile;
      modelPath?: string | null;
    },
  ): Promise<RecognizeUniversalResult> {
    const fn = await this.getRecognizeUniversal();
    const raw = (await fn(imagePath, {
      profile: options.profile,
      modelPath: options.modelPath ?? undefined,
      // `auto` — ориентацию определяет board_recognize.py.
      orientation: 'auto',
    })) as RecognizeUniversalResult;
    return raw;
  }

  private async getRecognizeUniversal() {
    if (this.universalFn) return this.universalFn;
    // Workspace package — резолвится через npm workspaces. Импорт ленивый,
    // чтобы disabled-режим не тащил `child_process`/`fs` лишний раз.
    const mod = (await import(
      '@kingside/board-image-to-fen'
    )) as typeof import('@kingside/board-image-to-fen');
    this.universalFn = mod.recognizeUniversal as unknown as (
      imagePath: string,
      options: Record<string, unknown>,
    ) => Promise<unknown>;
    this.logger.log('loaded @kingside/board-image-to-fen lazily');
    return this.universalFn;
  }
}
