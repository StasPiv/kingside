/**
 * Упаковка партий плей-офф раунда в пары + этап сетки + счёт матча
 * (KS-1813). Вызывается после обновления партий раунда, когда уже
 * известен `tournamentType === 'playoff'`.
 *
 * Интерфейс:
 *   - `bracketStage` — этап сетки. Определяется по названию раунда:
 *     finals / semifinals / quarterfinals / round of N / winners|losers +
 *     этап. Если ничего не распозналось — `'playoff'` (общий fallback).
 *   - `bracketPairId` — стабильный id пары, формат
 *     `<bracketStage>:<playerA>|<playerB>` (имена нормализованы и
 *     отсортированы через `pairKey`). Партии одного матча → один id.
 *   - `matchScore` — счёт по партиям в паре в порядке
 *     «первый-по-ключу : второй-по-ключу» с ½ для ничьих. Ничьи
 *     добавляют 0.5 обеим сторонам. Незавершённые партии (`result=null`
 *     или `'*'`) в счёт не идут. Формат: `'2-1'`, `'2½-1½'`, `'0-0'`.
 *
 * Чистая функция — без БД, легко покрывается unit-тестами.
 */

import { pairKey } from './detect-round-tournament-type';

export interface ClassifyGameInput {
  id: string;
  whitePlayer: string | null;
  blackPlayer: string | null;
  /** Стандартный PGN result: '1-0' | '0-1' | '1/2-1/2' | '*' | null. */
  result: string | null;
}

export interface ClassifyGameOutput {
  /** Идёт обратно в `BroadcastGame.bracket_stage`. */
  bracketStage: string;
  /** Идёт обратно в `BroadcastGame.bracket_pair_id`. */
  bracketPairId: string;
  /** Идёт обратно в `BroadcastGame.match_score`. */
  matchScore: string;
}

/**
 * Расшифровка этапа по названию раунда. Возвращает нормализованный
 * ключ (snake_case). Порядок правил важен: `round of N` и `grand final`
 * ловим первыми, иначе их «съест» обычный `final`.
 */
export function parseBracketStage(roundName: string): string {
  const name = (roundName ?? '').trim();
  if (!name) return 'playoff';

  // Winners / Losers bracket — префикс, за которым идёт этап.
  const sideMatch = name.match(/\b(winners?|losers?)\b/i);
  const side = sideMatch ? (sideMatch[1].toLowerCase().startsWith('w') ? 'winners' : 'losers') : null;

  const stage = detectStageKeyword(name);

  if (side && stage) return `${side}_${stage}`;
  if (side) return side; // «Winners Bracket» без явного этапа
  return stage ?? 'playoff';
}

function detectStageKeyword(name: string): string | null {
  const roundOf = name.match(/\bround\s+of\s+(\d+)\b/i);
  if (roundOf) return `round_of_${roundOf[1]}`;

  // Chess.com-стайл `R16`, `R32`, `R8` — синоним «Round of N». Матч на
  // границе слова, case-sensitive (в именах всегда заглавная R).
  const shortRound = name.match(/(?:^|[\s(|/-])R(\d{1,3})(?=[\s)|/-]|$)/);
  if (shortRound) return `round_of_${shortRound[1]}`;

  if (/\bgrand\s+final(?:s)?\b/i.test(name)) return 'grand_final';
  if (/\bsemi[- ]?final(?:s)?\b/i.test(name) || /\bSF\b/.test(name)) return 'semi';
  if (/\bquarter[- ]?final(?:s)?\b/i.test(name) || /\bQF\b/.test(name)) return 'quarter';
  // «Final» оставляем на конец, чтобы не перекрывать «semifinal» и др.
  if (/\bfinal(?:s)?\b/i.test(name) || /(?:^|\s)F(?:\s|$)/.test(name)) return 'final';
  if (/\bchampionship\b/i.test(name)) return 'final';
  return null;
}

/**
 * Классифицировать все партии раунда. Возвращает map `gameId -> output`.
 * Для незавершённых матчей (partий пары ещё нет полного счёта) счёт
 * отражает текущее положение.
 */
export function classifyBrackets(
  roundName: string,
  games: ClassifyGameInput[],
): Map<string, ClassifyGameOutput> {
  const stage = parseBracketStage(roundName);
  const byPair = groupByPair(games);
  const out = new Map<string, ClassifyGameOutput>();

  for (const [pairId, pairGames] of byPair) {
    const score = computeMatchScore(pairId, pairGames);
    for (const g of pairGames) {
      const bracketPairId = pairId ? `${stage}:${pairId}` : '';
      out.set(g.id, {
        bracketStage: stage,
        bracketPairId,
        matchScore: score,
      });
    }
  }
  return out;
}

function groupByPair(
  games: ClassifyGameInput[],
): Map<string, ClassifyGameInput[]> {
  const out = new Map<string, ClassifyGameInput[]>();
  for (const g of games) {
    const key = pairKey(g.whitePlayer, g.blackPlayer);
    const list = out.get(key) ?? [];
    list.push(g);
    out.set(key, list);
  }
  return out;
}

/**
 * Посчитать счёт матча для пары. `pairId` — канонический ключ
 * `playerA|playerB` (имена отсортированы). Счёт формируется как
 * «очки A - очки B», где за победу — 1, за ничью — 0.5.
 *
 * Формат: целые числа без суффикса ('2-1'), половинки — с `½`
 * ('2½-1½'). Незавершённые партии не считаются.
 */
export function computeMatchScore(
  pairId: string,
  games: ClassifyGameInput[],
): string {
  if (!pairId) return '0-0';
  const [playerA] = pairId.split('|');
  let scoreA = 0;
  let scoreB = 0;

  for (const g of games) {
    const result = g.result;
    if (!result || result === '*') continue;
    const whiteIsA = normalizeEq(g.whitePlayer, playerA);
    if (result === '1-0') {
      if (whiteIsA) scoreA += 1;
      else scoreB += 1;
    } else if (result === '0-1') {
      if (whiteIsA) scoreB += 1;
      else scoreA += 1;
    } else if (result === '1/2-1/2' || result === '½-½') {
      scoreA += 0.5;
      scoreB += 0.5;
    }
  }

  return `${formatScorePart(scoreA)}-${formatScorePart(scoreB)}`;
}

function normalizeEq(name: string | null, canonical: string): boolean {
  return (name ?? '').trim().toLowerCase() === canonical;
}

function formatScorePart(value: number): string {
  // Преобразуем 2.5 → '2½', 2 → '2', 0.5 → '½'.
  const whole = Math.floor(value);
  const frac = value - whole;
  if (Math.abs(frac - 0.5) < 1e-9) {
    return whole === 0 ? '½' : `${whole}½`;
  }
  return String(whole);
}
