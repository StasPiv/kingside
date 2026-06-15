import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import {
  RATE_LIMIT_KEY,
  RedisRateLimitGuard,
} from '../common/redis-rate-limit.guard';
import { OpeningTrainerController } from './opening-trainer.controller';
import { OpeningTrainerPublicController } from './opening-trainer-public.controller';
import { DemoRepertoireSeedService } from './demo-repertoire-seed.service';
import { RepertoireBuilderService } from './repertoire-builder.service';

/**
 * KS-4160 (ADR-128 §6.8.2 + §11.13) — инварианты guard'ов / контракта,
 * KS-4162 — seed-loader: пустая директория, валидный PGN, битый PGN,
 * meta.json, slug-фильтр.
 *
 * Spec работает с реальной файловой системой (tmpdir), чтобы прокатить
 * полный путь `onModuleInit → fs.readdir → builder.buildTree`.
 * Изоляция тестов — отдельная tmp-директория на каждый seed-набор.
 */

/**
 * Подкласс, позволяющий указать произвольную seed-директорию.
 * Spec гоняется без реальных PGN в репозитории.
 */
class TestableDemoSeedService extends DemoRepertoireSeedService {
  constructor(builder: RepertoireBuilderService, private readonly dir: string) {
    super(builder);
  }
  protected override getSeedDir(): string {
    return this.dir;
  }
}

function tmpSeedDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'demo-seed-'));
}

function makeService(dir: string): TestableDemoSeedService {
  const builder = new RepertoireBuilderService();
  const svc = new TestableDemoSeedService(builder, dir);
  svc.onModuleInit();
  return svc;
}

const MIN_PGN = '[Event "Italian"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 *';

describe('OpeningTrainerPublicController (KS-4160 / KS-4162)', () => {
  const reflector = new Reflector();

  // ── Guards / rate-limit инварианты (KS-4160) ─────────────────────

  it('класс: без JWT/OptionalJwt-guard', () => {
    const guards =
      reflector.get<unknown[]>('__guards__', OpeningTrainerPublicController) ?? [];
    expect(guards).not.toContain(JwtAuthGuard);
    expect(guards).not.toContain(OptionalJwtGuard);
  });

  it('класс: единственный guard — RedisRateLimitGuard', () => {
    const guards =
      reflector.get<unknown[]>('__guards__', OpeningTrainerPublicController) ?? [];
    expect(guards).toContain(RedisRateLimitGuard);
  });

  it('rate-limit: 60 req / 60 sec', () => {
    const limit = reflector.get<{ maxRequests: number; windowSec: number }>(
      RATE_LIMIT_KEY,
      OpeningTrainerPublicController,
    );
    expect(limit).toBeDefined();
    expect(limit.maxRequests).toBe(60);
    expect(limit.windowSec).toBe(60);
  });

  it('регрессия: приватный OpeningTrainerController сохраняет class-JwtAuthGuard', () => {
    const guards =
      reflector.get<unknown[]>('__guards__', OpeningTrainerController) ?? [];
    expect(guards).toContain(JwtAuthGuard);
  });

  // ── Поведение с пустой директорией (KS-4162 §проверка) ───────────

  describe('пустая директория seed', () => {
    let dir: string;
    let controller: OpeningTrainerPublicController;
    beforeEach(() => {
      dir = tmpSeedDir();
      controller = new OpeningTrainerPublicController(makeService(dir));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('GET /demo → []', () => {
      expect(controller.listDemoRepertoires()).toEqual([]);
    });

    it('GET /demo/:id → 404 на любой id', () => {
      expect(() => controller.getDemoRepertoire('anything')).toThrow(
        NotFoundException,
      );
    });
  });

  // ── Полноценный seed с PGN + meta.json ───────────────────────────

  describe('seed с одним валидным PGN', () => {
    let dir: string;
    let controller: OpeningTrainerPublicController;
    beforeEach(() => {
      dir = tmpSeedDir();
      fs.writeFileSync(path.join(dir, 'italian.pgn'), MIN_PGN, 'utf8');
      fs.writeFileSync(
        path.join(dir, 'italian.meta.json'),
        JSON.stringify({
          side: 'white',
          description: 'Итальянка за белых',
          languages: ['ru', 'en'],
        }),
        'utf8',
      );
      controller = new OpeningTrainerPublicController(makeService(dir));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('GET /demo возвращает summary-карточку', () => {
      const list = controller.listDemoRepertoires();
      expect(list).toHaveLength(1);
      const card = list[0];
      expect(card.id).toBe('italian');
      // title из PGN-тега [Event "Italian"]
      expect(card.title).toBe('Italian');
      expect(card.description).toBe('Итальянка за белых');
      expect(card.side).toBe('white');
      expect(card.languages).toEqual(['ru', 'en']);
      expect(card.treeSize).toBeGreaterThan(1);
    });

    it('GET /demo/:id возвращает OpeningRepertoireDetailDto-форму с непустым tree.nodes', () => {
      const detail = controller.getDemoRepertoire('italian');
      expect(detail.id).toBe('italian');
      expect(detail.ownerId).toBe('00000000-0000-0000-0000-000000000000');
      expect(detail.side).toBe('white');
      expect(detail.pgn).toBe(MIN_PGN);
      expect(detail.tree).toBeDefined();
      expect(detail.tree.meta.nodeCount).toBeGreaterThan(1);
      expect(detail.tree.meta.edgeCount).toBeGreaterThan(0);
      // Узлы — словарь FEN → node; должен быть как минимум root.
      expect(Object.keys(detail.tree.nodes).length).toBeGreaterThan(1);
      expect(detail.sources).toHaveLength(1);
      expect(detail.sources[0].pgn).toBe(MIN_PGN);
    });

    it('GET /demo/неизвестный → 404', () => {
      expect(() => controller.getDemoRepertoire('unknown')).toThrow(
        NotFoundException,
      );
    });
  });

  // ── Defaults без meta.json ───────────────────────────────────────

  describe('PGN без meta.json: side="white", description из [Annotator]', () => {
    let dir: string;
    let controller: OpeningTrainerPublicController;
    beforeEach(() => {
      const pgn = '[Event "London"]\n[Annotator "GM Smith"]\n\n1. d4 d5 2. Bf4 *';
      dir = tmpSeedDir();
      fs.writeFileSync(path.join(dir, 'london.pgn'), pgn, 'utf8');
      controller = new OpeningTrainerPublicController(makeService(dir));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('defaults применены', () => {
      const list = controller.listDemoRepertoires();
      expect(list).toHaveLength(1);
      expect(list[0].side).toBe('white');
      expect(list[0].description).toBe('GM Smith');
      expect(list[0].languages).toEqual([]);
    });
  });

  // ── Битый PGN не валит сервис, отсутствует в списке ──────────────

  describe('битый PGN', () => {
    let dir: string;
    let svc: TestableDemoSeedService;
    let controller: OpeningTrainerPublicController;
    beforeEach(() => {
      dir = tmpSeedDir();
      fs.writeFileSync(path.join(dir, 'broken.pgn'), 'nonsense', 'utf8');
      fs.writeFileSync(path.join(dir, 'ok.pgn'), MIN_PGN, 'utf8');
      svc = makeService(dir);
      controller = new OpeningTrainerPublicController(svc);
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('хороший репертуар грузится, плохой пропускается', () => {
      const list = controller.listDemoRepertoires();
      expect(list.map((d) => d.id)).toEqual(['ok']);
    });

    it('/demo/broken → 404 (как будто файла не было)', () => {
      expect(() => controller.getDemoRepertoire('broken')).toThrow(
        NotFoundException,
      );
    });
  });

  // ── Slug-фильтр: непригодные имена файлов пропускаются ───────────

  describe('slug-фильтр', () => {
    let dir: string;
    let controller: OpeningTrainerPublicController;
    beforeEach(() => {
      dir = tmpSeedDir();
      fs.writeFileSync(path.join(dir, 'has space.pgn'), MIN_PGN, 'utf8');
      fs.writeFileSync(path.join(dir, 'Caps.pgn'), MIN_PGN, 'utf8'); // нижний регистр после slug
      controller = new OpeningTrainerPublicController(makeService(dir));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('файл с пробелом отбрасывается, "Caps.pgn" — это slug "caps"', () => {
      const list = controller.listDemoRepertoires();
      // Только "caps" (lower-cased slug)
      expect(list.map((d) => d.id)).toEqual(['caps']);
    });
  });

  // ── POST /sessions: 204 no-op (KS-4160 / §11.13) ─────────────────

  it('POST /sessions: 204 no-op, без рантайм-ошибок', () => {
    const dir = tmpSeedDir();
    const controller = new OpeningTrainerPublicController(makeService(dir));
    try {
      expect(controller.startSession({})).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
