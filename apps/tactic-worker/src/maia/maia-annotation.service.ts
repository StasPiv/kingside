/**
 * KS-3633 / ADR-104 §5 (MVP-2 Precision-Maia, T2).
 *
 * Continuous-annotation новых Precision-пазлов: после успешного INSERT
 * нового пазла прогоняем Maia-3 inference на исходном FEN, берём
 * вероятность правильного хода (`puzzle.moves[0]` или его mirror —
 * см. ниже) и записываем в `maia_top1_prob` / `maia_top1_elo`.
 *
 * Архитектура:
 *  - Singleton: один Maia-engine на процесс (ONNX-сессия живёт пока
 *    жив воркер). Lazy-init по первому вызову `annotate`.
 *  - Provider — `createNodeProvider()` из `@kingside/maia-core`
 *    (onnxruntime-web через WASM; `onnxruntime-node` сегфолтит в
 *    Docker, см. KS-3577 smoke).
 *  - Модель грузится из FS по пути `PRECISION_MAIA_MODEL_PATH`
 *    (default `apps/web/public/maia3/maia3_simplified.onnx`).
 *  - Graceful: любая ошибка (модель не загрузилась, inference exception)
 *    → возвращаем `null`. Caller обновляет UPDATE-row пустыми полями
 *    (то есть оставляет NULL — фронт неразмеченные пазлы не отсеивает).
 *  - Feature-flag: `PRECISION_MAIA_ANNOTATION_ENABLED=false` → сервис
 *    в disabled-режиме (`annotate()` всегда `null`).
 *
 * Hook вставлен в `insertPuzzle`-коллбеки CLI-генераторов
 * (`generate-puzzles.cli.ts`, `generate-puzzles-from-twic.cli.ts`):
 * после успешного `createMany.count > 0` вызывается `annotate()` и
 * `prisma.puzzle.update({ where: { id }, data: {...} })`. Hook
 * срабатывает только для `solutionMode === 'play-vs-engine'` — для
 * forced-line пазлов Maia-разметка не нужна (precision-каталог только
 * play-vs-engine).
 */
import { Logger } from '@nestjs/common';
import {
  Maia,
  createNodeProvider,
  loadModelFromFs,
  mirrorMove,
  type PredictResult,
} from '@kingside/maia-core';

export interface MaiaAnnotation {
  /** Вероятность правильного хода по Maia (0..1). */
  prob: number;
  /** ELO под которым прогнали (см. `PRECISION_MAIA_ANNOTATION_ELO`). */
  elo: number;
  /** Latency inference, мс (для логов/метрик). */
  latencyMs: number;
}

export interface MaiaAnnotationServiceConfig {
  /** Путь к ONNX-модели Maia-3. */
  modelPath: string;
  /** ELO для разметки. */
  elo: number;
  /** Если false — сервис отключён (annotate → null). */
  enabled: boolean;
}

/**
 * Singleton-обёртка над Maia engine для T2 (continuous annotation).
 *
 * Не помечен `@Injectable` — пайплайн tactic-worker'а не использует
 * DI глобально, CLI-генераторы создают сервис вручную в bootstrap
 * (см. `generate-puzzles.cli.ts`). Это согласуется со стилем других
 * хелперов (`StockfishService` инстанцируется в CLI, не через @Inject).
 */
export class MaiaAnnotationService {
  private readonly logger = new Logger(MaiaAnnotationService.name);
  private maia: Maia | null = null;
  /** Чтобы не пытаться загружать модель повторно если упало. */
  private initFailed = false;

  constructor(private readonly config: MaiaAnnotationServiceConfig) {}

  /**
   * Извлекает конфигурацию из ENV. Используется когда нет ConfigService
   * (CLI-bootstrap).
   *
   *  - `PRECISION_MAIA_ANNOTATION_ENABLED` — `false`/`0` → disabled.
   *  - `PRECISION_MAIA_ANNOTATION_ELO` — default 1500.
   *  - `PRECISION_MAIA_MODEL_PATH` — default `apps/web/public/maia3/maia3_simplified.onnx`.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): MaiaAnnotationService {
    const enabledRaw = (env.PRECISION_MAIA_ANNOTATION_ENABLED ?? 'true').toLowerCase();
    const enabled = !(enabledRaw === 'false' || enabledRaw === '0' || enabledRaw === 'off');
    const elo = parseInt(env.PRECISION_MAIA_ANNOTATION_ELO ?? '1500', 10);
    // Default — `tools/maia3/maia3_simplified.onnx` (KS-3633: координатор
    // положил модель туда; apps/web/public/maia3/ не примонтирована в
    // tactic-worker-контейнере). В prod-Docker tactic-worker'а модели
    // пока нет в образе — kill-switch graceful переведёт сервис в
    // disabled-режим (новые пазлы с NULL, фронт не отсеет).
    const modelPath =
      env.PRECISION_MAIA_MODEL_PATH ?? 'tools/maia3/maia3_simplified.onnx';
    return new MaiaAnnotationService({
      modelPath,
      elo: Number.isFinite(elo) ? elo : 1500,
      enabled,
    });
  }

  isEnabled(): boolean {
    return this.config.enabled && !this.initFailed;
  }

  /**
   * Размечает один пазл: возвращает вероятность правильного хода
   * (`solutionUci`) и ELO разметки. Любая ошибка → `null` + лог WARN;
   * caller записывает в БД соответствующие NULL.
   *
   * `solutionUci` — первый ход решения (для play-vs-engine это
   * `puzzle.moves[0]`, UCI без зеркала; mirror делается внутри Maia
   * под капотом).
   */
  async annotate(
    puzzleId: string,
    fen: string,
    solutionUci: string,
  ): Promise<MaiaAnnotation | null> {
    if (!this.isEnabled()) return null;

    const t0 = Date.now();
    let result: PredictResult;
    try {
      const engine = await this.getEngine();
      result = await engine.predictMoves(fen, this.config.elo, this.config.elo);
    } catch (e) {
      this.logger.warn(
        `maia-annotate puzzle=${puzzleId} failed: ${(e as Error).message}`,
      );
      // kill-switch на init-фейле — `getEngine` его выставляет сам
      // через `initFailed = true` если `ensureSession()` упало. Для
      // редких ошибок ENOENT/ORT во время одиночного inference после
      // успешной сессии — не отключаем сервис (это может быть временное).
      return null;
    }
    const latencyMs = Date.now() - t0;

    // Maia зеркалит ходы внутри (mirrorMove применяется к выходу для
    // ходов чёрных). Сравниваем напрямую с `solutionUci`. Хорошая
    // защита от рассинхронизации — попробуем и зеркальный вариант, и
    // прямой; берём максимум (теоретически совпадение должно быть
    // ровно одно).
    const probDirect =
      result.policy.find((p) => p.move === solutionUci)?.probability ?? 0;
    const probMirror =
      result.policy.find((p) => p.move === mirrorMove(solutionUci))
        ?.probability ?? 0;
    const prob = Math.max(probDirect, probMirror);

    this.logger.log(
      `maia-annotate puzzle=${puzzleId} prob=${prob.toFixed(4)} elo=${this.config.elo} latency=${latencyMs}ms`,
    );

    return { prob, elo: this.config.elo, latencyMs };
  }

  /**
   * Лениво создаёт Maia engine. Идемпотентно — если уже создан,
   * возвращает ту же ссылку. Если `ensureSession()` упало (модель не
   * найдена, ORT-init сломался) — поднимает `initFailed = true` и
   * пробрасывает ошибку наверх. Дальнейшие `annotate()` сразу вернут
   * null без попыток.
   */
  private async getEngine(): Promise<Maia> {
    if (this.maia) return this.maia;

    this.logger.log(
      `Maia init: loading model from ${this.config.modelPath} (ELO=${this.config.elo})...`,
    );
    const t0 = Date.now();
    const maia = new Maia({
      provider: createNodeProvider(),
      fetchBuffer: () => loadModelFromFs(this.config.modelPath),
    });
    try {
      await maia.ensureSession();
    } catch (e) {
      this.initFailed = true;
      throw e;
    }
    this.maia = maia;
    this.logger.log(`Maia init: ready (init ${Date.now() - t0}ms)`);
    return this.maia;
  }
}
