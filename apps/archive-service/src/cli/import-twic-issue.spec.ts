import {
  LockTimeoutError,
  parseArgs,
  runImportTwicIssue,
  type ImportTwicIssueDeps,
} from './import-twic-issue';
import type { ImportResult } from '../archive-import/sources/twic.importer';

describe('import-twic-issue parseArgs', () => {
  it('парсит позиционный номер выпуска: ["1639"] → { issue: 1639 }', () => {
    expect(parseArgs(['1639'])).toEqual({ issue: 1639 });
  });

  it('без аргументов → бросает с usage-текстом', () => {
    expect(() => parseArgs([])).toThrow(/Usage: import-twic-issue <issue>/);
  });

  it('нечисловой аргумент → ошибка', () => {
    expect(() => parseArgs(['abc'])).toThrow(/Invalid issue number/);
  });

  it('0 → ошибка (позитивное целое)', () => {
    expect(() => parseArgs(['0'])).toThrow(/Invalid issue number/);
  });

  it('отрицательное → ошибка', () => {
    expect(() => parseArgs(['-5'])).toThrow(/Invalid issue number/);
  });

  it('плавающее → ошибка (ожидается целое)', () => {
    expect(() => parseArgs(['1639.5'])).toThrow(/Invalid issue number/);
  });

  it('несколько позиционных → ошибка', () => {
    expect(() => parseArgs(['1639', '1638'])).toThrow(
      /Expected exactly one positional argument/,
    );
  });

  it('флаги `--foo` игнорируются (не считаются позиционными)', () => {
    expect(parseArgs(['--verbose', '1639'])).toEqual({ issue: 1639 });
  });
});

/**
 * Набор вспомогательных моков. Redis `set` возвращает 'OK' при успешном
 * взятии lock'а, `null` — если lock занят (`SET NX` reject).
 */
function makeDeps(
  overrides: Partial<ImportTwicIssueDeps> & {
    sourceRow?: { id: string; code: string; cursor: string | null } | null;
    importResult?: ImportResult;
    lockAcquired?: boolean;
    /** KS-1896: задаёт массив возвратов SET NX (для wait-and-acquire). */
    setReturns?: Array<'OK' | null>;
    /** KS-1896: возвращает GET для проверки holder'а. */
    getReturns?: Array<string | null>;
    /** KS-1898: возвращает значения EVAL (release/heartbeat); по умолчанию [1]. */
    evalReturns?: Array<number>;
  } = {},
): {
  deps: ImportTwicIssueDeps;
  spies: {
    runAdHoc: jest.Mock;
    publish: jest.Mock;
    set: jest.Mock;
    get: jest.Mock;
    eval: jest.Mock;
    del: jest.Mock;
    findFirst: jest.Mock;
    sleep: jest.Mock;
    setInterval: jest.Mock;
    clearInterval: jest.Mock;
  };
} {
  const source =
    overrides.sourceRow === undefined
      ? { id: 'source-uuid', code: 'twic', cursor: '1641' }
      : overrides.sourceRow;
  const defaultResult: ImportResult = overrides.importResult ?? {
    status: 'ok',
    cursorBefore: source?.cursor ?? null,
    cursorAfter: source?.cursor ?? null,
    fileName: 'twic1639.pgn',
    gamesParsed: 3000,
    gamesAdded: 42,
    gamesSkipped: 2958,
  };
  const runAdHoc = jest.fn().mockResolvedValue(defaultResult);
  const publish = jest.fn().mockResolvedValue(1);

  // KS-1896: SET может вернуть очередь значений (для wait-and-acquire);
  // если `setReturns` не задан — поведение совместимо со старым:
  // `lockAcquired=false` → null, иначе 'OK'.
  let setIdx = 0;
  const setQueue =
    overrides.setReturns ??
    [overrides.lockAcquired === false ? null : 'OK'];
  const set = jest.fn().mockImplementation(async () => {
    const i = Math.min(setIdx, setQueue.length - 1);
    setIdx++;
    return setQueue[i];
  });
  const get = jest.fn().mockImplementation(async () => {
    const list = overrides.getReturns ?? [];
    return list.shift() ?? null;
  });
  const del = jest.fn().mockResolvedValue(1);
  // KS-1898: EVAL мок (release/heartbeat). По умолчанию 1 — успех.
  let evalIdx = 0;
  const evalQueue = overrides.evalReturns ?? [1];
  const eval_ = jest.fn().mockImplementation(async () => {
    const i = Math.min(evalIdx, evalQueue.length - 1);
    evalIdx++;
    return evalQueue[i];
  });
  const findFirst = jest.fn().mockResolvedValue(source);
  // KS-1896: fake clock — sleep инкрементирует тиковое now(), чтобы
  // timeout-ветка детерминированно наступала. Без него настоящий
  // Date.now() с мокнутым в noop sleep даст бесконечный цикл.
  let fakeNow = 1_000_000;
  const sleep = jest.fn().mockImplementation(async (ms: number) => {
    fakeNow += ms;
  });
  const now = () => fakeNow;

  // KS-1898: fake таймеры heartbeat'а — interval не запустится в
  // реальном loop event'а, но handle всё равно создаётся, чтобы
  // release мог его «остановить».
  const intervals = new Map<number, () => void>();
  let nextIntervalId = 1;
  const setIntervalFn = jest.fn((cb: () => void, _ms: number) => {
    const id = nextIntervalId++;
    intervals.set(id, cb);
    return id;
  });
  const clearIntervalFn = jest.fn((h: unknown) => {
    intervals.delete(h as number);
  });

  const deps: ImportTwicIssueDeps = {
    prisma: {
      archiveSource: { findFirst },
    } as never,
    redis: { set, get, del, publish, eval: eval_ } as never,
    makeImporter: () => ({ runAdHoc }) as never,
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    lockWaitOpts: {
      waitTimeoutMs: 60_000,
      pollIntervalMs: 5_000,
      sleep,
      now,
    },
    lockHeartbeatOpts: {
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
    },
    ...overrides,
  };
  return {
    deps,
    spies: {
      runAdHoc,
      publish,
      set,
      get,
      eval: eval_,
      del,
      findFirst,
      sleep,
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
    },
  };
}

describe('runImportTwicIssue — happy path', () => {
  it('берёт lock, вызывает runAdHoc с issue, публикует событие, отпускает lock', async () => {
    const { deps, spies } = makeDeps();

    const res = await runImportTwicIssue(deps, { issue: 1639 });

    expect(res.status).toBe('ok');
    expect(res.gamesAdded).toBe(42);

    // Redis-lock: SET archive:import:lock:twic <token>:adhoc:<issue>:<pid> EX 60 NX.
    // KS-1896: issue в value для duplicate-self detection.
    // KS-1898: token (UUID) в начале для token-safe release; TTL 60с (короткий).
    expect(spies.set).toHaveBeenCalledWith(
      'archive:import:lock:twic',
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:adhoc:1639:\d+$/,
      ),
      'EX',
      60,
      'NX',
    );
    expect(spies.runAdHoc).toHaveBeenCalledWith(1639);
    expect(spies.publish).toHaveBeenCalledWith('archive:imported', 'twic:1639');
    // KS-1898: release теперь через EVAL Lua, не DEL.
    expect(spies.del).not.toHaveBeenCalled();
    expect(spies.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("DEL"'),
      1,
      'archive:import:lock:twic',
      expect.stringMatching(/:adhoc:1639:\d+$/),
    );
  });

  it('если games_added=0 (дубликат), PUBLISH НЕ вызывается', async () => {
    const { deps, spies } = makeDeps({
      importResult: {
        status: 'ok',
        cursorBefore: '1641',
        cursorAfter: '1641',
        fileName: 'twic1639.pgn',
        gamesParsed: 3000,
        gamesAdded: 0,
        gamesSkipped: 3000,
      },
    });

    const res = await runImportTwicIssue(deps, { issue: 1639 });

    expect(res.gamesAdded).toBe(0);
    expect(spies.publish).not.toHaveBeenCalled();
    // KS-1898: lock всё равно отпущен через EVAL (не DEL — token-safe release).
    expect(spies.del).not.toHaveBeenCalled();
    expect(spies.eval).toHaveBeenCalled();
  });

  // KS-1896: старое мгновенное падение теперь — timeout-ветка после
  // ожидания. Тест проверяет, что lock-loop отработал, а runAdHoc не
  // вызвался (lock так и не освободился за waitTimeoutMs).
  it('если Redis-lock занят и не освобождается → LockTimeoutError, runAdHoc НЕ вызван', async () => {
    const { deps, spies } = makeDeps({
      setReturns: [null],
      getReturns: ['scheduler:1700:scheduled'],
    });

    await expect(runImportTwicIssue(deps, { issue: 1639 })).rejects.toThrow(
      LockTimeoutError,
    );
    expect(spies.runAdHoc).not.toHaveBeenCalled();
    expect(spies.publish).not.toHaveBeenCalled();
    // del не вызван — локом владеет другой процесс, мы его не трогаем.
    expect(spies.del).not.toHaveBeenCalled();
    // sleep вызывался — wait-loop работал.
    expect(spies.sleep).toHaveBeenCalled();
  });

  it('если archive_sources.code="twic" не найден → бросает понятную ошибку', async () => {
    const { deps, spies } = makeDeps({ sourceRow: null });

    await expect(runImportTwicIssue(deps, { issue: 1639 })).rejects.toThrow(
      /archive_sources row with code="twic" not found/,
    );
    expect(spies.set).not.toHaveBeenCalled();
    expect(spies.runAdHoc).not.toHaveBeenCalled();
  });

  it('runAdHoc throw → lock отпускается (финально), ошибка пробрасывается', async () => {
    const { deps, spies } = makeDeps();
    (spies.runAdHoc as jest.Mock).mockRejectedValueOnce(new Error('boom'));

    await expect(runImportTwicIssue(deps, { issue: 1639 })).rejects.toThrow(
      /boom/,
    );
    // KS-1898: release через EVAL.
    expect(spies.eval).toHaveBeenCalled();
  });
});

// ─── KS-1896: wait-with-timeout ─────────────────────────────────────

describe('runImportTwicIssue — KS-1896 lock wait', () => {
  const ORIGINAL_ENV = process.env.ARCHIVE_IMPORTER_LOCK_NO_WAIT;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.ARCHIVE_IMPORTER_LOCK_NO_WAIT;
    } else {
      process.env.ARCHIVE_IMPORTER_LOCK_NO_WAIT = ORIGINAL_ENV;
    }
  });

  it('lock занят сначала, освободился через 2 попытки → берём, импорт идёт', async () => {
    const { deps, spies } = makeDeps({
      setReturns: [null, null, 'OK'],
      getReturns: [
        'tok:scheduler:-:1', // KS-1898 формат: <token>:<role>:<issue|->:<pid>
        'tok:scheduler:-:1',
      ],
    });

    const r = await runImportTwicIssue(deps, { issue: 1639 });

    expect(r.status).toBe('ok');
    // 3 SET-attempt'а: два null, один OK.
    expect(spies.set).toHaveBeenCalledTimes(3);
    // 2 sleep между неудачными попытками.
    expect(spies.sleep).toHaveBeenCalledTimes(2);
    expect(spies.runAdHoc).toHaveBeenCalledWith(1639);
    // Lock value: <uuid>:adhoc:1639:<pid>, TTL 60s (короткий, KS-1898).
    expect(spies.set).toHaveBeenCalledWith(
      'archive:import:lock:twic',
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:adhoc:1639:\d+$/,
      ),
      'EX',
      60,
      'NX',
    );
    // KS-1898: release через EVAL, не DEL.
    expect(spies.eval).toHaveBeenCalled();
  });

  it('тот же issue в lock-value (двойной запуск adhoc) → падает СРАЗУ, без wait', async () => {
    const { deps, spies } = makeDeps({
      setReturns: [null], // лок занят
      // KS-1898 формат: <token>:adhoc:1639:<pid>. Matcher из CLI:
      // `holder.includes(':adhoc:1639:')` → true.
      getReturns: ['othertok:adhoc:1639:11'],
    });

    await expect(runImportTwicIssue(deps, { issue: 1639 })).rejects.toThrow(
      /already held by another adhoc CLI for the same issue 1639/,
    );
    // Только 1 attempt, без sleep — duplicate-self срабатывает на первом GET.
    expect(spies.set).toHaveBeenCalledTimes(1);
    expect(spies.sleep).not.toHaveBeenCalled();
    expect(spies.runAdHoc).not.toHaveBeenCalled();
    // KS-1898: release не вызывается — мы lock не получали (SET вернул null).
    expect(spies.eval).not.toHaveBeenCalled();
    expect(spies.del).not.toHaveBeenCalled();
  });

  it('другой adhoc-issue в lock-value → НЕ duplicate-self, ждём', async () => {
    const { deps, spies } = makeDeps({
      setReturns: [null, 'OK'],
      // Lock держит adhoc, но другого выпуска (1640 != 1639) — это
      // законная race с другим оператором, надо ждать, не падать.
      // KS-1898 формат.
      getReturns: ['othertok:adhoc:1640:22'],
    });

    await runImportTwicIssue(deps, { issue: 1639 });

    expect(spies.set).toHaveBeenCalledTimes(2);
    expect(spies.sleep).toHaveBeenCalledTimes(1);
    expect(spies.runAdHoc).toHaveBeenCalled();
  });

  it('timeout (lock не отпустили за waitTimeoutMs) → LockTimeoutError', async () => {
    const { deps, spies } = makeDeps({
      setReturns: [null], // никогда не отпустит
      getReturns: [
        'tok:scheduler:-:1',
        'tok:scheduler:-:1',
        'tok:scheduler:-:1',
        'tok:scheduler:-:1',
        'tok:scheduler:-:1',
        'tok:scheduler:-:1',
        'tok:scheduler:-:1',
        'tok:scheduler:-:1',
        'tok:scheduler:-:1',
        'tok:scheduler:-:1',
        'tok:scheduler:-:1',
        'tok:scheduler:-:1',
        'tok:scheduler:-:1',
        'tok:scheduler:-:1',
      ],
    });

    await expect(runImportTwicIssue(deps, { issue: 1639 })).rejects.toThrow(
      LockTimeoutError,
    );
    expect(spies.runAdHoc).not.toHaveBeenCalled();
    // KS-1898: lock мы НЕ получили — release не зовём, чтобы случайно
    // не дёрнуть EVAL с нашим (несуществующим) токеном.
    expect(spies.eval).not.toHaveBeenCalled();
    expect(spies.del).not.toHaveBeenCalled();
  });

  it('ARCHIVE_IMPORTER_LOCK_NO_WAIT=1 → старое мгновенное падение, без wait', async () => {
    process.env.ARCHIVE_IMPORTER_LOCK_NO_WAIT = '1';
    const { deps, spies } = makeDeps({
      setReturns: [null],
      getReturns: ['tok:scheduler:-:1'],
    });

    await expect(runImportTwicIssue(deps, { issue: 1639 })).rejects.toThrow(
      /lock "archive:import:lock:twic" is held/,
    );
    // Один SET, sleep НЕ вызван.
    expect(spies.set).toHaveBeenCalledTimes(1);
    expect(spies.sleep).not.toHaveBeenCalled();
    expect(spies.runAdHoc).not.toHaveBeenCalled();
  });

  it('lock value формат: `<uuid>:adhoc:<issue>:<pid>` (KS-1898)', async () => {
    const { deps, spies } = makeDeps();
    await runImportTwicIssue(deps, { issue: 1639 });
    const setCall = spies.set.mock.calls[0];
    const value = setCall[1] as string;
    // UUID v4 + role + issue + pid.
    expect(value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:adhoc:1639:\d+$/,
    );
  });

  // KS-1898: heartbeat должен запуститься (для защиты от SIGKILL) и
  // остановиться при release (чтобы не тикать после успешного завершения).
  it('heartbeat запускается после захвата lock\'а и останавливается в release', async () => {
    const { deps, spies } = makeDeps();
    await runImportTwicIssue(deps, { issue: 1639 });

    // setInterval вызван ровно 1 раз — heartbeat взят.
    expect(spies.setInterval).toHaveBeenCalledTimes(1);
    expect(spies.setInterval).toHaveBeenCalledWith(expect.any(Function), 30_000);
    // clearInterval вызван — release остановил heartbeat.
    expect(spies.clearInterval).toHaveBeenCalledTimes(1);
  });

  // KS-1898: token-safe release. Если кто-то перехватил наш ключ
  // (наш TTL истёк, новый процесс получил), Lua вернёт 0 — мы не
  // сорвём чужой lock.
  it('release при перехвате (eval=0) → молча выходит без error', async () => {
    const { deps, spies } = makeDeps({ evalReturns: [0] });
    // Импорт идёт ОК; release просто отдаёт false (лог warn внутри).
    const r = await runImportTwicIssue(deps, { issue: 1639 });
    expect(r.status).toBe('ok');
    expect(spies.eval).toHaveBeenCalled();
  });
});
