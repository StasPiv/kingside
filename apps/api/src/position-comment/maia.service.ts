/**
 * KS-4070 follow-up. Серверная обёртка над Maia-3 engine для
 * `position-comment` модуля. Используется как часть фильтра форсированных
 * линий: для каждой позиции Maia возвращает распределение вероятностей
 * по легальным ходам, и пара (top-1 ход, его вероятность) используется
 * как сигнал «насколько очевиден этот ход человеку».
 *
 * Lifecycle: singleton, ленивая инициализация. Первый запрос загружает
 * `.onnx`-модель через `@kingside/maia-core/node-provider` и создаёт
 * ONNX-сессию. Дальнейшие запросы переиспользуют сессию.
 *
 * Сервис graceful: если модель не найдена или ORT-init упал, дальнейшие
 * вызовы возвращают `null` без исключений — caller (`ForcedLineRoller`)
 * интерпретирует это как «Maia недоступна, форсированную линию не
 * прокатываем». Так модуль не падает, если в окружении нет модели.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Maia,
  createNodeProvider,
  loadModelFromFs,
  type PredictResult,
} from '@kingside/maia-core';

@Injectable()
export class MaiaService {
  private readonly logger = new Logger(MaiaService.name);
  private readonly modelPath: string;
  private readonly elo: number;
  private engine: Maia | null = null;
  private initFailed = false;

  constructor(private readonly config: ConfigService) {
    this.modelPath = this.config.get<string>(
      'POSITION_COMMENT_MAIA_MODEL_PATH',
      '/project/tools/maia3/maia3_simplified.onnx',
    );
    this.elo = parseInt(
      this.config.get<string>('POSITION_COMMENT_MAIA_ELO', '2400'),
      10,
    );
  }

  /**
   * Возвращает policy от Maia для заданной FEN. ELO одинаковый для
   * обеих сторон (моделируем «оба игрока — рейтинга X»).
   *
   * Если Maia недоступна (модель не найдена, ORT упал на первом
   * запросе) — возвращает `null`, caller сам решает, что делать.
   */
  async predict(fen: string): Promise<PredictResult | null> {
    if (this.initFailed) return null;
    const engine = await this.getEngine();
    if (!engine) return null;
    try {
      return await engine.predictMoves(fen, this.elo, this.elo);
    } catch (e) {
      this.logger.warn(
        `maia.predict failed for fen=${fen.slice(0, 40)}...: ${(e as Error).message}`,
      );
      return null;
    }
  }

  private async getEngine(): Promise<Maia | null> {
    if (this.engine) return this.engine;
    if (this.initFailed) return null;
    try {
      this.logger.log(
        `Maia init: loading ${this.modelPath} (ELO=${this.elo})...`,
      );
      const t0 = Date.now();
      const maia = new Maia({
        provider: createNodeProvider(),
        fetchBuffer: () => loadModelFromFs(this.modelPath),
      });
      await maia.ensureSession();
      this.engine = maia;
      this.logger.log(`Maia init: ready (${Date.now() - t0}ms)`);
      return this.engine;
    } catch (e) {
      this.initFailed = true;
      this.logger.warn(
        `Maia init failed: ${(e as Error).message}. Forced-line filter disabled.`,
      );
      return null;
    }
  }
}
