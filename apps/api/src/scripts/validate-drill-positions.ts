/**
 * KS-2312 (KS-2246 follow-up). CLI-валидатор drill-позиций — прогоняет
 * JSON-файлы chess-expert'а через existing predicates (KS-2227),
 * возвращает отчёт о валидности позиций без записи в проект.
 *
 * Использование:
 *   npm run drill:validate -- <file.json> [<file2.json> ...] [--out=<path>]
 * или (без npm-обёртки):
 *   npx ts-node apps/api/src/scripts/validate-drill-positions.ts \
 *     /tmp/KS-2246/find-fork.json
 *
 * Контракт output (JSON-array, по одной записи на позицию):
 *   {
 *     "id": "ff-002",
 *     "drillType": "find-fork",
 *     "fen": "...",
 *     "valid": true | false,
 *     "reason": "<predicate verdict / mismatch / parse error>",
 *     "expectedAnswer": { ... } | null,   // что вернул predicate
 *     "authorAnswer":   { ... } | null,   // что заявил автор
 *     "matchesAnswer":  true | false      // совпадает ли с автором
 *   }
 *
 * Если файл — массив (`{positions: [...]}`-обёртка отсутствует), берём
 * массив напрямую. Если объект с `positions` — берём `positions`.
 *
 * Adapter: chess-expert использует `{shape, value}` (UCI-string для move,
 * массив для squares[], число для number, клетка для square).
 * Нормализуем в каноничный `AnswerData` из @kingside/shared перед
 * сравнением.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AnswerData, TacticDrillType } from '@kingside/shared';
import {
  countAttackers,
  findAllChecks,
  findCountAttackersCandidates,
  findFork,
  findHangingPiece,
  findLoosePiece,
  findPin,
  findUndefendedAttack,
} from '../tactic-drill/predicates';

interface AuthorAnswerRaw {
  shape?: string;
  value?: unknown;
  square?: string;
  squares?: string[];
  from?: string;
  to?: string;
  promotion?: 'q' | 'r' | 'b' | 'n';
}

interface AuthorPosition {
  id?: string;
  fen: string;
  answer?: AuthorAnswerRaw;
  context?: {
    highlightedSquare?: string;
    attackerColor?: 'white' | 'black' | 'w' | 'b';
  };
  difficulty?: number;
  notes?: string;
}

interface AuthorFile {
  drillType?: string;
  shape?: string;
  positions?: AuthorPosition[];
}

interface Verdict {
  id: string | null;
  drillType: string;
  fen: string;
  valid: boolean;
  reason: string | null;
  expectedAnswer: AnswerData | null;
  authorAnswer: AnswerData | null;
  matchesAnswer: boolean;
}

// KS-2393: исключён `mate-in-1 (deprecated)` (тип удалён).
const ALL_TYPES: ReadonlySet<string> = new Set([
  'find-hanging-piece',
  'find-loose-piece',
  'find-pin',
  'find-fork',
  'count-attackers',
  'find-all-checks',
  'find-undefended-attack',
]);

function parseArgs(argv: string[]): { files: string[]; out?: string } {
  const files: string[] = [];
  let out: string | undefined;
  for (const a of argv) {
    if (a.startsWith('--out=')) out = a.slice('--out='.length);
    else if (a.startsWith('--')) {
      throw new Error(`unknown option: ${a}`);
    } else {
      files.push(a);
    }
  }
  if (files.length === 0) {
    throw new Error('usage: validate-drill-positions <file.json> [...] [--out=<path>]');
  }
  return { files, out };
}

/**
 * Адаптер chess-expert answer-формата → канонический AnswerData.
 * chess-expert пишет `{shape, value}`, причём `shape` может быть
 * `"squares[]"` (с `[]`) и `value` принимает разные типы.
 */
function adaptAuthorAnswer(raw: AuthorAnswerRaw | undefined): AnswerData | null {
  if (!raw) return null;
  const shape = (raw.shape ?? '').replace(/\[\]$/, '');
  switch (shape) {
    case 'square': {
      const sq = raw.square ?? (typeof raw.value === 'string' ? raw.value : null);
      if (!sq) return null;
      return { shape: 'square', square: sq };
    }
    case 'squares': {
      const arr = raw.squares ?? (Array.isArray(raw.value) ? (raw.value as string[]) : null);
      if (!arr) return null;
      return { shape: 'squares', squares: arr };
    }
    case 'number': {
      const n = typeof raw.value === 'number' ? raw.value : null;
      if (n == null) return null;
      return { shape: 'number', value: n };
    }
    case 'move': {
      // chess-expert UCI-string в `value`, либо явные `from/to`.
      if (raw.from && raw.to) {
        const m: AnswerData = { shape: 'move', from: raw.from, to: raw.to };
        if (raw.promotion) m.promotion = raw.promotion;
        return m;
      }
      const uci = typeof raw.value === 'string' ? raw.value : null;
      if (!uci || uci.length < 4) return null;
      const m: AnswerData = {
        shape: 'move',
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
      };
      const promo = uci.slice(4, 5);
      if (promo === 'q' || promo === 'r' || promo === 'b' || promo === 'n') {
        m.promotion = promo;
      }
      return m;
    }
    default:
      return null;
  }
}

function answersEqual(a: AnswerData | null, b: AnswerData | null): boolean {
  if (!a || !b) return false;
  if (a.shape !== b.shape) return false;
  switch (a.shape) {
    case 'square':
      return a.square.toLowerCase() === (b as typeof a).square.toLowerCase();
    case 'number':
      return a.value === (b as typeof a).value;
    case 'move': {
      const m = b as typeof a;
      return a.from === m.from && a.to === m.to && (a.promotion ?? null) === (m.promotion ?? null);
    }
    case 'squares': {
      const setA = new Set(a.squares.map((s) => s.toLowerCase()));
      const setB = new Set((b as typeof a).squares.map((s) => s.toLowerCase()));
      if (setA.size !== setB.size) return false;
      for (const x of setA) if (!setB.has(x)) return false;
      return true;
    }
    default:
      return false;
  }
}

function colorOf(raw: 'white' | 'black' | 'w' | 'b' | undefined): 'w' | 'b' | null {
  if (!raw) return null;
  if (raw === 'white' || raw === 'w') return 'w';
  if (raw === 'black' || raw === 'b') return 'b';
  return null;
}

function runPredicate(
  drillType: TacticDrillType,
  pos: AuthorPosition,
):
  | { valid: true; answer: AnswerData }
  | { valid: false; reason: string; answer: AnswerData | null } {
  const fen = pos.fen;
  switch (drillType) {
    case 'find-hanging-piece': {
      const r = findHangingPiece(fen);
      return r.valid
        ? { valid: true, answer: r.answer }
        : { valid: false, reason: r.reason ?? 'invalid', answer: null };
    }
    case 'find-loose-piece': {
      const r = findLoosePiece(fen);
      return r.valid
        ? { valid: true, answer: r.answer }
        : { valid: false, reason: r.reason ?? 'invalid', answer: null };
    }
    case 'find-pin': {
      const r = findPin(fen);
      return r.valid
        ? { valid: true, answer: r.answer }
        : { valid: false, reason: r.reason ?? 'invalid', answer: null };
    }
    case 'find-fork': {
      const r = findFork(fen);
      return r.valid
        ? { valid: true, answer: r.answer }
        : { valid: false, reason: r.reason ?? 'invalid', answer: null };
    }
    // KS-2393: case `mate-in-1 (deprecated)` удалён.
    case 'find-all-checks': {
      const r = findAllChecks(fen);
      return r.valid
        ? { valid: true, answer: r.answer }
        : { valid: false, reason: r.reason ?? 'invalid', answer: null };
    }
    case 'find-undefended-attack': {
      const r = findUndefendedAttack(fen);
      return r.valid
        ? { valid: true, answer: r.answer }
        : { valid: false, reason: r.reason ?? 'invalid', answer: null };
    }
    case 'count-attackers': {
      // Для count-attackers используем context.highlightedSquare +
      // context.attackerColor. Если context отсутствует — пробуем
      // findCountAttackersCandidates и берём первый кандидат с
      // совпадающей to-клеткой author'а; иначе fail.
      const sq =
        pos.context?.highlightedSquare ??
        (typeof pos.answer?.value === 'string' ? null : null);
      const color = colorOf(pos.context?.attackerColor);
      if (!sq || !color) {
        return {
          valid: false,
          reason: 'count-attackers requires context.highlightedSquare + attackerColor',
          answer: null,
        };
      }
      const r = countAttackers(fen, sq as never, color);
      if (r.valid) return { valid: true, answer: r.answer };
      // Если не валиден из-за >4 / 0 — попробуем подсказать число
      // атакующих как expectedAnswer (даже если выходит за UI-диапазон).
      const cands = findCountAttackersCandidates(fen);
      const match = cands.find(
        (c) => c.targetSquare === sq && c.attackerColor === color,
      );
      return {
        valid: false,
        reason: r.reason ?? 'invalid',
        answer: match ? match.answer : null,
      };
    }
    default:
      return {
        valid: false,
        reason: `unknown drillType: ${drillType}`,
        answer: null,
      };
  }
}

function processFile(filePath: string): Verdict[] {
  const text = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(text) as AuthorFile | AuthorPosition[];
  let positions: AuthorPosition[];
  let fileType: string | undefined;
  if (Array.isArray(parsed)) {
    positions = parsed;
  } else {
    positions = parsed.positions ?? [];
    fileType = parsed.drillType;
  }

  const out: Verdict[] = [];
  for (const pos of positions) {
    const drillType = (fileType ?? '') as TacticDrillType;
    if (!ALL_TYPES.has(drillType)) {
      out.push({
        id: pos.id ?? null,
        drillType: fileType ?? 'unknown',
        fen: pos.fen,
        valid: false,
        reason: `unknown or missing drillType in file: ${fileType ?? 'none'}`,
        expectedAnswer: null,
        authorAnswer: adaptAuthorAnswer(pos.answer),
        matchesAnswer: false,
      });
      continue;
    }
    const author = adaptAuthorAnswer(pos.answer);
    const verdict = runPredicate(drillType, pos);
    if (verdict.valid) {
      out.push({
        id: pos.id ?? null,
        drillType,
        fen: pos.fen,
        valid: true,
        reason: null,
        expectedAnswer: verdict.answer,
        authorAnswer: author,
        matchesAnswer: answersEqual(verdict.answer, author),
      });
    } else {
      out.push({
        id: pos.id ?? null,
        drillType,
        fen: pos.fen,
        valid: false,
        reason: verdict.reason,
        expectedAnswer: verdict.answer,
        authorAnswer: author,
        matchesAnswer: false,
      });
    }
  }
  return out;
}

function main(): void {
  const { files, out } = parseArgs(process.argv.slice(2));
  const all: { file: string; verdicts: Verdict[] }[] = [];
  for (const f of files) {
    const abs = path.resolve(f);
    try {
      const verdicts = processFile(abs);
      all.push({ file: abs, verdicts });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      all.push({
        file: abs,
        verdicts: [
          {
            id: null,
            drillType: 'unknown',
            fen: '',
            valid: false,
            reason: `parse error: ${msg}`,
            expectedAnswer: null,
            authorAnswer: null,
            matchesAnswer: false,
          },
        ],
      });
    }
  }

  // Если задан --out, пишем вложенный отчёт; иначе flat-массив в stdout.
  if (out) {
    fs.writeFileSync(out, JSON.stringify(all, null, 2), 'utf8');
    const flat: Verdict[] = all.flatMap((f) => f.verdicts);
    const summary = summarize(flat);
    process.stdout.write(
      `validation report: ${flat.length} positions, ` +
        `valid=${summary.valid}, mismatch=${summary.mismatch}, ` +
        `invalid=${summary.invalid}\n→ ${out}\n`,
    );
  } else {
    const flat: Verdict[] = all.flatMap((f) => f.verdicts);
    process.stdout.write(JSON.stringify(flat, null, 2));
    process.stdout.write('\n');
  }
}

function summarize(verdicts: Verdict[]) {
  let valid = 0;
  let mismatch = 0;
  let invalid = 0;
  for (const v of verdicts) {
    if (!v.valid) invalid++;
    else if (!v.matchesAnswer) mismatch++;
    else valid++;
  }
  return { valid, mismatch, invalid };
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`✗ validate-drill-positions failed: ${msg}\n`);
    process.exit(1);
  }
}

export { processFile, adaptAuthorAnswer, answersEqual, summarize };
