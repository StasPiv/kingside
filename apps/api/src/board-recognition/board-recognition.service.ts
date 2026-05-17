import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import {
  BoardRecognitionProfile,
  BoardRecognitionResponse,
  LowConfidenceCell,
} from './dto/recognize-board.dto';
import { ModelLoaderService } from './model-loader.service';

/** Стартовая позиция — fallback в disabled-режиме. */
const STARTING_FEN_BOARD =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
const STARTING_FEN = `${STARTING_FEN_BOARD} w - - 0 1`;

/** Минимальный набор клеток стартовой позиции для mock-ответа. */
function buildStartingLowConfidenceCells(): LowConfidenceCell[] {
  // Mock-режим — без модели; никаких клеток с реальной uncertainty нет.
  return [];
}

/**
 * Опциональный delegate: реальный inference. В рантайме инжектится обёртка
 * над `recognizeUniversal` из `@kingside/board-image-to-fen`; в тестах —
 * jest-моки. Вынесено в интерфейс, чтобы:
 *   1. Не тянуть Python-зависимый пакет в unit-тесты сервиса.
 *   2. Тестировать error-paths без реального onnxruntime.
 */
export interface BoardRecognizer {
  recognize(
    imagePath: string,
    options: {
      profile: BoardRecognitionProfile;
      modelPath?: string | null;
    },
  ): Promise<RecognizeUniversalResult>;
}

/** Минимальная форма результата `recognizeUniversal()`, нужная сервису. */
export interface RecognizeUniversalResult {
  success: true;
  usedProfile: 'generic' | 'maizelis' | 'dvoretsky';
  fen: string;
  fen_board: string;
  orientation: 'white' | 'black';
  bbox?: [number, number, number, number];
  low_confidence_cells?: Array<{
    square: string;
    predicted: string;
    confidence: number;
    top3?: Array<{ label: string; prob: number }>;
  }>;
  sanity?: {
    valid: boolean;
    issues: string[];
  };
  detect?: {
    confidence?: number;
  };
}

export const BOARD_RECOGNIZER = 'BOARD_RECOGNIZER';

@Injectable()
export class BoardRecognitionService {
  private readonly logger = new Logger(BoardRecognitionService.name);

  constructor(
    private readonly modelLoader: ModelLoaderService,
    @Inject(BOARD_RECOGNIZER) private readonly recognizer: BoardRecognizer,
  ) {}

  /**
   * Маршрутизация запроса:
   *
   *   - `model.status === 'error'`    → 500 `model_load_failed` (deploy-bug,
   *     ENV задан но файла нет — не маскируем mock'ом, видим в алертах).
   *   - `model.status === 'disabled'` → mock-ответ + warning.
   *   - `model.status === 'loaded'`   → реальный inference. На `success=false`
   *     детектор отдаёт 400 `board_not_detected`.
   */
  async recognize(
    file: Express.Multer.File | undefined,
    profile: BoardRecognitionProfile = 'auto',
  ): Promise<BoardRecognitionResponse> {
    this.assertFile(file);

    const model = this.modelLoader.getState();

    if (model.status === 'error') {
      this.logger.error(
        `recognize: model error path: ${model.error ?? 'unknown'}`,
      );
      throw new InternalServerErrorException({
        code: 'model_load_failed',
        message:
          model.error ??
          'board-recog ONNX model is configured but failed to load',
      });
    }

    if (model.status === 'disabled') {
      return this.buildMockResponse();
    }

    return this.runRecognizer(file!, profile, model.modelPath, model.version);
  }

  private assertFile(file: Express.Multer.File | undefined): void {
    if (!file) {
      throw new BadRequestException({
        code: 'image_required',
        message: 'multipart field `image` is required',
      });
    }
    if (!file.buffer || file.buffer.length === 0) {
      throw new BadRequestException({
        code: 'image_required',
        message: 'uploaded image is empty',
      });
    }
    const mt = (file.mimetype || '').toLowerCase();
    if (!mt.startsWith('image/')) {
      throw new BadRequestException({
        code: 'unsupported_media_type',
        message: `unsupported mimetype: ${file.mimetype || '<unknown>'}`,
      });
    }
  }

  private buildMockResponse(): BoardRecognitionResponse {
    return {
      fen: STARTING_FEN,
      fenBoard: STARTING_FEN_BOARD,
      orientation: 'white',
      orientationConfidence: 1,
      bbox: [0, 0, 0, 0],
      modelVersion: null,
      lowConfidenceCells: buildStartingLowConfidenceCells(),
      warnings: [
        'model not loaded — returning starting position. ' +
          'Set BOARD_RECOG_MODEL_VERSION and redeploy to enable inference.',
      ],
    };
  }

  private async runRecognizer(
    file: Express.Multer.File,
    profile: BoardRecognitionProfile,
    modelPath: string | null,
    modelVersion: string | null,
  ): Promise<BoardRecognitionResponse> {
    const tmpPath = await this.writeTempImage(file);
    try {
      let result: RecognizeUniversalResult;
      try {
        result = await this.recognizer.recognize(tmpPath, {
          profile,
          modelPath: modelPath ?? undefined,
        });
      } catch (e) {
        const msg = (e as Error).message ?? 'unknown error';
        // Heuristic: detector failures from Python script come back as
        // "board_recognize.py failed at stage=detect: ...".
        if (/stage=detect/i.test(msg) || /board[_ ]not[_ ]detected/i.test(msg)) {
          throw new BadRequestException({
            code: 'board_not_detected',
            message: msg,
          });
        }
        // Anything else — surface as 500. Most likely an inference-time crash
        // (model corrupted, missing onnxruntime, etc.) — operator needs to
        // see it.
        this.logger.error(`recognize: inference failed: ${msg}`);
        throw new InternalServerErrorException({
          code: 'model_load_failed',
          message: msg,
        });
      }

      return this.toResponse(result, modelVersion);
    } finally {
      await this.removeTempFile(tmpPath);
    }
  }

  private toResponse(
    raw: RecognizeUniversalResult,
    modelVersion: string | null,
  ): BoardRecognitionResponse {
    const warnings: string[] = [];
    for (const issue of raw.sanity?.issues ?? []) {
      warnings.push(`sanity: ${issue}`);
    }
    const cells = raw.low_confidence_cells ?? [];
    if (cells.length > 0) {
      warnings.push(`low confidence: ${cells.length} cells`);
    }
    return {
      fen: raw.fen,
      fenBoard: raw.fen_board,
      orientation: raw.orientation,
      orientationConfidence: clamp(raw.detect?.confidence ?? 1, 0, 1),
      bbox: raw.bbox ?? [0, 0, 0, 0],
      modelVersion,
      lowConfidenceCells: cells.map((c) => ({
        square: c.square,
        predicted: c.predicted,
        confidence: c.confidence,
        top3: c.top3 ?? [],
      })),
      warnings,
    };
  }

  private async writeTempImage(file: Express.Multer.File): Promise<string> {
    const ext = pickExtension(file);
    const random = crypto.randomBytes(8).toString('hex');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'board-recog-'));
    const tmpPath = path.join(tmpDir, `upload-${random}${ext}`);
    await fs.writeFile(tmpPath, file.buffer);
    return tmpPath;
  }

  private async removeTempFile(p: string): Promise<void> {
    try {
      await fs.rm(path.dirname(p), { recursive: true, force: true });
    } catch (e) {
      this.logger.warn(
        `cannot remove temp dir ${path.dirname(p)}: ${(e as Error).message}`,
      );
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function pickExtension(file: Express.Multer.File): string {
  const fromName = (file.originalname || '').toLowerCase();
  const idx = fromName.lastIndexOf('.');
  if (idx >= 0 && idx < fromName.length - 1) {
    const ext = fromName.slice(idx);
    if (/^\.(png|jpg|jpeg|bmp|gif|webp)$/.test(ext)) return ext;
  }
  const mt = (file.mimetype || '').toLowerCase();
  if (mt === 'image/png') return '.png';
  if (mt === 'image/jpeg' || mt === 'image/jpg') return '.jpg';
  if (mt === 'image/bmp') return '.bmp';
  if (mt === 'image/webp') return '.webp';
  return '.bin';
}
