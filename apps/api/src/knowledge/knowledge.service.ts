import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  KNOWLEDGE_ALLOWLIST,
  KNOWLEDGE_MAX_FILE_BYTES,
  KNOWLEDGE_READ_DEFAULT_RANGE,
  KNOWLEDGE_READ_MAX_RANGE,
  KNOWLEDGE_SEARCH_CONTEXT_LINES,
  KNOWLEDGE_SEARCH_DEFAULT_LIMIT,
  KNOWLEDGE_SEARCH_MAX_LIMIT,
  KNOWLEDGE_SEARCH_TIMEOUT_MS,
  getRepoRoot,
  isPathAllowed,
  resolveAndAuthorize,
} from './knowledge.config';
import { RipgrepRunner } from './ripgrep-runner';

export interface KnowledgeSearchResult {
  path: string;
  line: number;
  snippet: string;
}

export interface KnowledgeSearchResponse {
  results: KnowledgeSearchResult[];
  truncated: boolean;
}

export interface KnowledgeReadResponse {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  totalLines: number;
}

/**
 * KS-2967 / ADR-063 Phase 2 — knowledge-tools для AI-ассистента.
 *
 * search — ripgrep по allowlist'у; результаты пост-фильтруются по
 * blocklist'у (даже если файл прошёл glob ripgrep'а, последнее слово
 * за `isPathAllowed`).
 * read — обычный fs.readFile с cap на диапазон строк и проверкой
 * allowlist/blocklist для пути.
 */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(private readonly ripgrep: RipgrepRunner) {}

  /** Запускает ripgrep и возвращает первые N результатов. */
  async search(dto: {
    q: string;
    glob?: string;
    limit?: number;
  }): Promise<KnowledgeSearchResponse> {
    const start = Date.now();
    const repoRoot = getRepoRoot();
    const limit = clamp(
      dto.limit ?? KNOWLEDGE_SEARCH_DEFAULT_LIMIT,
      1,
      KNOWLEDGE_SEARCH_MAX_LIMIT,
    );

    // Базовые аргументы. `-F` — fixed-string (без regex, защита от ReDoS).
    // `--vimgrep` — формат `path:line:col:match`. `-N` — без числа
    // строк (мы сами добавляем). `--max-filesize` страхует от
    // огромных бинарников.
    const args: string[] = [
      '--vimgrep',
      '--no-heading',
      '--color=never',
      '-F',
      '-S', // smart-case
      '--max-filesize',
      String(KNOWLEDGE_MAX_FILE_BYTES),
      // Cap на матчи в одном файле — иначе один файл с тысячами
      // вхождений «использует» весь лимит.
      '--max-count',
      String(Math.min(limit, 5)),
    ];

    // Жёсткие глобальные исключения «мусора» — независимо от blocklist
    // ещё и страховка от того, что rg попадёт в node_modules / dist.
    args.push('--glob', '!**/node_modules/**');
    args.push('--glob', '!**/dist/**');
    args.push('--glob', '!**/build/**');
    args.push('--glob', '!**/.git/**');

    if (dto.glob && dto.glob.length > 0) {
      // Пользовательский glob — дополнительный фильтр поверх allowlist'а.
      args.push('--iglob', dto.glob);
    }

    args.push('--', dto.q);

    // Search-roots — только реально существующие корни allowlist'а.
    // Передача несуществующего пути даёт rg exit-2 и наш сервис
    // отдаёт 503; на dev/test-окружениях apps/web может отсутствовать,
    // поэтому проверяем существование заранее.
    const seenRoots = new Set<string>();
    let appendedRoots = 0;
    for (const p of KNOWLEDGE_ALLOWLIST) {
      const root = globRoot(p);
      if (seenRoots.has(root)) continue;
      seenRoots.add(root);
      const abs = path.resolve(repoRoot, root);
      if (fs.existsSync(abs)) {
        args.push(root);
        appendedRoots++;
      }
    }
    // Если в этом репо нет ни одного allowlist-корня — пустой результат
    // без обращения к rg (например, тесты, или backend-контейнер без
    // apps/web).
    if (appendedRoots === 0) {
      return { results: [], truncated: false };
    }

    const result = await this.ripgrep.run(args, repoRoot, KNOWLEDGE_SEARCH_TIMEOUT_MS);

    if (result.kind === 'timeout') {
      this.logger.warn(
        `knowledge.search timeout q=${JSON.stringify(dto.q)} after ${KNOWLEDGE_SEARCH_TIMEOUT_MS}ms`,
      );
      throw new ServiceUnavailableException({
        error: 'search_timeout',
        message: `Search timed out after ${KNOWLEDGE_SEARCH_TIMEOUT_MS}ms. Try a more specific query.`,
      });
    }
    if (result.kind === 'error') {
      this.logger.error(`knowledge.search rg-error: ${result.message}`);
      throw new ServiceUnavailableException({
        error: 'search_failed',
        message: 'Search backend is unavailable.',
      });
    }

    const lines = result.stdout.split('\n').filter(Boolean);
    const results: KnowledgeSearchResult[] = [];
    let truncated = false;
    let deniedCount = 0;

    for (const line of lines) {
      // vimgrep: `path:line:col:match`
      const m = /^([^:]+(?::[^:]+)*?):(\d+):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      const filePath = m[1].replace(/\\/g, '/');
      const lineNo = parseInt(m[2], 10);

      // Hide-not-found: даже если ripgrep вернул путь не из allowlist'а
      // (например через --iglob кто-то указал `**`) — отсекаем здесь.
      if (!isPathAllowed(filePath)) {
        deniedCount++;
        continue;
      }

      const snippet = await readSnippet(
        path.resolve(repoRoot, filePath),
        lineNo,
        KNOWLEDGE_SEARCH_CONTEXT_LINES,
      );
      results.push({ path: filePath, line: lineNo, snippet });
      if (results.length >= limit) {
        truncated = lines.length > results.length;
        break;
      }
    }

    this.logger.log(
      `knowledge.search q=${JSON.stringify(dto.q).slice(0, 80)} ` +
        `results=${results.length} truncated=${truncated} ` +
        `denied=${deniedCount} duration_ms=${Date.now() - start}`,
    );

    return { results, truncated };
  }

  /** Читает диапазон строк из allowlisted файла. */
  async read(dto: {
    path: string;
    startLine?: number;
    endLine?: number;
  }): Promise<KnowledgeReadResponse> {
    const start = Date.now();
    const repoRoot = getRepoRoot();

    const resolved = resolveAndAuthorize(dto.path, repoRoot);
    if (!resolved) {
      // Hide-not-found: не различаем «нет файла», «вне allowlist», «в
      // blocklist», «path traversal» — единый ответ.
      throw new NotFoundException({ error: 'not_found', message: 'File not found' });
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(resolved.absPath);
    } catch {
      throw new NotFoundException({ error: 'not_found', message: 'File not found' });
    }
    if (!stat.isFile()) {
      throw new NotFoundException({ error: 'not_found', message: 'File not found' });
    }
    if (stat.size > KNOWLEDGE_MAX_FILE_BYTES) {
      throw new BadRequestException({
        error: 'file_too_large',
        message: `File exceeds ${KNOWLEDGE_MAX_FILE_BYTES} bytes limit`,
      });
    }

    // Нормализация диапазона + проверка cap на 500 строк.
    const startLine = Math.max(1, dto.startLine ?? 1);
    const requestedEnd =
      dto.endLine !== undefined && dto.endLine >= startLine
        ? dto.endLine
        : startLine + KNOWLEDGE_READ_DEFAULT_RANGE - 1;
    const rangeSize = requestedEnd - startLine + 1;
    if (rangeSize > KNOWLEDGE_READ_MAX_RANGE) {
      throw new BadRequestException({
        error: 'range_too_large',
        message: `Requested ${rangeSize} lines, max ${KNOWLEDGE_READ_MAX_RANGE} per read`,
      });
    }

    const buf = await fs.promises.readFile(resolved.absPath);
    // Бинарные файлы — отказ. Достаточная эвристика: NUL-байт в первых
    // 8KB. Покрывает все типовые бинарники.
    if (buf.subarray(0, 8192).includes(0)) {
      throw new BadRequestException({
        error: 'binary_file',
        message: 'Cannot read binary file',
      });
    }

    const text = buf.toString('utf8');
    const allLines = text.split('\n');
    const totalLines = allLines.length;
    const effectiveEnd = Math.min(requestedEnd, totalLines);
    const slice = allLines.slice(startLine - 1, effectiveEnd).join('\n');

    this.logger.log(
      `knowledge.read path=${resolved.relPath} ` +
        `range=${startLine}-${effectiveEnd}/${totalLines} ` +
        `duration_ms=${Date.now() - start}`,
    );

    return {
      path: resolved.relPath,
      startLine,
      endLine: effectiveEnd,
      content: slice,
      totalLines,
    };
  }
}

// ─── helpers ────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return Math.max(min, Math.min(max, v));
}

/**
 * Извлекает «корень» glob-паттерна — часть до первого wildcard, годная
 * как путь для `rg <root>`. Для пути `apps/web/src/pages` со звездочками
 * возвращает `apps/web/src/pages`. Для `apps/<X>/README.md` — `apps`.
 */
function globRoot(glob: string): string {
  const idx = glob.search(/[*?]/);
  if (idx < 0) return glob;
  const head = glob.slice(0, idx);
  // если на конце `/`, оставляем без него
  return head.replace(/\/+$/, '');
}

async function readSnippet(
  absPath: string,
  lineNo: number,
  contextLines: number,
): Promise<string> {
  try {
    const buf = await fs.promises.readFile(absPath, 'utf8');
    const lines = buf.split('\n');
    const start = Math.max(0, lineNo - 1 - contextLines);
    const end = Math.min(lines.length, lineNo + contextLines);
    return lines.slice(start, end).join('\n');
  } catch {
    return '';
  }
}

