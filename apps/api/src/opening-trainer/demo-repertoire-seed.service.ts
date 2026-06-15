import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type OpeningRepertoireDetailDto,
  type OpeningRepertoireSourceDto,
  type RepertoireTree,
  type TrainerColor,
} from '@kingside/shared';
import {
  RepertoireBuilderService,
  RepertoirePgnError,
  RepertoireLimitExceededError,
} from './repertoire-builder.service';

/**
 * KS-4162 / ADR-128 §10. Загрузчик демо-репертуаров для публичных
 * GET-эндпоинтов `/opening-trainer/demo[/:id]`.
 *
 * Источник истины — PGN-файлы в `seeds/demo-repertoires/<slug>.pgn`
 * с опциональным `<slug>.meta.json`. Загрузчик переиспользует общий
 * `RepertoireBuilderService.buildTree(pgn)` — никакого собственного
 * формата дерева не вводится; ответ `/demo/:id` имеет ту же форму,
 * что и личный `GET /opening-trainer/repertoires/:id`
 * (`OpeningRepertoireDetailDto`).
 *
 * Жизненный цикл:
 *   - `onModuleInit` — один проход по директории, парсинг, реестр в памяти.
 *   - Битый PGN / превышение лимита / illegal meta.json → лог + пропуск
 *     записи. Один плохой файл НЕ валит сервис.
 *   - В prod — обновление контента через рестарт сервиса (deploy `api`).
 *
 * Slug файла — `id` в URL `/demo/<slug>`. Допустимые символы:
 * `[a-z0-9-]+`. Прочие файлы пропускаются с предупреждением.
 */

/** Сторонняя форма ответа `/demo` (KS-4162 §3). */
export interface DemoRepertoireSummary {
  id: string;
  title: string;
  description: string;
  /** = `tree.meta.nodeCount`. */
  treeSize: number;
  side: TrainerColor;
  /** BCP-47 коды из `<slug>.meta.json`. Пустой массив — не задано. */
  languages: string[];
}

interface MetaFile {
  side?: TrainerColor;
  description?: string;
  languages?: string[];
}

interface LoadedDemo {
  summary: DemoRepertoireSummary;
  detail: OpeningRepertoireDetailDto;
}

const SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Фиксированный ownerId для демо-репертуаров. NIL UUID (RFC-4122) —
 * безопасный sentinel, не совпадает ни с одним реальным пользователем,
 * валиден как UUID для клиентов, которые типизируют `ownerId` как UUID.
 */
const DEMO_OWNER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Фиксированный timestamp для `createdAt`/`updatedAt` — момент эпохи Unix.
 * Демо-репертуар не имеет осмысленной «истории изменений»; реальное
 * время обновления — это деплой сервиса. Стабильное значение упрощает
 * кэширование на клиенте и тестирование.
 */
const DEMO_TIMESTAMP = new Date(0).toISOString();

@Injectable()
export class DemoRepertoireSeedService implements OnModuleInit {
  private readonly logger = new Logger(DemoRepertoireSeedService.name);
  private readonly registry = new Map<string, LoadedDemo>();
  /** Стабильный порядок (по slug, по возрастанию) для list-эндпоинта. */
  private summariesCache: DemoRepertoireSummary[] = [];

  constructor(private readonly builder: RepertoireBuilderService) {}

  onModuleInit(): void {
    this.load();
  }

  /**
   * Полный список демо-репертуаров для `GET /opening-trainer/demo`.
   * Возвращает копию массива — мутации вызывающего кода не влияют
   * на внутренний кеш.
   */
  listSummaries(): DemoRepertoireSummary[] {
    return [...this.summariesCache];
  }

  /**
   * Детальный JSON для `GET /opening-trainer/demo/:id`. Возвращает
   * `null`, если slug не найден — контроллер бросит 404.
   */
  getDetail(slug: string): OpeningRepertoireDetailDto | null {
    return this.registry.get(slug)?.detail ?? null;
  }

  /**
   * Корневой каталог seed-файлов. Вынесено в отдельный метод, чтобы
   * unit-тесты могли подменить директорию через subclass / spy.
   */
  protected getSeedDir(): string {
    return path.join(__dirname, 'seeds', 'demo-repertoires');
  }

  private load(): void {
    this.registry.clear();
    const dir = this.getSeedDir();
    if (!fs.existsSync(dir)) {
      this.logger.warn(`[demo-seed] directory not found: ${dir}`);
      this.summariesCache = [];
      return;
    }

    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch (err) {
      this.logger.error(
        `[demo-seed] cannot read directory ${dir}: ${(err as Error).message}`,
      );
      this.summariesCache = [];
      return;
    }

    const pgnFiles = files.filter((f) => f.toLowerCase().endsWith('.pgn'));
    for (const file of pgnFiles) {
      const slug = file.slice(0, -'.pgn'.length).toLowerCase();
      if (!SLUG_RE.test(slug)) {
        this.logger.warn(
          `[demo-seed] file "${file}" — slug "${slug}" не соответствует [a-z0-9-]+, пропущен`,
        );
        continue;
      }
      try {
        const loaded = this.loadOne(dir, slug, file);
        if (loaded) {
          this.registry.set(slug, loaded);
        }
      } catch (err) {
        this.logger.error(
          `[demo-seed] не удалось загрузить "${file}": ${(err as Error).message}`,
        );
      }
    }

    this.summariesCache = Array.from(this.registry.values())
      .map((d) => d.summary)
      .sort((a, b) => a.id.localeCompare(b.id));

    this.logger.log(
      `[demo-seed] загружено демо-репертуаров: ${this.registry.size}`,
    );
  }

  private loadOne(dir: string, slug: string, file: string): LoadedDemo | null {
    const pgnPath = path.join(dir, file);
    const pgn = fs.readFileSync(pgnPath, 'utf8');

    const meta = this.readMeta(dir, slug);
    let tree: RepertoireTree;
    try {
      tree = this.builder.buildTree(pgn);
    } catch (err) {
      if (
        err instanceof RepertoirePgnError ||
        err instanceof RepertoireLimitExceededError
      ) {
        this.logger.warn(
          `[demo-seed] PGN "${file}" отклонён парсером: ${err.message}`,
        );
        return null;
      }
      throw err;
    }

    const title = extractTitleFromPgn(pgn) ?? slugToTitle(slug);
    const annotator = extractTagFromPgn(pgn, 'Annotator');
    const description = meta.description ?? annotator ?? '';
    const side: TrainerColor = meta.side ?? 'white';
    const languages = Array.isArray(meta.languages) ? meta.languages : [];

    const sourceId = `${slug}-pgn`;
    const source: OpeningRepertoireSourceDto = {
      id: sourceId,
      repertoireId: slug,
      name: title,
      pgn,
      sourceKind: 'legacy-import',
      sourceAnalysisId: null,
      archiveGameId: null,
      order: 0,
      createdAt: DEMO_TIMESTAMP,
      updatedAt: DEMO_TIMESTAMP,
    };

    const summary: DemoRepertoireSummary = {
      id: slug,
      title,
      description,
      treeSize: tree.meta.nodeCount,
      side,
      languages,
    };

    const detail: OpeningRepertoireDetailDto = {
      id: slug,
      ownerId: DEMO_OWNER_ID,
      title,
      description: description.length > 0 ? description : null,
      side,
      nodeCount: tree.meta.nodeCount,
      edgeCount: tree.meta.edgeCount,
      maxDepth: tree.meta.maxDepth,
      createdAt: DEMO_TIMESTAMP,
      updatedAt: DEMO_TIMESTAMP,
      pgn,
      tree,
      sources: [source],
    };

    return { summary, detail };
  }

  private readMeta(dir: string, slug: string): MetaFile {
    const metaPath = path.join(dir, `${slug}.meta.json`);
    if (!fs.existsSync(metaPath)) {
      return {};
    }
    try {
      const raw = fs.readFileSync(metaPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return sanitizeMeta(parsed);
    } catch (err) {
      this.logger.warn(
        `[demo-seed] meta-файл "${slug}.meta.json" не распарсился: ${(err as Error).message}`,
      );
      return {};
    }
  }
}

/**
 * Парсит JSON-объект meta.json в типизированную форму. Игнорирует
 * незнакомые поля и неверные значения — это «best-effort» парсинг
 * контента, ошибка в meta.json не должна валить весь репертуар.
 */
function sanitizeMeta(raw: unknown): MetaFile {
  if (!raw || typeof raw !== 'object') return {};
  const out: MetaFile = {};
  const r = raw as Record<string, unknown>;
  if (r.side === 'white' || r.side === 'black') {
    out.side = r.side;
  }
  if (typeof r.description === 'string') {
    out.description = r.description;
  }
  if (Array.isArray(r.languages)) {
    out.languages = r.languages.filter(
      (x): x is string => typeof x === 'string',
    );
  }
  return out;
}

/** Достаёт значение PGN-тега из заголовка (первая партия). */
function extractTagFromPgn(pgn: string, tag: string): string | null {
  const re = new RegExp(`^\\[${tag}\\s+"([^"]*)"\\]`, 'm');
  const m = re.exec(pgn);
  if (!m) return null;
  const v = m[1].trim();
  return v.length > 0 ? v : null;
}

function extractTitleFromPgn(pgn: string): string | null {
  return extractTagFromPgn(pgn, 'Event');
}

/** `najdorf-main-line` → `Najdorf Main Line`. */
function slugToTitle(slug: string): string {
  return slug
    .split('-')
    .filter((p) => p.length > 0)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(' ');
}
