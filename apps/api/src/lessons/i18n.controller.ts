import * as fs from 'fs';
import * as path from 'path';
import { Controller, Get, Header, NotFoundException, Param } from '@nestjs/common';

/**
 * KS-1787: публичный эндпоинт для динамической подгрузки переводов уроков.
 *
 * Backend в L-14b положил переводы в `apps/api/src/i18n/<lng>/lessons.json`.
 * Фронт через `lessonsResourceLoader` дёргает этот эндпоинт при старте и
 * смене языка — мержит в i18next через `addResourceBundle`.
 *
 * Эндпоинт без `JwtAuthGuard` — статические переводы не чувствительны,
 * и авторизация усложнила бы i18next-загрузку.
 */
@Controller('lessons/i18n')
export class LessonsI18nController {
  /** Локали, которые мы обслуживаем. Неизвестные → 404. */
  private static readonly SUPPORTED = new Set(['ru', 'en']);

  /**
   * Папка с i18n-файлами. Берём ту же, что использует nestjs-i18n в
   * `app.module.ts` (`path.join(__dirname, '/i18n/')`), но из места
   * `lessons/`. Поэтому поднимаемся на уровень выше.
   */
  private static readonly I18N_DIR = path.join(__dirname, '..', 'i18n');

  /** GET /api/lessons/i18n/:lng — JSON с переводами уроков. */
  @Get(':lng')
  @Header('Cache-Control', 'public, max-age=300')
  getLessonsI18n(@Param('lng') lng: string): unknown {
    if (!LessonsI18nController.SUPPORTED.has(lng)) {
      throw new NotFoundException(`Locale "${lng}" is not supported`);
    }
    const file = path.join(LessonsI18nController.I18N_DIR, lng, 'lessons.json');
    if (!fs.existsSync(file)) {
      // Для поддерживаемой локали, но без файла перевода (например `en`
      // до перевода MVP) возвращаем пустой объект, не 404 — фронту
      // удобнее работать с `{}` (никаких ключей к мержу) и продолжить
      // использовать bundled/fallback-переводы.
      return {};
    }
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      return JSON.parse(raw);
    } catch {
      throw new NotFoundException(`Failed to read lessons.json for "${lng}"`);
    }
  }
}
