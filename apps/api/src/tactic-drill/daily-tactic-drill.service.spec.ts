/**
 * KS-2250 (ADR-035 §11 / E6) — unit-тесты `DailyTacticDrillService`.
 *
 * Покрытие:
 *  - детерминизм: повторный запрос на одну date возвращает тот же drill;
 *  - difficulty по дню недели (Пн/Вт/Чт→easy, Ср/Пт→medium, Сб/Вс→hard);
 *  - 14-day no-repeat по drill.type;
 *  - exclusion использованных drill_id (без повтора позиций);
 *  - fallback A: соседний bucket если в target пусто;
 *  - fallback B: repeat (>14d) → isRepeat=true, originalDate;
 *  - fallback C: round-robin к следующему type;
 *  - 404 если все 7 типов исчерпаны;
 *  - формат response (drill без answer, drillType/difficulty labels,
 *    derive context.highlight для count-attackers).
 */
import { NotFoundException } from '@nestjs/common';
import {
  DailyTacticDrillService,
  bucketForDate,
  neighborsOf,
  toDateOnly,
  toIsoDate,
} from './daily-tactic-drill.service';
import { TacticDrillService } from './tactic-drill.service';
import { TacticDrillValidatorService } from './tactic-drill-validator.service';
import type { PrismaService } from '../prisma/prisma.service';

function makePrisma() {
  return {
    dailyTacticDrill: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    tacticDrill: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    tacticDrillAttempt: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaService & Record<string, never>;
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  const drillService = new TacticDrillService(
    prisma as unknown as PrismaService,
    new TacticDrillValidatorService(),
  );
  return new DailyTacticDrillService(prisma as unknown as PrismaService, drillService);
}

const FRIDAY = new Date(Date.UTC(2026, 4, 1)); // 2026-05-01 — Пятница, medium
const SATURDAY = new Date(Date.UTC(2026, 4, 2)); // 2026-05-02 — Суббота, hard
const SUNDAY = new Date(Date.UTC(2026, 4, 3)); // 2026-05-03 — Воскресенье, hard
const MONDAY = new Date(Date.UTC(2026, 4, 4)); // 2026-05-04 — Понедельник, easy

describe('DailyTacticDrillService — KS-2250', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: DailyTacticDrillService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = makeService(prisma);
  });

  // ─── Helpers ────────────────────────────────────────────────────

  describe('helpers', () => {
    it('bucketForDate: Пн/Вт/Чт → easy', () => {
      expect(bucketForDate(MONDAY)).toBe('easy');
      expect(bucketForDate(new Date(Date.UTC(2026, 4, 5)))).toBe('easy'); // Вт
      expect(bucketForDate(new Date(Date.UTC(2026, 4, 7)))).toBe('easy'); // Чт
    });
    it('bucketForDate: Ср/Пт → medium', () => {
      expect(bucketForDate(new Date(Date.UTC(2026, 4, 6)))).toBe('medium'); // Ср
      expect(bucketForDate(FRIDAY)).toBe('medium');
    });
    it('bucketForDate: Сб/Вс → hard', () => {
      expect(bucketForDate(SATURDAY)).toBe('hard');
      expect(bucketForDate(SUNDAY)).toBe('hard');
    });
    it('neighborsOf: easy → [medium, hard]', () => {
      expect(neighborsOf('easy')).toEqual(['medium', 'hard']);
    });
    it('neighborsOf: hard → [medium, easy]', () => {
      expect(neighborsOf('hard')).toEqual(['medium', 'easy']);
    });
    it('neighborsOf: medium → [easy, hard]', () => {
      expect(neighborsOf('medium')).toEqual(['easy', 'hard']);
    });
    it('toIsoDate возвращает YYYY-MM-DD UTC', () => {
      expect(toIsoDate(new Date(Date.UTC(2026, 4, 3)))).toBe('2026-05-03');
    });
    it('toDateOnly обрезает до 00:00 UTC', () => {
      const d = new Date(Date.UTC(2026, 4, 3, 15, 30, 45));
      const only = toDateOnly(d);
      expect(only.getUTCHours()).toBe(0);
      expect(only.getUTCMinutes()).toBe(0);
      expect(toIsoDate(only)).toBe('2026-05-03');
    });
  });

  // ─── Детерминизм ────────────────────────────────────────────────

  describe('детерминизм', () => {
    it('повторный запрос на ту же дату → тот же drill (cache hit)', async () => {
      const cached = {
        date: toDateOnly(FRIDAY),
        drillType: 'find-pin',
        difficulty: 'medium',
        isRepeat: false,
        originalDate: null,
        drill: {
          id: 'drill-cached',
          type: 'find-pin',
          fen: '4k3/8/2n5/8/B7/8/8/4K3 w - - 0 1',
          difficulty: 3,
        },
      };
      (prisma.dailyTacticDrill.findUnique as jest.Mock).mockResolvedValue(cached);

      const r1 = await svc.getDaily(FRIDAY, 'ru');
      const r2 = await svc.getDaily(FRIDAY, 'ru');
      expect(r1.drill.id).toBe('drill-cached');
      expect(r2.drill.id).toBe('drill-cached');
      // create НЕ вызывался (всё из кеша).
      expect(prisma.dailyTacticDrill.create).not.toHaveBeenCalled();
    });

    it('first call создаёт запись, second call возвращает cached', async () => {
      const findUnique = prisma.dailyTacticDrill.findUnique as jest.Mock;
      findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
        date: toDateOnly(FRIDAY),
        drillType: 'find-pin',
        difficulty: 'medium',
        isRepeat: false,
        originalDate: null,
        drill: {
          id: 'drill-1',
          type: 'find-pin',
          fen: '4k3/8/2n5/8/B7/8/8/4K3 w - - 0 1',
          difficulty: 3,
        },
      });
      (prisma.tacticDrill.count as jest.Mock).mockResolvedValue(1);
      (prisma.tacticDrill.findFirst as jest.Mock).mockResolvedValue({
        id: 'drill-1',
        type: 'find-pin',
        fen: '4k3/8/2n5/8/B7/8/8/4K3 w - - 0 1',
        difficulty: 3,
      });
      (prisma.dailyTacticDrill.create as jest.Mock).mockResolvedValue({
        date: toDateOnly(FRIDAY),
        drillType: 'find-pin',
        difficulty: 'medium',
        isRepeat: false,
        originalDate: null,
        drill: {
          id: 'drill-1',
          type: 'find-pin',
          fen: '4k3/8/2n5/8/B7/8/8/4K3 w - - 0 1',
          difficulty: 3,
        },
      });

      await svc.getDaily(FRIDAY, 'ru');
      await svc.getDaily(FRIDAY, 'ru');
      // create вызван только 1 раз.
      expect(prisma.dailyTacticDrill.create).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Pick logic ────────────────────────────────────────────────

  describe('pick logic', () => {
    function setupForPick(opts: {
      foundDrill?: {
        id: string;
        type: string;
        fen: string;
        difficulty: number;
      } | null;
      total?: number;
      recentTypes?: { drillType: string }[];
      usedIds?: { drillId: string }[];
    }) {
      const findUnique = prisma.dailyTacticDrill.findUnique as jest.Mock;
      findUnique.mockResolvedValueOnce(null);

      // Второй вызов после create — возвращает запись c созданным drill.
      (prisma.tacticDrill.count as jest.Mock).mockResolvedValue(opts.total ?? 0);
      (prisma.tacticDrill.findFirst as jest.Mock).mockResolvedValue(
        opts.foundDrill ?? null,
      );
      (prisma.dailyTacticDrill.findMany as jest.Mock).mockImplementation((args: { distinct?: string[] }) => {
        if (args?.distinct?.includes('drillType')) {
          return Promise.resolve(opts.recentTypes ?? []);
        }
        return Promise.resolve(opts.usedIds ?? []);
      });
      (prisma.dailyTacticDrill.create as jest.Mock).mockImplementation((args: { data: Record<string, unknown> }) => {
        return Promise.resolve({
          date: args.data.date,
          drillType: args.data.drillType,
          difficulty: args.data.difficulty,
          isRepeat: args.data.isRepeat,
          originalDate: args.data.originalDate,
          drill: opts.foundDrill,
        });
      });
    }

    it('Пятница (medium) → выбирает drill с difficulty IN [3]', async () => {
      setupForPick({
        total: 1,
        foundDrill: {
          id: 'drill-medium',
          type: 'find-pin',
          fen: '4k3/8/2n5/8/B7/8/8/4K3 w - - 0 1',
          difficulty: 3,
        },
      });
      const r = await svc.getDaily(FRIDAY, 'ru');
      expect(r.difficulty).toBe('medium');
      // Проверяем фильтр в первом count-вызове (target bucket).
      const countCalls = (prisma.tacticDrill.count as jest.Mock).mock.calls;
      const firstWhere = countCalls[0][0].where;
      expect(firstWhere.difficulty).toEqual({ in: [3] });
      expect(firstWhere.sfRejected).toBe(false);
    });

    it('Понедельник (easy) → difficulty IN [1,2]', async () => {
      setupForPick({
        total: 1,
        foundDrill: {
          id: 'drill-easy',
          type: 'find-fork',
          fen: '4k3/8/8/4r3/2N5/q7/8/4K3 w - - 0 1',
          difficulty: 2,
        },
      });
      const r = await svc.getDaily(MONDAY, 'ru');
      expect(r.difficulty).toBe('easy');
      const firstWhere = (prisma.tacticDrill.count as jest.Mock).mock.calls[0][0].where;
      expect(firstWhere.difficulty).toEqual({ in: [1, 2] });
    });

    it('Воскресенье (hard) → difficulty IN [4,5]', async () => {
      setupForPick({
        total: 1,
        foundDrill: {
          id: 'drill-hard',
          type: 'find-fork',
          fen: '8/8/8/8/8/8/8/4K2k w - - 0 1',
          difficulty: 5,
        },
      });
      const r = await svc.getDaily(SUNDAY, 'ru');
      expect(r.difficulty).toBe('hard');
      const firstWhere = (prisma.tacticDrill.count as jest.Mock).mock.calls[0][0].where;
      expect(firstWhere.difficulty).toEqual({ in: [4, 5] });
    });

    it('14-day no-repeat по type: использованные типы исключаются', async () => {
      // KS-2393: после удаления mate-in-1 (deprecated) типов теперь 7.
      // recentTypes возвращает 6 типов из 7 → останется только find-undefended-attack.
      setupForPick({
        total: 1,
        foundDrill: {
          id: 'drill-uda',
          type: 'find-undefended-attack',
          fen: '4k3/8/4n3/8/8/8/8/4KR2 w K - 0 1',
          difficulty: 3,
        },
        recentTypes: [
          { drillType: 'find-hanging-piece' },
          { drillType: 'find-loose-piece' },
          { drillType: 'find-pin' },
          { drillType: 'find-fork' },
          { drillType: 'count-attackers' },
          { drillType: 'find-all-checks' },
        ],
      });
      const r = await svc.getDaily(FRIDAY, 'ru');
      expect(r.drill.drillType).toBe('find-undefended-attack');
    });

    it('исключает уже использованные drill_id (no-repeat по позиции)', async () => {
      setupForPick({
        total: 1,
        foundDrill: {
          id: 'drill-fresh',
          type: 'find-pin',
          fen: '4k3/8/2n5/8/B7/8/8/4K3 w - - 0 1',
          difficulty: 3,
        },
        usedIds: [{ drillId: 'used-1' }, { drillId: 'used-2' }],
      });
      await svc.getDaily(FRIDAY, 'ru');
      const firstWhere = (prisma.tacticDrill.count as jest.Mock).mock.calls[0][0].where;
      expect(firstWhere.id).toEqual({ notIn: ['used-1', 'used-2'] });
    });

    it('fallback A: target bucket пустой → пробует соседний bucket', async () => {
      // KS-2393: после удаления mate-in-1 типов — 7.
      // Все 7 типов на medium (target) дают 0; на easy/hard есть 1.
      const countMock = prisma.tacticDrill.count as jest.Mock;
      // 7 zero responses (medium для каждого type) + 1 non-zero (easy для первого type)
      for (let i = 0; i < 7; i++) countMock.mockResolvedValueOnce(0);
      countMock.mockResolvedValueOnce(1); // easy для первого type

      const findUnique = prisma.dailyTacticDrill.findUnique as jest.Mock;
      findUnique.mockResolvedValueOnce(null);
      (prisma.tacticDrill.findFirst as jest.Mock).mockResolvedValue({
        id: 'drill-easy-fallback',
        type: 'count-attackers',
        fen: '4k3/8/8/8/2N5/8/8/4K3 w - - 0 1',
        difficulty: 1,
      });
      (prisma.dailyTacticDrill.create as jest.Mock).mockImplementation((args: { data: { difficulty: string; drillType: string } }) => ({
        date: toDateOnly(FRIDAY),
        drillType: args.data.drillType,
        difficulty: args.data.difficulty,
        isRepeat: false,
        originalDate: null,
        drill: {
          id: 'drill-easy-fallback',
          type: args.data.drillType,
          fen: '4k3/8/8/8/2N5/8/8/4K3 w - - 0 1',
          difficulty: 1,
        },
      }));

      const r = await svc.getDaily(FRIDAY, 'ru');
      // target medium не нашёл, fallback easy сработал.
      expect(r.difficulty).toBe('easy');
      expect(r.isRepeat).toBe(false);
    });

    it('fallback B: исчерпан банк fresh → repeat с isRepeat=true + originalDate', async () => {
      const countMock = prisma.tacticDrill.count as jest.Mock;
      // KS-2393: все 7 типов × 3 bucket'а пусты для fresh.
      for (let i = 0; i < 7 * 3; i++) countMock.mockResolvedValueOnce(0);

      const findUnique = prisma.dailyTacticDrill.findUnique as jest.Mock;
      findUnique.mockResolvedValueOnce(null);

      (prisma.dailyTacticDrill.groupBy as jest.Mock).mockImplementation((args: { where: { drillType: string } }) => {
        // groupBy возвращает кандидатов только для первого type (count-attackers).
        if (args.where.drillType === 'count-attackers') {
          return Promise.resolve([
            {
              drillId: 'drill-old',
              _count: { drillId: 1 },
              _max: { date: new Date(Date.UTC(2025, 0, 1)), difficulty: 'easy' },
            },
          ]);
        }
        return Promise.resolve([]);
      });
      (prisma.tacticDrill.findFirst as jest.Mock).mockResolvedValue({
        id: 'drill-old',
        type: 'count-attackers',
        fen: '4k3/8/8/8/2N5/8/8/4K3 w - - 0 1',
        difficulty: 1,
      });
      (prisma.dailyTacticDrill.create as jest.Mock).mockImplementation((args: { data: { isRepeat: boolean; originalDate: Date | null } }) => ({
        date: toDateOnly(FRIDAY),
        drillType: 'count-attackers',
        difficulty: 'easy',
        isRepeat: args.data.isRepeat,
        originalDate: args.data.originalDate,
        drill: {
          id: 'drill-old',
          type: 'count-attackers',
          fen: '4k3/8/8/8/2N5/8/8/4K3 w - - 0 1',
          difficulty: 1,
        },
      }));

      const r = await svc.getDaily(FRIDAY, 'ru');
      expect(r.isRepeat).toBe(true);
      expect(r.originalDate).toBe('2025-01-01');
    });

    it('404: банк полностью исчерпан', async () => {
      // Все count-вызовы возвращают 0; groupBy тоже пустой; recentTypes пустой.
      (prisma.tacticDrill.count as jest.Mock).mockResolvedValue(0);
      (prisma.dailyTacticDrill.groupBy as jest.Mock).mockResolvedValue([]);
      (prisma.dailyTacticDrill.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(svc.getDaily(FRIDAY, 'ru')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── Format ────────────────────────────────────────────────────

  describe('format response', () => {
    it('возвращает drill без answer + локализованные label', async () => {
      (prisma.dailyTacticDrill.findUnique as jest.Mock).mockResolvedValue({
        date: toDateOnly(FRIDAY),
        drillType: 'find-pin',
        difficulty: 'medium',
        isRepeat: false,
        originalDate: null,
        drill: {
          id: 'd1',
          type: 'find-pin',
          fen: '4k3/8/2n5/8/B7/8/8/4K3 w - - 0 1',
          difficulty: 3,
        },
      });

      const r = await svc.getDaily(FRIDAY, 'ru');
      expect(r.date).toBe('2026-05-01');
      expect(r.drill.id).toBe('d1');
      expect(r.drill.drillType).toBe('find-pin');
      expect((r.drill as unknown as Record<string, unknown>).answer).toBeUndefined();
      expect(r.drillTypeLabel).toEqual({ ru: 'Связка', en: 'Pin' });
      expect(r.difficulty).toBe('medium');
      expect(r.difficultyLabel).toEqual({ ru: 'Средняя', en: 'Medium' });
      expect(typeof r.hint.ru).toBe('string');
      expect(r.hint.ru.length).toBeLessThanOrEqual(90);
      expect(r.hint.en.length).toBeLessThanOrEqual(90);
      expect(r.drill.instruction).toContain('связан');
      expect(r.imageUrl).toContain('/api/tactic-drill/daily/image/2026-05-01-ru.png');
      expect(r.siteUrl).toContain('/drills/d1');
      expect(r.isRepeat).toBe(false);
      expect(r.originalDate).toBeNull();
    });

    it('locale=en: instruction на английском', async () => {
      (prisma.dailyTacticDrill.findUnique as jest.Mock).mockResolvedValue({
        date: toDateOnly(FRIDAY),
        drillType: 'find-fork',
        difficulty: 'easy',
        isRepeat: false,
        originalDate: null,
        drill: {
          id: 'd2',
          type: 'find-fork',
          fen: '4k3/8/8/4r3/2N5/q7/8/4K3 w - - 0 1',
          difficulty: 2,
        },
      });

      const r = await svc.getDaily(FRIDAY, 'en');
      expect(r.drill.instruction).toMatch(/attacking/i);
    });

    it('count-attackers → context.highlight = [highlightedSquare]', async () => {
      // Используем count-attackers c meta — buildDto должен прокинуть meta.
      // НО: buildDto в TacticDrillService для count-attackers без meta не
      // прокидывает highlight. Делаем мок: подменяем buildDto через
      // создание сервиса заново с extended TacticDrillService.
      const customDrill = {
        id: 'd-ca',
        type: 'count-attackers',
        fen: '4k3/8/8/8/2N5/8/8/4K3 w - - 0 1',
        difficulty: 2,
      };
      (prisma.dailyTacticDrill.findUnique as jest.Mock).mockResolvedValue({
        date: toDateOnly(FRIDAY),
        drillType: 'count-attackers',
        difficulty: 'easy',
        isRepeat: false,
        originalDate: null,
        drill: customDrill,
      });

      // Подменяем buildDto чтобы вернуть meta с highlightedSquare.
      const drillSvc = (svc as unknown as { drillService: TacticDrillService }).drillService;
      jest.spyOn(drillSvc, 'buildDto').mockReturnValue({
        id: 'd-ca',
        drillType: 'count-attackers',
        fen: customDrill.fen,
        sideToMove: null,
        answerShape: 'number',
        difficulty: 2,
        meta: { highlightedSquare: 'd5' },
      });

      const r = await svc.getDaily(FRIDAY, 'ru');
      expect(r.drill.context.highlight).toEqual(['d5']);
    });

    it('non-count-attackers → context.highlight = []', async () => {
      (prisma.dailyTacticDrill.findUnique as jest.Mock).mockResolvedValue({
        date: toDateOnly(FRIDAY),
        drillType: 'find-fork',
        difficulty: 'easy',
        isRepeat: false,
        originalDate: null,
        drill: {
          id: 'd3',
          type: 'find-fork',
          fen: '4k3/8/8/4r3/2N5/q7/8/4K3 w - - 0 1',
          difficulty: 2,
        },
      });
      const r = await svc.getDaily(FRIDAY, 'ru');
      expect(r.drill.context.highlight).toEqual([]);
    });

    it('isRepeat=true → originalDate в ISO формате', async () => {
      (prisma.dailyTacticDrill.findUnique as jest.Mock).mockResolvedValue({
        date: toDateOnly(FRIDAY),
        drillType: 'find-pin',
        difficulty: 'medium',
        isRepeat: true,
        originalDate: new Date(Date.UTC(2025, 11, 25)),
        drill: {
          id: 'd1',
          type: 'find-pin',
          fen: '4k3/8/2n5/8/B7/8/8/4K3 w - - 0 1',
          difficulty: 3,
        },
      });
      const r = await svc.getDaily(FRIDAY, 'ru');
      expect(r.isRepeat).toBe(true);
      expect(r.originalDate).toBe('2025-12-25');
    });
  });
});
