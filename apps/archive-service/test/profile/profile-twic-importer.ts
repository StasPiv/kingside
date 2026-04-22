#!/usr/bin/env tsx
/**
 * KS-1687 — standalone profiler для `TwicImporter.runForIssue`.
 *
 * Инвокация:
 *   node --expose-gc --loader tsx/esm test/profile/profile-twic-importer.ts 8000
 *   или
 *   /project/node_modules/.bin/tsx test/profile/profile-twic-importer.ts 8000
 *
 * Возвращает JSON на stdout со всеми замерами RSS. Вызывается из
 * `twic.importer.streaming.spec.ts` через child_process для изоляции
 * от jest-framework памяти (jest сам держит ~200-300 MiB heap).
 *
 * Stdout: строка JSON `{ peakRssMiB, stages: {...}, result: {...} }`.
 * Stderr: человеческий лог по стадиям.
 */

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
// Nest Logger пишет в stdout по умолчанию — это ломает нам JSON-вывод,
// который парсит родительский процесс (jest-spec).
Logger.overrideLogger(false);
import { Worker } from 'node:worker_threads';
import { TwicImporter } from '../../src/archive-import/sources/twic.importer';
import type { ArchiveSourceRow } from '../../src/archive-import/sources/twic.importer';
import type { ArchivePositionWriterService } from '../../src/archive-import/archive-position-writer.service';
import type { PositionIndexerService } from '../../src/archive-import/position-indexer.service';
import type { ArchiveImportMetricsService } from '../../src/archive-import/archive-import-metrics.service';
import {
  generateTwicZip,
  generateTwicZipWithDuplicateAt,
} from '../fixtures/twic-synthetic';

const MIB = 1024 * 1024;

type Mode = 'unique' | 'duplicate' | 'idempotent';

interface Args {
  gamesCount: number;
  issue: number;
  mode: Mode;
  /** Для `duplicate` — индекс партии-оригинала и её дубля. */
  dupFirst?: number;
  dupSecond?: number;
  /** Для `idempotent` — сколько раз прогнать подряд (все на той же fake-Prisma). */
  repeat?: number;
  /**
   * KS-1688: предаллоцировать и удерживать до конца run'а Buffer указанного
   * размера в MiB — эмулирует runtime-надбавку Nest/Prisma/ioredis (~80-120
   * MiB на prod'е), которую fake-DI синтетики не моделируют. Без этого флага
   * peak RSS профиля — чисто «importer-only» и не сопоставим с CloudWatch
   * Container Insights по Fargate-task'у. Значение 80 MiB подобрано по
   * наблюдаемой разнице 447 (prod TWIC-1639) − ~327 (изолированный
   * importer) ≈ 120 MiB для полного Nest-бутстрапа; берём 80 как нижняя
   * оценка, оставляя запас до 512-limit'а.
   */
  baselineBufferMiB?: number;
}

function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flags = new Map<string, string>();
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v = 'true'] = a.replace(/^--/, '').split('=');
      flags.set(k, v);
    }
  }
  const gamesCount = parseInt(positional[0] ?? '8000', 10);
  const issue = parseInt(flags.get('issue') ?? '9999', 10);
  const mode = (flags.get('mode') ?? 'unique') as Mode;
  const dupFirst = flags.has('dup-first')
    ? parseInt(flags.get('dup-first')!, 10)
    : undefined;
  const dupSecond = flags.has('dup-second')
    ? parseInt(flags.get('dup-second')!, 10)
    : undefined;
  const repeat = flags.has('repeat')
    ? parseInt(flags.get('repeat')!, 10)
    : undefined;
  const baselineBufferMiB = flags.has('baseline-buffer')
    ? parseInt(flags.get('baseline-buffer')!, 10)
    : undefined;
  return {
    gamesCount,
    issue,
    mode,
    dupFirst,
    dupSecond,
    repeat,
    baselineBufferMiB,
  };
}

// ─── Fake DI ──────────────────────────────────────────────────────────

interface FakeDb {
  /** content_hash-hex всех уже импортированных партий. */
  known: Set<string>;
  /** Счётчик archive_imports create вызовов. */
  importCreates: number;
  /** Последний update'нутый archive_imports row. */
  lastImportUpdate: {
    id: string;
    status: string;
    gamesParsed: number;
    gamesAdded: number;
    gamesSkipped: number;
    cursorAfter: string | null;
    finishedAt: Date | null;
  } | null;
  /** Вызов archiveSource.update (не должно в ad-hoc). */
  sourceUpdates: number;
  gameSeq: number;
}

function fakePrisma(state: FakeDb): unknown {
  return {
    archiveImport: {
      async create({ data }: { data: Record<string, unknown> }) {
        state.importCreates += 1;
        return {
          id: `import-${state.importCreates}`,
          ...(data as object),
        };
      },
      async update({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) {
        state.lastImportUpdate = {
          id: where.id,
          status: (data.status as string) ?? 'unknown',
          gamesParsed: (data.gamesParsed as number) ?? 0,
          gamesAdded: (data.gamesAdded as number) ?? 0,
          gamesSkipped: (data.gamesSkipped as number) ?? 0,
          cursorAfter: (data.cursorAfter as string | null) ?? null,
          finishedAt: (data.finishedAt as Date | null) ?? null,
        };
        return state.lastImportUpdate;
      },
    },
    archiveGame: {
      async findMany({
        where,
      }: {
        where: { contentHash: { in: Uint8Array[] } };
      }) {
        // Возвращаем только те из запрошенных, что уже в state.known.
        return where.contentHash.in
          .filter((h) => state.known.has(Buffer.from(h).toString('hex')))
          .map((h) => ({ contentHash: Buffer.from(h) }));
      },
      async create({
        data,
      }: {
        data: { contentHash: Uint8Array };
        select: { id: true };
      }) {
        const hex = Buffer.from(data.contentHash).toString('hex');
        if (state.known.has(hex)) {
          const err = new Error(
            `UNIQUE violation on content_hash ${hex.slice(0, 8)}…`,
          ) as Error & { code?: string };
          err.code = 'P2002';
          throw err;
        }
        state.known.add(hex);
        state.gameSeq += 1;
        return { id: `game-${state.gameSeq}` };
      },
    },
    archiveSource: {
      async update() {
        state.sourceUpdates += 1;
        return {};
      },
    },
  };
}

function fakeMetrics(): ArchiveImportMetricsService {
  const counter = { inc: () => {} };
  const gauge = { set: () => {} };
  return {
    archiveImportGamesTotal: counter,
    archiveGamesByCategoryTotal: counter,
    archiveRejectedUnknownReasonTotal: counter,
    archiveImportedNonClassicalTotal: counter,
    archiveClassicalRatio: gauge,
  } as unknown as ArchiveImportMetricsService;
}

function fakeIndexer(): PositionIndexerService {
  return {
    async index() {
      // no-op; реальный индексер делает SQL, но для профиля RSS это шум.
    },
  } as unknown as PositionIndexerService;
}

function fakeWriter(): ArchivePositionWriterService {
  return {
    async write() {
      // no-op; реальный writer делает pg COPY.
    },
  } as unknown as ArchivePositionWriterService;
}

// ─── Измеритель RSS ───────────────────────────────────────────────────

interface Measurement {
  stage: string;
  rssMiB: number;
  heapUsedMiB: number;
  externalMiB: number;
}

function snapshotRss(stage: string, forceGc: boolean): Measurement {
  if (forceGc && typeof global.gc === 'function') {
    global.gc();
  }
  const m = process.memoryUsage();
  return {
    stage,
    rssMiB: m.rss / MIB,
    heapUsedMiB: m.heapUsed / MIB,
    externalMiB: m.external / MIB,
  };
}

/**
 * Spawn worker_thread, который читает RSS родителя каждые 10 мс и
 * сохраняет максимум. Нужен потому что main thread заблокирован
 * синхронным parseBatch (chess.js парсит 8k партий ~10-15с без
 * await) — setInterval в main не успевает отработать из-за
 * microtask-starvation. Worker работает в отдельном event-loop
 * того же процесса (shared RSS).
 */
function startRssPeakSampler(): { stop: () => Promise<number> } {
  const workerSrc = `
    const { parentPort } = require('node:worker_threads');
    let peak = 0;
    const timer = setInterval(() => {
      const rss = process.memoryUsage().rss;
      if (rss > peak) peak = rss;
    }, 10);
    parentPort.on('message', (msg) => {
      if (msg === 'stop') {
        clearInterval(timer);
        parentPort.postMessage({ peakRss: peak });
      }
    });
  `;
  const worker = new Worker(workerSrc, { eval: true });
  return {
    async stop(): Promise<number> {
      return new Promise((resolve, reject) => {
        worker.once('message', (m: { peakRss: number }) => {
          worker.terminate().catch(() => {});
          resolve(m.peakRss);
        });
        worker.once('error', reject);
        worker.postMessage('stop');
      });
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const startMeasurements: Measurement[] = [];
  const peakSampler = startRssPeakSampler();

  startMeasurements.push(snapshotRss('start', true));

  // KS-1688: baseline-buffer — эмулирует Nest/Prisma/ioredis runtime-надбавку.
  // Аллоцируем ПЕРЕД запуском importer'а и заполняем (чтобы kernel мапнул
  // физические страницы — иначе RSS не вырастет, buffer останется lazy).
  // Ссылка живёт до конца main() через замыкание — GC не освободит.
  let baselineBuffer: Buffer | undefined;
  if (args.baselineBufferMiB && args.baselineBufferMiB > 0) {
    baselineBuffer = Buffer.alloc(args.baselineBufferMiB * MIB);
    // Заполняем non-zero патернами: Buffer.alloc сам zero-filled, но kernel
    // всё равно может ленить и возвращать «zero page» для read-only страниц.
    // Пишем 1 байт в каждую 4-KiB страницу — гарантируем commit.
    for (let off = 0; off < baselineBuffer.length; off += 4096) {
      baselineBuffer[off] = 1;
    }
    startMeasurements.push(snapshotRss('after-baseline-buffer', true));
  }

  // Build fixture.
  const zipBuf =
    args.mode === 'duplicate' &&
    args.dupFirst !== undefined &&
    args.dupSecond !== undefined
      ? generateTwicZipWithDuplicateAt(
          args.gamesCount,
          args.dupFirst,
          args.dupSecond,
        )
      : generateTwicZip(args.gamesCount);

  startMeasurements.push(snapshotRss('after-fixture-build', true));

  // Stub fetch.
  (
    globalThis as unknown as { fetch: (...args: unknown[]) => unknown }
  ).fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      zipBuf.buffer.slice(
        zipBuf.byteOffset,
        zipBuf.byteOffset + zipBuf.byteLength,
      ),
  });

  const state: FakeDb = {
    known: new Set<string>(),
    importCreates: 0,
    lastImportUpdate: null,
    sourceUpdates: 0,
    gameSeq: 0,
  };

  const prisma = fakePrisma(state);
  const source: ArchiveSourceRow = {
    id: 'source-uuid',
    code: 'twic',
    cursor: '1641',
  };
  const importer = new TwicImporter(
    prisma as never,
    source,
    fakeWriter(),
    fakeIndexer(),
    fakeMetrics(),
  );

  const runs: Array<{
    status: string;
    gamesParsed: number;
    gamesAdded: number;
    gamesSkipped: number;
    cursorBefore: string | null;
    cursorAfter: string | null;
    fileName: string | null;
  }> = [];

  const repeats = args.repeat ?? (args.mode === 'idempotent' ? 2 : 1);

  startMeasurements.push(snapshotRss('before-run', true));

  for (let i = 0; i < repeats; i++) {
    const res = await importer.runAdHoc(args.issue);
    runs.push({
      status: res.status,
      gamesParsed: res.gamesParsed,
      gamesAdded: res.gamesAdded,
      gamesSkipped: res.gamesSkipped,
      cursorBefore: res.cursorBefore,
      cursorAfter: res.cursorAfter,
      fileName: res.fileName,
    });
    startMeasurements.push(
      snapshotRss(`after-run-${i + 1}`, true),
    );
  }

  const peakRssBytes = await peakSampler.stop();

  // Final forced GC + measurement.
  const endMeasurement = snapshotRss('end', true);
  startMeasurements.push(endMeasurement);

  // Удерживаем ссылку на baseline-buffer до конца main() — чтобы V8 не
  // освободил его «оптимистично» в середине run'а и не обнулил эмуляцию.
  const baselineBufferSize = baselineBuffer?.length ?? 0;

  const output = {
    peakRssMiB: peakRssBytes / MIB,
    measurements: startMeasurements,
    runs,
    db: {
      knownCount: state.known.size,
      importCreates: state.importCreates,
      sourceUpdates: state.sourceUpdates,
      lastImportUpdate: state.lastImportUpdate,
    },
    gcExposed: typeof global.gc === 'function',
    baselineBufferMiB: baselineBufferSize / MIB,
  };

  // stderr — читаемо для оператора, stdout — чистый JSON для родительского процесса.
  for (const m of startMeasurements) {
    process.stderr.write(
      `[${m.stage.padEnd(24)}] rss=${m.rssMiB.toFixed(1)} MiB  heap=${m.heapUsedMiB.toFixed(1)} MiB  ext=${m.externalMiB.toFixed(1)} MiB\n`,
    );
  }
  process.stderr.write(
    `peak sampler rss=${(peakRssBytes / MIB).toFixed(1)} MiB (worker, every 10ms)\n`,
  );

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(
    `FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
