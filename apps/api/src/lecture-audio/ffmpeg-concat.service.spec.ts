/**
 * KS-3832 / ADR-116 §5.1, §6.3. Тесты обёртки ffmpeg.
 *
 * Гибридные:
 *  - integration на реальном ffmpeg (он стоит в Dockerfile API и
 *    локально доступен): генерируем 2 коротких WebM-Opus чанка
 *    через `ffmpeg -f lavfi sine`, склеиваем сервисом, проверяем
 *    `durationMs ≈ 2000`. Это и есть Gherkin.
 *  - unit: `parseDurationMs` (приватный, дёргаем через as any),
 *    `runWithOutput` cleanup при ошибке, очередь (`queueSize`).
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { FfmpegConcatService } from './ffmpeg-concat.service';

/**
 * KS-3877. Имитирует MediaRecorder timeslice: один WebM режется по
 * границам Matroska Cluster (магия 1F 43 B6 75). Первый чанк = всё
 * до второго кластера (EBML+Segment+Tracks+Cluster1), последующие —
 * по одному Cluster'у без заголовков. Именно так работает
 * MediaRecorder.start(timeslice) в Chromium и Firefox.
 */
async function splitWebmIntoTimesliceChunks(
  fullPath: string,
  chunkPaths: string[],
): Promise<void> {
  const buf = await fsp.readFile(fullPath);
  const CLUSTER = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
  const positions: number[] = [];
  let idx = -1;
  while (true) {
    idx = buf.indexOf(CLUSTER, idx + 1);
    if (idx === -1) break;
    positions.push(idx);
  }
  if (positions.length === 0) {
    throw new Error('splitWebmIntoTimesliceChunks: no Cluster element found');
  }
  if (positions.length < chunkPaths.length) {
    throw new Error(
      `splitWebmIntoTimesliceChunks: only ${positions.length} clusters but ${chunkPaths.length} chunks requested`,
    );
  }
  for (let i = 0; i < chunkPaths.length; i++) {
    const start = i === 0 ? 0 : positions[i];
    const end =
      i + 1 < chunkPaths.length ? positions[i + 1] : buf.length;
    await fsp.writeFile(chunkPaths[i], buf.subarray(start, end));
  }
}

/**
 * Минимальный CJS-stub p-queue для тестов. Реальный p-queue v7 — ESM,
 * jest без `--experimental-vm-modules` его не подхватывает; тестовая
 * очередь повторяет нужный нам интерфейс (`add`, `size`, `pending`)
 * и поведение concurrency.
 */
class TestQueue {
  concurrency: number;
  size = 0;
  pending = 0;
  private waiting: Array<() => void> = [];
  constructor(opts: { concurrency: number }) {
    this.concurrency = opts.concurrency;
  }
  async add<T>(task: () => Promise<T> | T): Promise<T> {
    this.size++;
    if (this.pending >= this.concurrency) {
      await new Promise<void>((r) => this.waiting.push(r));
    }
    this.size--;
    this.pending++;
    try {
      return await task();
    } finally {
      this.pending--;
      const next = this.waiting.shift();
      if (next) next();
    }
  }
}

function makeSvc(concurrency = 2): FfmpegConcatService {
  const s = new FfmpegConcatService();
  // Обходим onModuleInit (динамический import ESM не работает в jest
  // без --experimental-vm-modules); подсовываем CJS-stub очереди.
  s.setQueueForTests(
    new TestQueue({ concurrency }) as unknown as import('p-queue').default,
  );
  return s;
}

function genWebm(
  path: string,
  durationSec: number,
  opts: { clusterTimeMs?: number } = {},
): Promise<void> {
  // `-cluster_time_limit` принудительно режет WebM на Cluster'ы по
  // указанному окну (default ffmpeg = 5000 мс). В тестах нам нужен
  // несколько Cluster'ов на сравнительно коротких записях — иначе
  // splitWebmIntoTimesliceChunks падает «only N clusters».
  const clusterTimeMs = opts.clusterTimeMs ?? 1000;
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:duration=${durationSec}`,
        '-c:a',
        'libopus',
        '-cluster_time_limit',
        String(clusterTimeMs),
        '-f',
        'webm',
        path,
      ],
      { stdio: 'ignore' },
    );
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg gen exit ${code}`)),
    );
  });
}

function probeDurationMs(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        path,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    proc.stdout.on('data', (b) => (out += b.toString('utf-8')));
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0
        ? resolve(Math.round(Number(out.trim()) * 1000))
        : reject(new Error(`ffprobe exit ${code}`)),
    );
  });
}

describe('FfmpegConcatService (KS-3832)', () => {
  let svc: FfmpegConcatService;

  beforeAll(() => {
    svc = makeSvc(2);
  });

  describe('runWithOutput / concatChunksToOgg (integration)', () => {
    // KS-3877: чанки сделаны через разрез одного WebM по границам
    // Cluster — это в точности то, что выдаёт MediaRecorder в режиме
    // `start(timeslice)`. Раньше тут было `genWebm()` дважды, что
    // имитировало pattern «stop+start» и проходило через
    // ffmpeg-concat-demuxer, но в проде фронт использует timeslice;
    // новая склейка через байтовую конкатенацию должна работать
    // именно для этого сценария.
    it('склеивает N timeslice-чанков из ~3-сек WebM-Opus, длительность ≈ 3000 мс', async () => {
      const tmp = await fsp.mkdtemp(join(os.tmpdir(), 'ffmpeg-spec-'));
      const full = join(tmp, 'full.webm');
      const c0 = join(tmp, 'c0.webm');
      const c1 = join(tmp, 'c1.webm');
      try {
        await genWebm(full, 3);
        await splitWebmIntoTimesliceChunks(full, [c0, c1]);
        let copied = '';
        let durationMs = 0;
        await svc.runWithOutput(
          [c0, c1],
          async ({ localPath, durationMs: d }) => {
            copied = join(tmp, 'final.ogg');
            await fsp.copyFile(localPath, copied);
            durationMs = d;
          },
        );
        const stat = await fsp.stat(copied);
        expect(stat.size).toBeGreaterThan(0);
        const probed = await probeDurationMs(copied);
        // Окно: ffmpeg прибавляет немного на opus-overhead. Допуск ±400.
        expect(probed).toBeGreaterThanOrEqual(2600);
        expect(probed).toBeLessThanOrEqual(3400);
        expect(durationMs).toBeGreaterThanOrEqual(2600);
        expect(durationMs).toBeLessThanOrEqual(3400);
      } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
      }
    }, 30_000);

    it('одиночный чанк (полный WebM-файл) — длительность ≈ 1000 мс', async () => {
      const tmp = await fsp.mkdtemp(join(os.tmpdir(), 'ffmpeg-spec-'));
      const c0 = join(tmp, 'c0.webm');
      try {
        await genWebm(c0, 1);
        const { durationMs } = await svc.runWithOutput(
          [c0],
          async (out) => out,
        );
        expect(durationMs).toBeGreaterThanOrEqual(700);
        expect(durationMs).toBeLessThanOrEqual(1400);
      } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
      }
    }, 30_000);

    // KS-3877: ключевая регрессионная проверка. Раньше при склейке
    // через `-f concat` каждый чанк трактовался отдельно, и без
    // заголовков (chunkN, N≥1) отбрасывался → результат был ровно в
    // один timeslice. Сейчас байтовая конкатенация даёт суммарную
    // длительность всех clusters.
    it('KS-3877: финальная длительность = сумме длительностей всех timeslice-чанков (а не первого)', async () => {
      const tmp = await fsp.mkdtemp(join(os.tmpdir(), 'ffmpeg-spec-'));
      const full = join(tmp, 'full.webm');
      try {
        // Длинная запись — гарантируем минимум 3 Cluster'а.
        await genWebm(full, 12);
        const chunkPaths = [0, 1, 2].map((i) => join(tmp, `c${i}.webm`));
        await splitWebmIntoTimesliceChunks(full, chunkPaths);
        let durationMs = 0;
        await svc.runWithOutput(chunkPaths, async ({ durationMs: d }) => {
          durationMs = d;
        });
        // Если бы возвращался только первый чанк, было бы ~3-4 секунды.
        // С исправлением — все 3 chunk'а суммарно ≈ полная длительность.
        expect(durationMs).toBeGreaterThanOrEqual(10_000);
        expect(durationMs).toBeLessThanOrEqual(13_000);
      } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
      }
    }, 45_000);

    it('пустой список чанков → ошибка', async () => {
      await expect(svc.concatChunksToOgg([])).rejects.toThrow(/empty chunk/);
    });

    it('cleanup tmp-папки происходит даже при ошибке внутри callback', async () => {
      const tmp = await fsp.mkdtemp(join(os.tmpdir(), 'ffmpeg-spec-'));
      const c0 = join(tmp, 'c0.webm');
      try {
        await genWebm(c0, 1);
        // Перехватываем имя tmp-папки сервиса через mkdtemp-spy
        const created: string[] = [];
        const origMkdtemp = fsp.mkdtemp;
        jest.spyOn(fsp, 'mkdtemp').mockImplementation(async (prefix) => {
          const d = await origMkdtemp(prefix);
          created.push(d);
          return d;
        });
        try {
          await expect(
            svc.runWithOutput([c0], async () => {
              throw new Error('boom');
            }),
          ).rejects.toThrow(/boom/);
        } finally {
          (fsp.mkdtemp as jest.Mock).mockRestore?.();
          jest.restoreAllMocks();
        }
        const svcTmp = created.find((d) => d.includes('lecture-audio-'));
        expect(svcTmp).toBeDefined();
        await expect(fsp.stat(svcTmp!)).rejects.toThrow(); // удалена
      } finally {
        await fsp.rm(tmp, { recursive: true, force: true });
      }
    }, 30_000);
  });

  describe('очередь (concurrency)', () => {
    it('лимит concurrency=2: при 3 задачах одновременно работает не больше 2', async () => {
      const queue = new TestQueue({ concurrency: 2 });
      let running = 0;
      let maxRunning = 0;
      const task = async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 30));
        running--;
      };
      await Promise.all([queue.add(task), queue.add(task), queue.add(task)]);
      expect(maxRunning).toBe(2);
    });

    it('queueSize отражает в-работе + в-ожидании', async () => {
      const local = makeSvc(2);
      const resolvers: Array<() => void> = [];
      const slow = () =>
        new Promise<void>((r) => {
          resolvers.push(r);
        });
      const q = (local as unknown as { queue: import('p-queue').default })
        .queue;
      // 2 запустятся (pending=2), 3-я встанет в ожидание (size=1).
      const p1 = q.add(slow);
      const p2 = q.add(slow);
      const p3 = q.add(() => Promise.resolve());
      await new Promise((r) => setImmediate(r));
      expect(local.queueSize).toBeGreaterThanOrEqual(2);
      // Освобождаем обе медленные.
      resolvers.forEach((r) => r());
      await Promise.all([p1, p2, p3]);
    });
  });

  describe('parseDurationMs', () => {
    it('берёт последнее time=HH:MM:SS.MS', () => {
      const stderr =
        'frame=… time=00:00:00.50 bitrate=…\n' +
        'frame=… time=00:00:02.00 bitrate=…\n' +
        'frame=… time=01:02:03.456 bitrate=…\n';
      const v = (svc as unknown as {
        parseDurationMs(s: string): number;
      }).parseDurationMs(stderr);
      // 1h + 2m + 3.456s = 3723.456 → 3_723_456 ms
      expect(v).toBe(3_723_456);
    });

    it('нет time= → 0', () => {
      const v = (svc as unknown as {
        parseDurationMs(s: string): number;
      }).parseDurationMs('no progress here');
      expect(v).toBe(0);
    });
  });
});
