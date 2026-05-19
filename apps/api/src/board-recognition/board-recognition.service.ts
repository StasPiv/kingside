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
  /**
   * KS-3110: множественные доски на исходной картинке (find-boards stage).
   * Если поле присутствует и длина > 1 — на скриншоте обнаружено
   * несколько досок (страница пазлов, учебник с двумя диаграммами и т.п.).
   * Корневые поля (fen, fen_board, ...) дублируют первую `success` доску
   * для back-compat. Service пробрасывает массив дальше в
   * `BoardRecognitionResponse.boards` (опциональное поле).
   */
  boards?: Array<{
    success?: boolean;
    fen?: string;
    fen_board?: string;
    orientation?: 'white' | 'black';
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
  }>;
  n_boards_found?: number;
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
        const err = e as Error & {
          name?: string;
          stage?: string;
          originalError?: string;
        };
        const msg = err.message ?? 'unknown error';

        // KS-3095: typed маппинг по stage (GenericRecognizeError из
        // @kingside/board-image-to-fen). Fallback на regex по message —
        // для legacy-ошибок других путей (recognizeBoardImage / spawn).
        const stage: string =
          err.name === 'GenericRecognizeError' && err.stage
            ? err.stage
            : /stage=detect/i.test(msg) || /board[_ ]not[_ ]detected/i.test(msg)
              ? 'detect'
              : '';

        if (stage === 'detect') {
          throw new BadRequestException({
            code: 'board_not_detected',
            message: err.originalError ?? msg,
          });
        }
        if (stage === 'model_missing') {
          this.logger.error(`recognize: model missing: ${msg}`);
          throw new InternalServerErrorException({
            code: 'model_load_failed',
            message: err.originalError ?? msg,
          });
        }
        if (stage === 'classify' || stage === 'unexpected') {
          this.logger.error(`recognize: inference failed (stage=${stage}): ${msg}`);
          throw new InternalServerErrorException({
            code: 'inference_failed',
            message: err.originalError ?? msg,
          });
        }

        // Anything else — surface as 500. Most likely a non-Python crash
        // (spawn error, JSON parse failure with stderr already in message).
        this.logger.error(`recognize: unexpected error: ${msg}`);
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
    const root = this.boardToResponse(
      raw,
      raw.low_confidence_cells,
      raw.sanity,
      raw.detect,
      raw.bbox,
      modelVersion,
    );
    // KS-3110: если find-boards вернул массив > 1, прокидываем как `boards`.
    if (raw.boards && raw.boards.length > 1) {
      root.boards = raw.boards
        .filter((b) => b?.success !== false && b?.fen && b?.fen_board)
        .map((b) =>
          this.boardToResponse(
            {
              fen: b.fen!,
              fen_board: b.fen_board!,
              orientation: b.orientation!,
            },
            b.low_confidence_cells,
            b.sanity,
            b.detect,
            b.bbox,
            modelVersion,
          ),
        );
    }
    return root;
  }

  private boardToResponse(
    raw: {
      fen: string;
      fen_board: string;
      orientation: 'white' | 'black';
    },
    lowConfCells: RecognizeUniversalResult['low_confidence_cells'],
    sanity: RecognizeUniversalResult['sanity'],
    detect: RecognizeUniversalResult['detect'],
    bbox: RecognizeUniversalResult['bbox'],
    modelVersion: string | null,
  ): BoardRecognitionResponse {
    const warnings: string[] = [];
    for (const issue of sanity?.issues ?? []) {
      warnings.push(`sanity: ${issue}`);
    }
    const cells = lowConfCells ?? [];
    if (cells.length > 0) {
      warnings.push(`low confidence: ${cells.length} cells`);
    }
    return {
      fen: raw.fen,
      fenBoard: raw.fen_board,
      orientation: raw.orientation,
      orientationConfidence: clamp(detect?.confidence ?? 1, 0, 1),
      bbox: bbox ?? [0, 0, 0, 0],
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
