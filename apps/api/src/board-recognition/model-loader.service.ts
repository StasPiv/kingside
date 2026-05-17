import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Состояние ONNX-модели board-recog (KS-2363, ADR-040 §5.1):
 *   - `loaded`   — модель лежит на диске, готова к использованию;
 *   - `disabled` — `BOARD_RECOG_MODEL_VERSION` не задан (плановый режим
 *     для прода до выкатки модели — модуль работает в mock-режиме);
 *   - `error`    — ENV задан, но файл не нашёлся / не читается.
 */
export type ModelStatus = 'loaded' | 'disabled' | 'error';

export interface ModelState {
  status: ModelStatus;
  version: string | null;
  modelPath: string | null;
  error: string | null;
}

/**
 * Кешируемое место для скачанной модели. Совпадает с путём, в который
 * пишет `apps/api/docker-entrypoint.sh` при старте контейнера, если задан
 * `BOARD_RECOG_MODEL_VERSION`.
 */
export const DEFAULT_MODEL_CACHE_DIR = '/var/cache/board-recog';
export const DEFAULT_MODEL_FILENAME = 'model.onnx';

export const BOARD_RECOG_MODEL_VERSION_ENV = 'BOARD_RECOG_MODEL_VERSION';
export const BOARD_RECOG_MODEL_PATH_ENV = 'BOARD_RECOG_MODEL_PATH';
export const BOARD_RECOG_MODEL_DIR_ENV = 'BOARD_RECOG_MODEL_DIR';

/**
 * `ModelLoaderService` определяет статус ONNX-модели на старте и держит его
 * в памяти. Health-check и BoardRecognitionService опрашивают этот статус
 * для маршрутизации запросов.
 *
 * Никаких побочных эффектов: модель сюда не загружается и не скачивается —
 * этим занимается entrypoint контейнера (см. `docker-entrypoint.sh`).
 */
@Injectable()
export class ModelLoaderService implements OnModuleInit {
  private readonly logger = new Logger(ModelLoaderService.name);
  private state: ModelState = {
    status: 'disabled',
    version: null,
    modelPath: null,
    error: null,
  };

  async onModuleInit(): Promise<void> {
    this.state = await this.detect();
    const { status, version, modelPath, error } = this.state;
    if (status === 'loaded') {
      this.logger.log(
        `board-recog model loaded: version=${version} path=${modelPath}`,
      );
    } else if (status === 'disabled') {
      this.logger.log(
        `board-recog model disabled: ${BOARD_RECOG_MODEL_VERSION_ENV} not set; ` +
          `module will return mock responses with a warning.`,
      );
    } else {
      this.logger.error(
        `board-recog model load failed (version=${version} path=${modelPath}): ${error}`,
      );
    }
  }

  /** Текущее состояние модели — read-only снимок. */
  getState(): ModelState {
    return { ...this.state };
  }

  /**
   * Тестовый/хот-релоадовый хук: пересчитать состояние ещё раз. Не используется
   * на старте (для этого есть `onModuleInit`).
   */
  async refresh(): Promise<ModelState> {
    this.state = await this.detect();
    return this.getState();
  }

  /**
   * Решение по ENV + filesystem. Чистая функция от среды — testable без
   * подъёма Nest-контейнера.
   */
  private async detect(): Promise<ModelState> {
    const version = process.env[BOARD_RECOG_MODEL_VERSION_ENV]?.trim() || null;
    const explicitPath = process.env[BOARD_RECOG_MODEL_PATH_ENV]?.trim() || null;
    const dir =
      process.env[BOARD_RECOG_MODEL_DIR_ENV]?.trim() || DEFAULT_MODEL_CACHE_DIR;

    if (!version && !explicitPath) {
      return {
        status: 'disabled',
        version: null,
        modelPath: null,
        error: null,
      };
    }

    const candidatePath =
      explicitPath ?? path.join(dir, DEFAULT_MODEL_FILENAME);

    try {
      const stat = await fs.stat(candidatePath);
      if (!stat.isFile() || stat.size === 0) {
        return {
          status: 'error',
          version,
          modelPath: candidatePath,
          error: `model file is empty or not a regular file: ${candidatePath}`,
        };
      }
      return {
        status: 'loaded',
        version,
        modelPath: candidatePath,
        error: null,
      };
    } catch (e) {
      const msg = (e as NodeJS.ErrnoException).code === 'ENOENT'
        ? `model file not found: ${candidatePath}`
        : `cannot stat model file ${candidatePath}: ${(e as Error).message}`;
      return {
        status: 'error',
        version,
        modelPath: candidatePath,
        error: msg,
      };
    }
  }
}
