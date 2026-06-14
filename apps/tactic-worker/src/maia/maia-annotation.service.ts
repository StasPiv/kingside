/**
 * KS-3633 / ADR-104 §5 → KS-3640 / ADR-106 §2.1 (Precision-Maia v2, T2).
 *
 * Continuous-annotation новых Precision-пазлов. После успешного INSERT
 * нового PVE-пазла вычисляем `maia_weak_choice_prob` по ADR-106 §2.1:
 *
 *   1. Maia inference → распределение `policy[m]` по всем легальным
 *      ходам на стартовой FEN пазла.
 *   2. `maiaTopK = { m | policy[m] > 0.10 } ∩ top-8 by policy`.
 *   3. `searchmoves = unique([firstMovePV1, ...maiaTopK])`.
 *   4. SF MultiPV-eval с `searchmoves`, depth = ENV
 *      `PRECISION_MAIA_SF_DEPTH` (default 15) → WDL по каждому.
 *   5. `bestE = max(expectedScoreFromWdl(wdl_i))` среди searchmoves.
 *   6. `weak_set = { m ∈ maiaTopK | bestE − expectedScoreFromWdl(wdl_m)
 *                                   > 0.02 }`.
 *   7. `maiaWeakChoiceProb = Σ policy[m]` для m ∈ weak_set.
 *
 * `firstMovePV1` берётся из `Puzzle.sourceMetadata` (поле, которое
 * генератор уже заполняет, см. `generator-pipeline.ts:367`). Caller
 * (CLI-hook) парсит metadata через `resolvePveSolutionUci`.
 *
 * Архитектура:
 *  - Singleton: один Maia-engine на процесс (ONNX-сессия живёт пока жив
 *    воркер). Lazy-init по первому вызову `annotate`.
 *  - Provider — `createNodeProvider()` из `@kingside/maia-core`
 *    (onnxruntime-web через WASM; `onnxruntime-node` сегфолтит в Docker).
 *  - Pure-вычисление вынесено в `@kingside/maia-core/weak-choice` —
 *    переиспользуется admin-CLI T1 (KS-3641).
 *  - Graceful: любая ошибка (модель не загрузилась, Maia/SF inference
 *    exception) → возвращаем `null`. Caller обновляет UPDATE-row пустыми
 *    полями (то есть оставляет NULL — фронт неразмеченные пазлы не
 *    отсеивает).
 *  - Feature-flag: `PRECISION_MAIA_ANNOTATION_ENABLED=false` → сервис в
 *    disabled-режиме (`annotate()` всегда `null`).
 *
 * Hook вставлен в `insertPuzzle`-коллбеки CLI-генераторов
 * (`generate-puzzles.cli.ts`, `generate-puzzles-from-twic.cli.ts`):
 * после успешного `createMany.count > 0` вызывается `annotate()` и
 * `prisma.puzzle.update({ where: { id }, data: {...} })`. Hook
 * срабатывает только для `solutionMode === 'play-vs-engine'` — для
 * forced-line пазлов Maia-разметка не нужна.
 */
import { Logger } from '@nestjs/common';
import {
  Maia,
  annotateWeakChoice,
  createNodeProvider,
  loadModelFromFs,
  type WeakChoiceAnalysisEngine,
} from '@kingside/maia-core';

import type { StockfishService } from '../stockfish/stockfish.service';

export interface MaiaAnnotation {
  /**
   * Суммарная вероятность Maia сыграть один из «слабых» ходов по
   * ADR-106 §2.1. 0..1. Идёт в `puzzles.maia_weak_choice_prob`.
   */
  weakChoiceProb: number;
  /**
   * Версия алгоритма расчёта (см. `MAIA_WEAK_CHOICE_METRIC_VERSION`
   * в `@kingside/maia-core`). Идёт в `puzzles.maia_metric_version`.
   * Фронт сравнивает с актуальной константой и исключает строки
   * с устаревшим значением из активного фильтра.
   */
  metricVersion: number;
  /** ELO под которым прогнали Maia. Идёт в `puzzles.maia_top1_elo`. */
  elo: number;
  /** Суммарное время аннотации (Maia + SF), мс. Для логов/метрик. */
  latencyMs: number;
}

export interface MaiaAnnotationServiceConfig {
  /** Путь к ONNX-модели Maia-3. */
  modelPath: string;
  /** ELO для разметки. */
  elo: number;
  /** SF-depth для оценки кандидатов (ADR-106 §2.4 рекомендует 15). */
  sfDepth: number;
  /** Если false — сервис отключён (annotate → null). */
  enabled: boolean;
}

/**
 * Singleton-обёртка над Maia engine + StockfishService для T2
 * (continuous annotation).
 *
 * Не помечен `@Injectable` — пайплайн tactic-worker'а не использует DI
 * глобально, CLI-генераторы создают сервис вручную в bootstrap
 * (см. `generate-puzzles.cli.ts`). Это согласуется со стилем других
 * хелперов (`StockfishService` инстанцируется в CLI, не через @Inject).
 */
export class MaiaAnnotationService {
  private readonly logger = new Logger(MaiaAnnotationService.name);
  private maia: Maia | null = null;
  /** Чтобы не пытаться загружать модель повторно если упало. */
  private initFailed = false;

  constructor(
    private readonly config: MaiaAnnotationServiceConfig,
    private readonly stockfish: StockfishService,
  ) {}

  /**
   * Извлекает конфигурацию из ENV. Используется когда нет ConfigService
   * (CLI-bootstrap).
   *
   *  - `PRECISION_MAIA_ANNOTATION_ENABLED` — `false`/`0` → disabled.
   *  - `PRECISION_MAIA_ANNOTATION_ELO` — default 1500.
   *  - `PRECISION_MAIA_MODEL_PATH` — default `tools/maia3/maia3_simplified.onnx`.
   *  - `PRECISION_MAIA_SF_DEPTH` — default 15 (depth для оценки
   *    Maia-кандидатов через SF).
   */
  static fromEnv(
    stockfish: StockfishService,
    env: NodeJS.ProcessEnv = process.env,
  ): MaiaAnnotationService {
    const enabledRaw = (env.PRECISION_MAIA_ANNOTATION_ENABLED ?? 'true').toLowerCase();
    const enabled = !(enabledRaw === 'false' || enabledRaw === '0' || enabledRaw === 'off');
    const elo = parseInt(env.PRECISION_MAIA_ANNOTATION_ELO ?? '1500', 10);
    const sfDepth = parseInt(env.PRECISION_MAIA_SF_DEPTH ?? '15', 10);
    // Default — `tools/maia3/maia3_simplified.onnx` (KS-3633: модель
    // лежит там; apps/web/public/maia3/ не примонтирована в tactic-
    // worker-контейнере). В prod-Docker tactic-worker'а образ собирает
    // модель в /app/tools/maia3/; путь относительный к /app/apps/tactic-
    // worker (WORKDIR), так что нужно либо запускать из /app, либо
    // выставить ENV `PRECISION_MAIA_MODEL_PATH=/app/tools/maia3/maia3_simplified.onnx`.
    const modelPath =
      env.PRECISION_MAIA_MODEL_PATH ?? 'tools/maia3/maia3_simplified.onnx';
    return new MaiaAnnotationService(
      {
        modelPath,
        elo: Number.isFinite(elo) ? elo : 1500,
        sfDepth: Number.isFinite(sfDepth) && sfDepth > 0 ? sfDepth : 15,
        enabled,
      },
      stockfish,
    );
  }

  isEnabled(): boolean {
    return this.config.enabled && !this.initFailed;
  }

  /**
   * Размечает один пазл: возвращает `weakChoiceProb` + metric version +
   * ELO. Любая ошибка (Maia не загрузилась, SF не ответил, исключение
   * в inference) → `null` + лог WARN; caller записывает в БД соотв.
   * NULL'ы.
   *
   * `firstMovePV1` — UCI правильного хода solver'а (из
   * `Puzzle.sourceMetadata.firstMovePV1` через `resolvePveSolutionUci`).
   */
  async annotate(
    puzzleId: string,
    fen: string,
    firstMovePV1: string,
  ): Promise<MaiaAnnotation | null> {
    if (!this.isEnabled()) return null;

    const t0 = Date.now();

    // Maia-движок: getEngine держит kill-switch на init-фейле
    // (initFailed=true → дальнейшие annotate сразу null).
    let engine: Maia;
    try {
      engine = await this.getEngine();
    } catch (e) {
      this.logger.warn(
        `maia-annotate puzzle=${puzzleId} maia-init-failed: ${(e as Error).message}`,
      );
      return null;
    }

    // KS-4100 / ADR-124 §2.3: Stockfish-seam для weak-choice — адаптер
    // над StockfishService.analyzePositionWdl. MultiPvLine структурно
    // совместим с WeakChoiceLine (bestMove/score/wdl).
    const sfEngine: WeakChoiceAnalysisEngine = {
      analyzeWithWdl: (f, opts) =>
        this.stockfish.analyzePositionWdl(
          f,
          { depth: opts.depth },
          opts.multiPV,
          `maia-annotate p=${puzzleId}`,
          undefined,
          opts.searchMoves,
        ),
    };

    // Делегируем в общую оркестрацию (ADR-124). Исключения движков она
    // не глушит — ловим здесь и пишем null + WARN (как раньше).
    let result;
    try {
      result = await annotateWeakChoice({
        fen,
        firstMovePV1,
        maia: engine, // Maia удовлетворяет MaiaPolicySource
        engine: sfEngine,
        elo: this.config.elo,
        sfDepth: this.config.sfDepth,
      });
    } catch (e) {
      this.logger.warn(
        `maia-annotate puzzle=${puzzleId} failed: ${(e as Error).message}`,
      );
      return null;
    }

    if (!result) {
      this.logger.warn(
        `maia-annotate puzzle=${puzzleId} maia-empty-policy (без легальных)`,
      );
      return null;
    }

    const latencyMs = Date.now() - t0;
    this.logger.log(
      `maia-annotate puzzle=${puzzleId} weakProb=${result.weakChoiceProb.toFixed(4)} ` +
        `elo=${result.elo} latency=${latencyMs}ms`,
    );

    return {
      weakChoiceProb: result.weakChoiceProb,
      metricVersion: result.metricVersion,
      elo: result.elo,
      latencyMs,
    };
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
