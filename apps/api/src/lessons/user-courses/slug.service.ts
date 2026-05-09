import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { customAlphabet } from 'nanoid';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * SlugService — генерация и валидация slug'ов для пользовательских курсов
 * (ADR-026 §2.5, KS-1832).
 *
 * Формат slug'а: `<shortId>-<slug-from-title>`, например
 * `a3f9k2-moi-pervyi-kurs`. `shortId` — nanoid длиной 6 из 36-символьного
 * алфавита, что даёт ~2.2·10⁹ комбинаций на один и тот же заголовок;
 * коллизия на практике невозможна, но unique-индекс `UserCourse.slug`
 * всё равно страхует.
 *
 * Алгоритм:
 *  1. title → lowercase → транслит кириллицы → удаление не-ASCII/неалф. →
 *     замена пробелов/пунктуации на `-` → trim дефисов → срез до 60 симв.
 *  2. Если после очистки пусто (например, ввод был только эмоджи/цифры
 *     на непонятном языке) — fallback `course`. Пустой body делает весь
 *     slug `<shortId>-course`, что пользователю всё равно понятно.
 *  3. Префикс `shortId` всегда свежий, даже если тот же юзер создал
 *     курс с тем же заголовком (ADR §2.5 — два одинаковых title без
 *     суффикса на глобальном уникальном индексе упадут).
 *
 * Валидация явно переданного slug'а (если фронт захочет его задать):
 *  - только `[a-z0-9-]` (ADR §2.5 Приложение B не оговаривает запрет на
 *    верхний регистр, но lowercase — договор с генератором, чтобы URL'ы
 *    были стабильно читаемыми);
 *  - длина 3..80 символов;
 *  - не начинается и не заканчивается на `-`;
 *  - не содержит `--` подряд — редкий случай после плохого ручного ввода,
 *    но корректный slug такого не имеет.
 *
 * Повторно созданный slug (коллизия на уникальном индексе) ретраится
 * в `generateUnique` — до `MAX_ATTEMPTS` раз, после чего кидаем 400.
 * Ретрай нужен для защиты от крайне редкой случайной коллизии nanoid'а.
 */
@Injectable()
export class SlugService {
  private readonly logger = new Logger(SlugService.name);

  /** Алфавит shortId — URL-safe, без легко путающихся `0/O` и `1/l`. */
  private static readonly ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz';
  static readonly SHORT_ID_LENGTH = 6;
  /** Максимум попыток сгенерировать уникальный slug при коллизии. */
  static readonly MAX_ATTEMPTS = 5;
  /** Срез тела (часть после shortId-). */
  static readonly BODY_MAX_LENGTH = 60;
  /** Длина slug'а при явной валидации, мин/макс. */
  static readonly SLUG_MIN_LENGTH = 3;
  static readonly SLUG_MAX_LENGTH = 80;

  private readonly nanoid = customAlphabet(SlugService.ALPHABET, SlugService.SHORT_ID_LENGTH);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Генерирует slug из title без проверки коллизии. Для повышения
   * уникальности — используйте `generateUnique`.
   */
  generate(title: string): string {
    return `${this.nanoid()}-${SlugService.slugifyBody(title)}`;
  }

  /**
   * Генерирует slug, проверяя уникальность в `UserCourse.slug` и
   * перегенерируя до `MAX_ATTEMPTS` раз при коллизии. На практике
   * одной попытки достаточно (см. дока класса).
   */
  async generateUnique(title: string): Promise<string> {
    for (let attempt = 0; attempt < SlugService.MAX_ATTEMPTS; attempt++) {
      const slug = this.generate(title);
      // KS-2649 / Phase E3: проверяем уникальность в единой `courses`
      // (legacy `user_courses` дропнута). Slug-namespace
      // пользовательских — `WHERE owner_id IS NOT NULL` (partial-unique
      // из Phase A). `findFirst` — потому что compound уникальность
      // partial, не выражается в `findUnique`.
      const exists = await this.prisma.course.findFirst({
        where: { slug, ownerId: { not: null } },
        select: { id: true },
      });
      if (!exists) return slug;
      this.logger.warn(
        `slug collision on attempt ${attempt + 1}: "${slug}" — regenerating`,
      );
    }
    throw new BadRequestException(
      `Failed to generate unique slug after ${SlugService.MAX_ATTEMPTS} attempts`,
    );
  }

  /**
   * Валидирует явно переданный slug. Бросает BadRequestException, если
   * не проходит правила. При успехе — возвращает тот же slug (для
   * удобного chaining'а).
   */
  validateExplicit(slug: string): string {
    if (typeof slug !== 'string') {
      throw new BadRequestException('slug must be a string');
    }
    if (slug.length < SlugService.SLUG_MIN_LENGTH) {
      throw new BadRequestException(
        `slug is too short (min ${SlugService.SLUG_MIN_LENGTH} chars)`,
      );
    }
    if (slug.length > SlugService.SLUG_MAX_LENGTH) {
      throw new BadRequestException(
        `slug is too long (max ${SlugService.SLUG_MAX_LENGTH} chars)`,
      );
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      throw new BadRequestException(
        'slug contains invalid characters (allowed: a-z, 0-9, -)',
      );
    }
    if (slug.startsWith('-') || slug.endsWith('-')) {
      throw new BadRequestException('slug must not start or end with "-"');
    }
    if (slug.includes('--')) {
      throw new BadRequestException('slug must not contain "--"');
    }
    return slug;
  }

  /**
   * Нормализует title в «тело» slug (без shortId-префикса).
   * Экспонируется для тестов и потенциального переиспользования —
   * основной путь через `generate`/`generateUnique`.
   */
  static slugifyBody(title: string): string {
    if (typeof title !== 'string') return 'course';
    const transliterated = title
      .toLowerCase()
      .replace(/ё/g, 'yo')
      .replace(/[а-я]/g, (c) => RU_MAP[c] ?? '')
      .normalize('NFKD')
      // удаляем диакритику (ü → u, é → e), оставшуюся после NFKD
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SlugService.BODY_MAX_LENGTH)
      .replace(/-+$/g, '');
    return transliterated.length > 0 ? transliterated : 'course';
  }
}

/**
 * Транслит русской кириллицы в ASCII. Мягкий/твёрдый знак → пусто.
 * Упрощённая ГОСТ-подобная схема — для slug'ов достаточно, не BGN/PCGN.
 */
const RU_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh',
  з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu',
  я: 'ya',
};
