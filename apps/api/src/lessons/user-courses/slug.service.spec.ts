import { BadRequestException } from '@nestjs/common';
import { SlugService } from './slug.service';

describe('SlugService (KS-1832)', () => {
  let service: SlugService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      course: {
        findFirst: jest.fn(),
      },
    };
    service = new SlugService(prisma);
  });

  // ─── Транслитерация и нормализация ────────────────────────────────

  describe('slugifyBody (статическая нормализация)', () => {
    it('«Мой курс» → "moi-kurs"', () => {
      expect(SlugService.slugifyBody('Мой курс')).toBe('moi-kurs');
    });

    it('«Мой первый курс» → "moi-pervyi-kurs"', () => {
      expect(SlugService.slugifyBody('Мой первый курс')).toBe('moi-pervyi-kurs');
    });

    it('обрабатывает «ё» отдельно как "yo"', () => {
      expect(SlugService.slugifyBody('ёлка')).toBe('yolka');
    });

    it('убирает мягкий/твёрдый знак', () => {
      expect(SlugService.slugifyBody('объём')).toBe('obyom');
    });

    it('латиница остаётся, спецсимволы → "-"', () => {
      expect(SlugService.slugifyBody('Hello, World!!!')).toBe('hello-world');
    });

    it('латинская диакритика нормализуется (NFKD)', () => {
      expect(SlugService.slugifyBody('Café über')).toBe('cafe-uber');
    });

    it('эмоджи и неизвестные символы вырезаются', () => {
      expect(SlugService.slugifyBody('Hello 😀 World')).toBe('hello-world');
    });

    it('режет ведущие/замыкающие дефисы', () => {
      expect(SlugService.slugifyBody('---hello---')).toBe('hello');
    });

    it('режет тело до 60 символов и не оставляет хвостового "-"', () => {
      const longTitle = 'a'.repeat(70) + ' ' + 'b'.repeat(20);
      const body = SlugService.slugifyBody(longTitle);
      expect(body.length).toBeLessThanOrEqual(60);
      expect(body).not.toMatch(/-$/);
    });

    it('пустой ввод → fallback "course"', () => {
      expect(SlugService.slugifyBody('')).toBe('course');
    });

    it('только спецсимволы → fallback "course"', () => {
      expect(SlugService.slugifyBody('!!!')).toBe('course');
    });

    it('только эмоджи → fallback "course"', () => {
      expect(SlugService.slugifyBody('😀🎉')).toBe('course');
    });

    it('не-строка → fallback "course"', () => {
      expect(SlugService.slugifyBody(undefined as any)).toBe('course');
      expect(SlugService.slugifyBody(null as any)).toBe('course');
      expect(SlugService.slugifyBody(123 as any)).toBe('course');
    });
  });

  // ─── generate ─────────────────────────────────────────────────────

  describe('generate', () => {
    it('формат "<shortId 6>-<body>"', () => {
      const s = service.generate('Мой курс');
      expect(s).toMatch(/^[23456789a-km-np-z]{6}-moi-kurs$/);
    });

    it('shortId использует только безопасный алфавит (без 0/O/1/l)', () => {
      // 100 повторов — достаточно, чтобы не пропустить запрещённые
      // символы, если алфавит сломают.
      for (let i = 0; i < 100; i++) {
        const s = service.generate('a');
        const shortId = s.slice(0, 6);
        expect(shortId).not.toMatch(/[01olOL]/);
      }
    });

    it('два вызова с одинаковым title дают разные slug (shortId разный)', () => {
      const s1 = service.generate('hi');
      const s2 = service.generate('hi');
      expect(s1).not.toBe(s2);
    });

    it('пустой title → "<shortId>-course"', () => {
      const s = service.generate('!!!');
      expect(s).toMatch(/^[23456789a-km-np-z]{6}-course$/);
    });
  });

  // ─── generateUnique ──────────────────────────────────────────────

  describe('generateUnique', () => {
    it('первая попытка уникальна → возвращает сразу', async () => {
      prisma.course.findFirst.mockResolvedValue(null);
      const s = await service.generateUnique('Hi');
      expect(s).toMatch(/-hi$/);
      expect(prisma.course.findFirst).toHaveBeenCalledTimes(1);
    });

    it('при коллизии первых N-1 попыток — возвращает последний уникальный', async () => {
      prisma.course.findFirst
        .mockResolvedValueOnce({ id: 'x' })   // 1-я занята
        .mockResolvedValueOnce({ id: 'y' })   // 2-я занята
        .mockResolvedValueOnce(null);          // 3-я свободна
      const s = await service.generateUnique('Hi');
      expect(s).toMatch(/-hi$/);
      expect(prisma.course.findFirst).toHaveBeenCalledTimes(3);
    });

    it('превышение MAX_ATTEMPTS → 400', async () => {
      prisma.course.findFirst.mockResolvedValue({ id: 'busy' });
      await expect(service.generateUnique('Hi')).rejects.toThrow(BadRequestException);
      expect(prisma.course.findFirst).toHaveBeenCalledTimes(
        SlugService.MAX_ATTEMPTS,
      );
    });
  });

  // ─── validateExplicit ────────────────────────────────────────────

  describe('validateExplicit', () => {
    it('валидный slug возвращается как есть', () => {
      expect(service.validateExplicit('my-course-2')).toBe('my-course-2');
      expect(service.validateExplicit('abc')).toBe('abc');
      expect(service.validateExplicit('a1-b2-c3')).toBe('a1-b2-c3');
    });

    it('граничные длины: ровно 3 и ровно 80 символов — ок', () => {
      expect(service.validateExplicit('abc')).toBe('abc');
      const max = 'a' + '-b'.repeat(39) + 'a'; // 80 символов
      expect(max.length).toBe(80);
      // Последний символ не '-', дефисы не двойные — ок.
      expect(service.validateExplicit(max)).toBe(max);
    });

    it('слишком короткий (< 3) → 400', () => {
      expect(() => service.validateExplicit('ab')).toThrow(BadRequestException);
    });

    it('слишком длинный (> 80) → 400', () => {
      expect(() => service.validateExplicit('a'.repeat(81))).toThrow(
        BadRequestException,
      );
    });

    it('верхний регистр → 400', () => {
      expect(() => service.validateExplicit('My-Course')).toThrow(
        BadRequestException,
      );
    });

    it('кириллица → 400', () => {
      expect(() => service.validateExplicit('курс-мой')).toThrow(
        BadRequestException,
      );
    });

    it('спецсимволы / пробелы / подчёркивания → 400', () => {
      expect(() => service.validateExplicit('my course')).toThrow(
        BadRequestException,
      );
      expect(() => service.validateExplicit('my_course')).toThrow(
        BadRequestException,
      );
      expect(() => service.validateExplicit('my/course')).toThrow(
        BadRequestException,
      );
    });

    it('ведущий или замыкающий "-" → 400', () => {
      expect(() => service.validateExplicit('-abc')).toThrow(BadRequestException);
      expect(() => service.validateExplicit('abc-')).toThrow(BadRequestException);
    });

    it('двойной дефис "--" → 400', () => {
      expect(() => service.validateExplicit('my--course')).toThrow(
        BadRequestException,
      );
    });

    it('не-строка → 400', () => {
      expect(() => service.validateExplicit(undefined as any)).toThrow(
        BadRequestException,
      );
      expect(() => service.validateExplicit(123 as any)).toThrow(
        BadRequestException,
      );
    });
  });
});
