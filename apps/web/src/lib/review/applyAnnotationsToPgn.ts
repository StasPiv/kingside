/**
 * KS-3603 (ADR-100 §4). Утилита накладывает массив `Annotation` на
 * исходный PGN и выдаёт новый PGN: к нужным ходам приписывает символы
 * (`!`, `?`, `!!`, `??`, `?!`, `!?`) после SAN, а в дерево добавляет
 * side-variations (green «как надо было» и red «Maia-trap»).
 *
 * Реализация чистая, без зависимости от React/IndexedDB:
 *  1. парсим PGN через `chess.js` (он умеет SAN-движение по uci-ходам);
 *  2. итерируем по полуходам, для каждого собираем SAN сыгранного хода;
 *  3. для each annotation:
 *     - после SAN добавляем NAG-suffix (см. NAG_SYMBOL);
 *     - после хода добавляем `(<vSAN>{NAG_SYMBOL?} ... [%cvc <color>])`.
 *  4. сохраняем headers и шапку PGN.
 *
 * NB! Для MVP игнорируем существующие variations и комментарии в
 * исходном PGN: модель «дубль» подразумевает что исходник чист и
 * без аннотаций. Если в нём что-то есть — выкинется. Хедеры —
 * сохраняются.
 */
import { Chess } from 'chess.js';

import type { Annotation, AnnotationVariation } from './buildAnnotations';
import {
  NAG_BLUNDER,
  NAG_BRILLIANT,
  NAG_DUBIOUS,
  NAG_GOOD,
  NAG_INTERESTING,
  NAG_MISTAKE,
} from './buildAnnotations';

const NAG_SYMBOL: Record<number, string> = {
  [NAG_GOOD]: '!',
  [NAG_MISTAKE]: '?',
  [NAG_BRILLIANT]: '!!',
  [NAG_BLUNDER]: '??',
  [NAG_INTERESTING]: '!?',
  [NAG_DUBIOUS]: '?!',
};

function nagSuffix(nags: readonly number[] | undefined): string {
  if (!nags || nags.length === 0) return '';
  // Берём первый NAG (по нашей логике их всегда 0 или 1).
  return NAG_SYMBOL[nags[0]] ?? '';
}

/** Собирает строку side-variation. Глубина 1..3 ходов. */
function buildVariationText(
  startFen: string,
  v: AnnotationVariation,
): string {
  // Считаем номер хода и сторону для SAN.
  const tmp = new Chess(startFen);
  const isWhiteToMove = startFen.split(' ')[1] === 'w';
  const fullMoveNumber = Number(startFen.split(' ')[5] ?? '1');

  const moves: string[] = [];
  const ucis = [v.uci, ...(v.subline ?? [])];
  for (const uci of ucis) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    let san: string;
    try {
      const move = tmp.move({ from, to, promotion });
      if (!move) return '';
      san = move.san;
    } catch {
      return '';
    }
    moves.push(san);
  }

  // Формируем «1. e4 e5 …» с правильной нумерацией и многоточием для
  // вариаций, начинающихся с хода чёрных.
  let out = '';
  let movePtr = 0;
  let curMoveNum = fullMoveNumber;
  let whiteToPlay = isWhiteToMove;
  while (movePtr < moves.length) {
    if (whiteToPlay) {
      out += (out ? ' ' : '') + `${curMoveNum}. ${moves[movePtr]}`;
      movePtr++;
      whiteToPlay = false;
    } else {
      if (movePtr === 0) {
        // Чёрные на ходу первыми — добавляем «N…».
        out += `${curMoveNum}... ${moves[movePtr]}`;
      } else {
        out += ` ${moves[movePtr]}`;
      }
      movePtr++;
      curMoveNum++;
      whiteToPlay = true;
    }
  }

  // NAG на первый ход вариации (для red §4.2). Прикрепляем к первому SAN.
  if (v.nag && v.nag.length > 0) {
    // Заменим первый встретившийся SAN-токен (не «N.» / «N...»). Простой
    // подход: добавляем символ к первому SAN — он у нас второй токен
    // после «N.» или «N...».
    const tokens = out.split(' ');
    for (let i = 0; i < tokens.length; i++) {
      if (!/^\d+\.+/.test(tokens[i])) {
        tokens[i] = tokens[i] + nagSuffix(v.nag);
        break;
      }
    }
    out = tokens.join(' ');
  }

  // Цвет — через PGN-комментарий `{[%cvc green]}` (custom-variation-color).
  out += ` {[%cvc ${v.color}]}`;
  return out;
}

export interface ApplyAnnotationsOptions {
  /**
   * Если задана функция — будет вызвана при ошибке парсинга PGN.
   * По умолчанию — `console.warn`.
   */
  onError?: (err: Error) => void;
}

/**
 * @returns новый PGN со встроенными NAG и variations. Если входной PGN
 * не парсится — возвращает исходный без изменений (defensive).
 */
export function applyAnnotationsToPgn(
  pgn: string,
  annotations: readonly Annotation[],
  options: ApplyAnnotationsOptions = {},
): string {
  const byPly = new Map<number, Annotation>();
  for (const a of annotations) byPly.set(a.ply, a);

  const chess = new Chess();
  try {
    chess.loadPgn(pgn);
  } catch (err) {
    options.onError?.(err as Error);
    return pgn;
  }
  const headers = chess.header();
  const history = chess.history({ verbose: true });
  if (history.length === 0) return pgn;

  // Перепроигрываем чтобы получить FEN перед каждым ходом.
  const replay = new Chess();
  // Если в headers есть [SetUp "1"]+[FEN] — стартовая не дефолтная.
  const setupFen = headers.SetUp === '1' ? headers.FEN : undefined;
  if (setupFen) {
    try {
      replay.load(setupFen);
    } catch {
      // ignore — используем дефолт
    }
  }

  // Собираем main-line токены.
  const tokens: string[] = [];
  for (let i = 0; i < history.length; i++) {
    const move = history[i];
    const ply = i + 1; // 1-based
    const fenBefore = replay.fen();
    const isWhiteMove = fenBefore.split(' ')[1] === 'w';
    const fullMoveNumber = Number(fenBefore.split(' ')[5] ?? '1');

    // Префикс номера хода.
    if (isWhiteMove) {
      tokens.push(`${fullMoveNumber}.`);
    } else if (i === 0) {
      tokens.push(`${fullMoveNumber}...`);
    }

    const ann = byPly.get(ply);
    const suffix = ann ? nagSuffix(ann.nag) : '';
    tokens.push(move.san + suffix);

    // Variations — после SAN сыгранного хода.
    if (ann && ann.variations.length > 0) {
      for (const v of ann.variations) {
        const vText = buildVariationText(fenBefore, v);
        if (vText) tokens.push(`(${vText})`);
      }
    }

    // Применяем сам ход к replay.
    try {
      replay.move({
        from: move.from,
        to: move.to,
        promotion: move.promotion,
      });
    } catch {
      break;
    }
  }

  // Result в конце (если есть).
  const result = headers.Result ?? '*';
  tokens.push(result);

  // Собираем header-block. Пропускаем пустые/undefined значения —
  // chess.js (особенно с SetUp без FEN) иначе падает с «Invalid FEN»
  // при последующем loadPgn output'а.
  const headerLines: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    const str = String(v).trim();
    if (str.length === 0) continue;
    headerLines.push(`[${k} "${str.replace(/"/g, '\\"')}"]`);
  }

  const headerBlock = headerLines.join('\n');
  const moveBlock = tokens.join(' ');
  return headerLines.length > 0
    ? `${headerBlock}\n\n${moveBlock}\n`
    : `${moveBlock}\n`;
}
