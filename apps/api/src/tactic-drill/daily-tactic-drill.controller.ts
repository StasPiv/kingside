/**
 * KS-2250 (ADR-035 §11 / E6). Public endpoint'ы для daily-drill:
 *  - `GET /tactic-drill/daily?date=...&locale=...` — JSON-ответ
 *    (DailyTacticDrillResponse, без auth, rate-limit 60/min/IP).
 *  - `GET /tactic-drill/daily/image/:filename.png` — Plan B статический
 *    файл картинки. Plan A (S3+CDN) поднимает devops, после готовности
 *    `imageUrl` в JSON-ответе сам перейдёт на CDN-URL.
 *
 * Cache-Control: для GET без `date` query — `public, max-age=3600,
 * s-maxage=86400` (CDN кэширует на сутки, browser на час). С `date` —
 * `no-store` (тестовые запросы).
 */
import {
  BadRequestException,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { DailyTacticDrillService, type Locale } from './daily-tactic-drill.service';
import { DailyTacticDrillImageService } from './daily-tactic-drill-image.service';

const ALLOWED_LOCALES: ReadonlySet<Locale> = new Set(['ru', 'en']);
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const IMAGE_FILE_REGEX = /^(\d{4}-\d{2}-\d{2})-(ru|en)\.png$/;

@Controller('tactic-drill/daily')
export class DailyTacticDrillController {
  constructor(
    private readonly service: DailyTacticDrillService,
    private readonly imageService: DailyTacticDrillImageService,
  ) {}

  /**
   * GET /tactic-drill/daily?date=YYYY-MM-DD&locale=ru|en
   * Auth: public.
   */
  @Get()
  async getDaily(
    @Query('date') dateStr: string | undefined,
    @Query('locale') localeStr: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const locale = parseLocale(localeStr);
    const isExplicitDate = Boolean(dateStr);
    const date = parseDate(dateStr);

    // Cache-Control: для запросов с явной date — без кеша (тестовые),
    // для дефолтных (today) — публичный CDN-cache 24h.
    if (isExplicitDate) {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    }

    return this.service.getDaily(date, locale);
  }

  /**
   * GET /tactic-drill/daily/image/:filename.png
   * Plan B: рендер при первом обращении, кэш в local FS на 24h.
   * После KS-2316 (devops S3+CDN) — `imageUrl` в JSON будет ссылаться
   * на CDN, этот endpoint остаётся как fallback.
   */
  @Get('image/:filename')
  @Header('Cache-Control', 'public, max-age=86400')
  @Header('Content-Type', 'image/png')
  @HttpCode(200)
  async getImage(
    @Param('filename') filename: string,
  ): Promise<StreamableFile> {
    const match = IMAGE_FILE_REGEX.exec(filename);
    if (!match) {
      throw new BadRequestException(
        'filename must match `YYYY-MM-DD-{ru|en}.png`',
      );
    }
    const [, dateIso, locale] = match;
    const date = parseDate(dateIso);

    // Получаем JSON-данные (это или забронирует drill, или вернёт
    // существующий — синхронно с тем что отдаёт `/daily` JSON).
    const data = await this.service.getDaily(date, locale as Locale);
    const imagePath = await this.imageService.getImagePath(data, locale as Locale);
    return new StreamableFile(createReadStream(imagePath));
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function parseLocale(raw: string | undefined): Locale {
  const v = (raw ?? 'ru').toLowerCase();
  if (!ALLOWED_LOCALES.has(v as Locale)) {
    throw new BadRequestException('locale must be one of: ru | en');
  }
  return v as Locale;
}

function parseDate(raw: string | undefined): Date {
  if (!raw) {
    return new Date();
  }
  if (!DATE_REGEX.test(raw)) {
    throw new BadRequestException('date must be in format YYYY-MM-DD');
  }
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`invalid date: ${raw}`);
  }
  return date;
}
