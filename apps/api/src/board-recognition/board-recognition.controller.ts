import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  BoardRecognitionResponse,
  RecognizeBoardDto,
} from './dto/recognize-board.dto';
import { BoardRecognitionService } from './board-recognition.service';

/** Жёсткий лимит multer'а — 8 MB (ADR-040 §5.1). */
export const BOARD_RECOGNITION_MAX_BYTES = 8 * 1024 * 1024;

@UseGuards(JwtAuthGuard)
@Controller('board-recognition')
export class BoardRecognitionController {
  private readonly logger = new Logger(BoardRecognitionController.name);

  constructor(private readonly service: BoardRecognitionService) {}

  /**
   * POST /api/board-recognition (KS-2363, ADR-040 §5.1).
   *
   * Multipart: поле `image` — файл доски (PNG/JPG/BMP, ≤8MB).
   * Body-поле `profile` — опциональный профиль ('auto' | 'maizelis' |
   * 'dvoretsky' | 'generic'). Дефолт 'auto'.
   *
   * Возвращает `BoardRecognitionResponse`. Ошибки:
   *   - 400 `image_required` — нет файла или пустой буфер.
   *   - 400 `unsupported_media_type` — не image/*.
   *   - 400 `board_not_detected` — детектор не нашёл доску.
   *   - 413 (multer) — файл больше 8MB.
   *   - 500 `model_load_failed` — ENV задан но модель не загрузилась /
   *     inference крашнулся.
   */
  @Post()
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: BOARD_RECOGNITION_MAX_BYTES, files: 1 },
    }),
  )
  async recognize(
    @UploadedFile() image: Express.Multer.File | undefined,
    @Body() body: RecognizeBoardDto,
  ): Promise<BoardRecognitionResponse> {
    // class-validator уже отсеял невалидные значения profile — здесь
    // только нормализация дефолта.
    const profile = body?.profile ?? 'auto';
    // Multer кладёт `truncated: true` на streamed File, если файл превысил
    // лимит. В типе `Express.Multer.File` этого поля нет (extension
    // multer), поэтому через cast. На memory storage (default) multer
    // уже бросит `PayloadTooLargeException` на лимите — эта ветка
    // страхует случай со stream-storage в будущем.
    if (image && (image as unknown as { truncated?: boolean }).truncated) {
      throw new BadRequestException({
        code: 'image_too_large',
        message: `image exceeds ${BOARD_RECOGNITION_MAX_BYTES} bytes`,
      });
    }
    return this.service.recognize(image, profile);
  }
}
