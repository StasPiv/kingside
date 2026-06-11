/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * KS-4070 локальный сценарий. Прогоняет одну позицию (FEN) через ту же
 * сборку запроса, которую делает `PositionCommentService.comment`:
 *
 *  1. Запускает `tools/stockfish-trace/src/stockfish` (наш форк
 *     Stockfish 16 с командой `eval json`) и собирает массив подкомпонент
 *     в том же формате, что присылает клиентская часть.
 *  2. Запускает тот же бинарь в обычном режиме `go depth N`, забирает
 *     `score cp ...` и первую линию `pv` — это будет sf18_eval / sf18_pv.
 *  3. Собирает `systemPrompt` через `PositionCommentService.buildSystemPrompt`
 *     с теми же аргументами, что и сервис в продакшне (язык, usedIds,
 *     hasMetrics=false).
 *  4. Печатает в stdout: краткий состав факторов, finalный user-message
 *     (то самое тело, что улетает в webhook), а при наличии
 *     `ANTHROPIC_API_KEY` — обращается к Anthropic SDK и печатает ответ
 *     модели.
 *
 * Запуск:
 *   cd /project/apps/api
 *   npx ts-node src/scripts/test-position-comment.ts "<FEN>" [depth]
 */
import { spawn } from 'node:child_process';
import { ConfigService } from '@nestjs/config';
import { PositionCommentService } from '../position-comment/position-comment.service';

const STOCKFISH = '/project/tools/stockfish-trace/src/stockfish';

interface Subterm {
  id: string;
  color?: 'w' | 'b';
  square?: string;
  value_mg?: number;
  value_eg?: number;
}

interface TraceOutput {
  position: { fen: string; sideToMove: string };
  subterms: Subterm[];
  total: { mg: number; eg: number; v: number };
}

/**
 * KS-4070. Группировка `PositionalSubtermId` по 7 блокам метрик
 * (KS-4043 / KS-4049). Совпадает по составу с реализацией фронта;
 * локально нужна, чтобы воспроизвести payload, который реально уходит
 * в `POST /analyses/position/comment`. `psqt_*` сюда НЕ входят
 * (исторически не вошли в группы метрик). `space` отнесён к `pieces`.
 */
const METRIC_GROUPS: Record<
  keyof typeof METRIC_GROUP_KEYS,
  readonly string[]
> = {
  // По уточнению пользователя (KS-4070 ход 2026-06-11): `metrics.material`
  // на фронте — это PSQT-агрегат (вес фигур на занимаемых полях), а не
  // суммарный материал/имбаланс. Поэтому сюда идут только `psqt_*`.
  // Stockfish-trace эмитит psqt_*, фронт собирает их в группу.
  material: [
    'psqt_pawn',
    'psqt_knight',
    'psqt_bishop',
    'psqt_rook',
    'psqt_queen',
    'psqt_king',
  ],
  pawn_structure: [
    'pawn_doubled_early',
    'pawn_connected',
    'pawn_doubled',
    'pawn_isolated',
    'pawn_backward',
    'pawn_lever_double',
    'pawn_blocked',
  ],
  king_safety: [
    'king_shelter_strength',
    'king_blocked_storm',
    'king_unblocked_storm',
    'king_on_file',
    'king_safety_pawn',
    'king_danger',
    'king_safe_check_rook',
    'king_safe_check_queen',
    'king_safe_check_bishop',
    'king_safe_check_knight',
    'king_pawnless_flank',
    'king_flank_attacks',
    'king_attackers_count',
    'king_attackers_weight',
  ],
  pieces: [
    'rook_on_king_ring',
    'bishop_on_king_ring',
    'knight_uncontested_outpost',
    'outpost_knight',
    'outpost_bishop',
    'knight_reachable_outpost',
    'minor_behind_pawn',
    'knight_king_protector_distance',
    'bishop_king_protector_distance',
    'bishop_pawns',
    'bishop_xray_pawns',
    'bishop_long_diagonal',
    'bishop_cornered',
    'rook_on_open_file',
    'rook_on_closed_file',
    'rook_trapped',
    'queen_weak',
    'space',
  ],
  mobility: [
    'mobility_knight',
    'mobility_bishop',
    'mobility_rook',
    'mobility_queen',
  ],
  threats: [
    'threat_by_minor',
    'threat_by_rook',
    'threat_by_king',
    'threat_hanging',
    'threat_weak_queen_protection',
    'threat_restricted_piece',
    'threat_by_safe_pawn',
    'threat_by_pawn_push',
    'threat_knight_on_queen',
    'threat_slider_on_queen',
  ],
  passed_pawns: [
    'passed_rank',
    'passed_king_proximity',
    'passed_path_advance',
    'passed_file_edge',
  ],
};
const METRIC_GROUP_KEYS = {
  material: 1,
  pawn_structure: 1,
  king_safety: 1,
  pieces: 1,
  mobility: 1,
  threats: 1,
  passed_pawns: 1,
} as const;

/**
 * Соберёт metrics + phase в формате KS-4049 из массива subterms и
 * total из stockfish-trace. phase оценивается обратной формулой
 * tapered eval: `v = (mg·phase + eg·(256−phase))/256`, отсюда
 * `phase = 256·(v − eg)/(mg − eg)`, при `mg == eg` — берём 128.
 */
function buildMetrics(
  subterms: Subterm[],
  total: { mg: number; eg: number; v: number },
): { metrics: Record<string, { value_cp: number }>; phase: number } {
  let phase = 128;
  if (Math.abs(total.mg - total.eg) > 1e-9) {
    const p = (256 * (total.v - total.eg)) / (total.mg - total.eg);
    phase = Math.max(0, Math.min(256, Math.round(p)));
  }
  const idToGroup = new Map<string, keyof typeof METRIC_GROUP_KEYS>();
  for (const [group, ids] of Object.entries(METRIC_GROUPS) as Array<
    [keyof typeof METRIC_GROUP_KEYS, readonly string[]]
  >) {
    for (const id of ids) idToGroup.set(id, group);
  }
  const acc: Record<string, number> = {
    material: 0,
    pawn_structure: 0,
    king_safety: 0,
    pieces: 0,
    mobility: 0,
    threats: 0,
    passed_pawns: 0,
  };
  for (const s of subterms) {
    const g = idToGroup.get(s.id);
    if (!g) continue;
    const mg = s.value_mg ?? 0;
    const eg = s.value_eg ?? 0;
    const tapered = (mg * phase + eg * (256 - phase)) / 256;
    const sign = s.color === 'b' ? -1 : 1; // знак приводим к стороне белых
    acc[g] += sign * tapered;
  }
  const metrics: Record<string, { value_cp: number }> = {};
  for (const k of Object.keys(acc)) {
    metrics[k] = { value_cp: Number(acc[k].toFixed(4)) };
  }
  return { metrics, phase };
}

interface Sf18Eval {
  id: 'sf18_eval';
  score:
    | { type: 'cp'; value: number }
    | { type: 'mate'; value: number };
}

interface Sf18Pv {
  id: 'sf18_pv';
  moves: string[];
}

/**
 * Запускает Stockfish, отправляет `input` и ждёт первой строки,
 * соответствующей `waitFor` (regex). После — посылает `quit` и собирает
 * весь накопленный stdout. Если `waitFor` не задан — ждём закрытия
 * процесса (для коротких команд типа `eval json`).
 */
function runStockfish(
  input: string,
  opts: { timeoutMs?: number; waitFor?: RegExp } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  return new Promise((resolve, reject) => {
    const proc = spawn(STOCKFISH, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      try {
        proc.stdin.end();
      } catch {
        /* ignore */
      }
      proc.kill('SIGTERM');
      if (err) reject(err);
      else resolve(stdout);
    };
    const timer = setTimeout(
      () => finish(new Error(`stockfish timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
    proc.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (opts.waitFor && opts.waitFor.test(stdout)) {
        clearTimeout(timer);
        try {
          proc.stdin.write('quit\n');
        } catch {
          /* ignore */
        }
        // дайте процессу секунду на закрытие и собирайте остаток
        setTimeout(() => finish(), 200);
      }
    });
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (e) => {
      clearTimeout(timer);
      finish(e);
    });
    proc.on('close', () => {
      clearTimeout(timer);
      if (stderr.trim()) {
        process.stderr.write(`[stockfish stderr]\n${stderr}\n`);
      }
      finish();
    });
    proc.stdin.write(input);
    if (!opts.waitFor) proc.stdin.end();
  });
}

async function fetchTrace(fen: string): Promise<TraceOutput> {
  const cmd =
    `setoption name Use NNUE value false\n` +
    `position fen ${fen}\n` +
    `eval json\n` +
    `quit\n`;
  const out = await runStockfish(cmd);
  const start = out.indexOf('{"position"');
  if (start === -1) throw new Error('eval json: JSON not found in output');
  let end = out.length;
  while (end > start) {
    const chunk = out.slice(start, end).trim();
    try {
      const parsed = JSON.parse(chunk) as TraceOutput;
      if (Array.isArray(parsed.subterms)) return parsed;
    } catch {
      const brace = out.lastIndexOf('}', end - 1);
      if (brace === -1 || brace <= start) break;
      end = brace + 1;
      try {
        const parsed = JSON.parse(out.slice(start, end).trim()) as TraceOutput;
        if (Array.isArray(parsed.subterms)) return parsed;
      } catch {
        end--;
      }
    }
  }
  throw new Error('eval json: failed to parse JSON');
}

async function fetchSfEval(
  fen: string,
  depth: number,
): Promise<{ evalFactor: Sf18Eval; pvFactor: Sf18Pv }> {
  // Stockfish при stdin=pipe не выводит info для `go depth`, но
  // выводит для `go infinite`. Поэтому идём через infinite и стопаем,
  // как только увидели итерацию с нужной (или большей) глубиной.
  const cmd =
    `ucinewgame\n` +
    `position fen ${fen}\n` +
    `go infinite\n`;
  const depthAtLeast = new RegExp(
    `\\ninfo depth (?:${depth}|[2-9]\\d|1\\d{2,}) `,
  );
  // Дополнительно — после stop процесс печатает bestmove; используем
  // bestmove как сигнал окончания.
  const out = await runStockfish(cmd, {
    timeoutMs: 60000,
    waitFor: depthAtLeast,
  });
  // Берём ПОСЛЕДНЮЮ строку `info ... score ... pv ...` — это самая
  // глубокая итерация перед `bestmove`.
  const infoLines = out
    .split('\n')
    .filter((l) => l.startsWith('info ') && l.includes(' score '));
  if (infoLines.length === 0) throw new Error('go depth: no info line');
  const last = infoLines[infoLines.length - 1];
  // score cp <N> | score mate <N>
  const scoreM = last.match(/ score (cp|mate) (-?\d+)/);
  if (!scoreM) throw new Error('go depth: score not parsed');
  // Stockfish UCI отдаёт score со стороны на ходу. Наш контракт
  // `sf18_eval.score` — всегда со стороны белых (см. инструкцию
  // `position-comment.service.ts`: «знак всегда приходит со стороны
  // белых, независимо от того, чей ход»). Когда ход чёрных — знак
  // нужно инвертировать.
  const sideToMoveBlack = / b /.test(fen.replace(/^(\S+\s+)/, ' $1 '));
  const rawValue = parseInt(scoreM[2], 10);
  const valueFromWhite = sideToMoveBlack ? -rawValue : rawValue;
  const evalFactor: Sf18Eval = {
    id: 'sf18_eval',
    score:
      scoreM[1] === 'cp'
        ? { type: 'cp', value: valueFromWhite }
        : { type: 'mate', value: valueFromWhite },
  };
  const pvM = last.match(/ pv (.+?)(?:$|\s+(?:wdl|score|hashfull|tbhits)\s)/);
  const pvFactor: Sf18Pv = {
    id: 'sf18_pv',
    moves: pvM ? pvM[1].trim().split(/\s+/) : [],
  };
  return { evalFactor, pvFactor };
}

async function main() {
  const fen = process.argv[2];
  if (!fen) {
    console.error('usage: test-position-comment.ts "<FEN>" [depth=18]');
    process.exit(2);
  }
  const depth = parseInt(process.argv[3] || '18', 10);

  console.error(`> fetching subterms from stockfish-trace (eval json)...`);
  const trace = await fetchTrace(fen);
  const subterms = trace.subterms;

  console.error(`> fetching sf18_eval / sf18_pv at depth ${depth}...`);
  const { evalFactor, pvFactor } = await fetchSfEval(fen, depth);

  const factors = [
    evalFactor,
    pvFactor,
    ...subterms.map((s) => ({ ...s })), // оставляем как есть
  ];

  const { metrics, phase } = buildMetrics(subterms, trace.total);
  const evalSummary = {
    mg: Number(trace.total.mg.toFixed(4)),
    eg: Number(trace.total.eg.toFixed(4)),
    v: Number(trace.total.v.toFixed(4)),
  };

  // Сервис с реальными адресом + токеном webhook'а (берём из env;
  // если их там нет — service ничего не пошлёт и вернёт пустой ответ).
  const env: Record<string, string | undefined> = {
    AI_CHAT_WEBHOOK_URL: process.env.AI_CHAT_WEBHOOK_URL,
    WEBHOOK_AUTH_TOKEN: process.env.WEBHOOK_AUTH_TOKEN,
    AI_PROMPT_VARIANT: process.env.AI_PROMPT_VARIANT,
    POSITION_COMMENT_FETCH_TIMEOUT_MS:
      process.env.POSITION_COMMENT_FETCH_TIMEOUT_MS,
  };
  const config = {
    get: (key: string, fallback?: unknown) =>
      env[key] !== undefined ? env[key] : fallback,
  } as unknown as ConfigService;
  const redisStub = {
    get: async () => null,
    set: async () => undefined,
    pipeline: () => ({
      incr: () => undefined,
      expire: () => undefined,
      exec: async () => [],
    }),
  };
  const service = new PositionCommentService(config, redisStub as any);

  const usedIds = new Set<string>();
  for (const f of factors) {
    if (typeof (f as any).id === 'string' && (f as any).id !== 'sf18_pv') {
      usedIds.add((f as any).id);
    }
  }
  const systemPrompt = service.buildSystemPrompt('ru', usedIds, false);

  console.log('═══ FEN ════════════════════════════════════════════════════');
  console.log(fen);
  console.log('═══ SUBTERM IDS (used) ═════════════════════════════════════');
  console.log([...usedIds].sort().join(', '));
  console.log('═══ SF18 EVAL ══════════════════════════════════════════════');
  console.log(JSON.stringify(evalFactor));
  console.log('═══ SF18 PV ════════════════════════════════════════════════');
  console.log(JSON.stringify(pvFactor));
  console.log('═══ SYSTEM PROMPT (head 600) ═══════════════════════════════');
  console.log(systemPrompt.slice(0, 600) + '...');

  if (!env.AI_CHAT_WEBHOOK_URL) {
    console.log('═══ MODEL RESPONSE ═════════════════════════════════════════');
    console.log(
      '(AI_CHAT_WEBHOOK_URL не задан — обращение к модели пропущено. ' +
        'Установите переменную окружения и повторите.)',
    );
    return;
  }

  console.log('═══ METRICS (groups, value_cp в пешках) ════════════════════');
  console.log(JSON.stringify(metrics, null, 2));
  console.log(`phase=${phase}, eval=${JSON.stringify(evalSummary)}`);

  console.error('> calling AI_CHAT_WEBHOOK_URL...');
  const result = await service.comment('local-test', {
    fen,
    factors: factors as any,
    eval: evalSummary,
    metrics: metrics as any,
    phase,
    language: 'ru',
  } as any);
  console.log('═══ MODEL RESPONSE (parsed) ════════════════════════════════');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
