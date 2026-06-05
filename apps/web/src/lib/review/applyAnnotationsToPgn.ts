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

// KS-3619: position-eval NAG (PGN 10-19) рендерим в численной форме
// `$N` — chess.js/PGN-парсеры это понимают штатно, UI мапит обратно
// в символы (=, ⩲, ⩱, ±, ∓, +−, −+) на отображение.
const EVAL_NAG_CODES: ReadonlySet<number> = new Set([11, 14, 15, 16, 17, 18, 19]);

function nagSuffix(nags: readonly number[] | undefined): string {
  if (!nags || nags.length === 0) return '';
  // Берём первый NAG (по нашей логике их всегда 0 или 1).
  return NAG_SYMBOL[nags[0]] ?? '';
}

/**
 * Собирает текст одной side-variation. KS-3610: рекурсивно
 * расставляет вложенные `nestedVariations` после каждого SAN-хода.
 *
 * `startFen` — позиция перед первым ходом ветки (`v.uci`).
 */
function buildVariationText(
  startFen: string,
  v: AnnotationVariation,
): string {
  const ucis = [v.uci, ...(v.subline ?? [])];
  if (ucis.length === 0) return '';

  // Симулируем ходы по позиции, чтобы получить SAN'ы и FEN'ы перед
  // каждым полуходом ветки (нужно для рекурсии в nested-variations).
  const fenBefore: string[] = [];
  const sans: string[] = [];
  let cur = startFen;
  for (const uci of ucis) {
    fenBefore.push(cur);
    try {
      const b = new Chess(cur);
      const move = b.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
      if (!move) return '';
      sans.push(move.san);
      cur = b.fen();
    } catch {
      return '';
    }
  }

  // Сборка токенов с правильной нумерацией.
  const isWhiteToMove = startFen.split(' ')[1] === 'w';
  const fullMoveNumber = Number(startFen.split(' ')[5] ?? '1');

  const tokens: string[] = [];
  let whiteToPlay = isWhiteToMove;
  let curMoveNum = fullMoveNumber;
  for (let i = 0; i < sans.length; i++) {
    // Префикс номера хода.
    if (whiteToPlay) {
      tokens.push(`${curMoveNum}.`);
    } else if (i === 0) {
      tokens.push(`${curMoveNum}...`);
    }
    // SAN + (если первый ход) NAG-суффикс.
    const sanWithNag = i === 0 ? sans[i] + nagSuffix(v.nag) : sans[i];
    tokens.push(sanWithNag);
    // KS-3610: nested-variations после i-го полухода. Каждая —
    // отдельная скобка `(...)`, рекурсивно через тот же
    // `buildVariationText`. FEN ребёнка = `fenBefore[i]` (перед самим
    // ходом nested-вариант предлагает альтернативу).
    const nestedAtNode = v.nestedVariations?.[i] ?? [];
    for (const nested of nestedAtNode) {
      const inner = buildVariationText(fenBefore[i], nested);
      if (inner) tokens.push(`(${inner})`);
    }
    // Переход хода / нумерация.
    if (whiteToPlay) {
      whiteToPlay = false;
    } else {
      curMoveNum++;
      whiteToPlay = true;
    }
  }

  // KS-3619: position-eval NAG в самом конце ветки. Эмитим как `$N`
  // (PGN-стандарт): chess.js парсер штатно его сохраняет, при
  // ре-сериализации не теряется.
  if (v.finalEvalNag != null && EVAL_NAG_CODES.has(v.finalEvalNag)) {
    tokens.push(`$${v.finalEvalNag}`);
  }
  // Цвет — через PGN-комментарий `{[%cvc <color>]}`. Кладём в самый
  // конец, чтобы рендерить «контейнер» цвета на всю ветку.
  tokens.push(`{[%cvc ${v.color}]}`);
  return tokens.join(' ');
}

export interface ApplyAnnotationsOptions {
  /**
   * Если задана функция — будет вызвана при ошибке парсинга PGN.
   * По умолчанию — `console.warn`.
   */
  onError?: (err: Error) => void;
  /**
   * KS-3616. Маппинг `ply (1-based) → текст PGN-комментария к ходу
   * main-line`. Комментарий встраивается как `{...}` после SAN и
   * NAG-суффикса. Не применяется внутри variations.
   */
  commentByPly?: Readonly<Record<number, string>>;
}

/**
 * KS-3616 / KS-3705. Максимальная длина PGN-комментария к ходу. Если
 * LLM выдал больше — обрезаем + добавляем `...`.
 *
 * KS-3705: поднято с 200 до 5000. Прежнее значение 200 было защитой
 * на эпоху «коротких реплик ≤100 символов» из ADR-102. После перехода
 * на развёрнутые комментарии разбора партии модель стабильно отдаёт
 * 1300–1500 символов осмысленного текста, и обрезка резала фразу
 * на середине слова (см. отчёт пользователя в KS-3705). Бэкенд-агент
 * подтвердил: на стороне сервера обрезки нет, полная строка доходит
 * до фронтенда. 5000 — порог, на котором штатный комментарий не
 * режется, но защита от длинных markdown-деградаций сохраняется.
 */
export const PGN_COMMENT_MAX_LENGTH = 5000;

/**
 * KS-3616. Нормализация одного PGN-комментария:
 *   - заменяем `{` / `}` на скобки `(` / `)` (иначе PGN не парсится);
 *   - сжимаем переносы строк в пробелы;
 *   - усекаем до `PGN_COMMENT_MAX_LENGTH` с `...` в конце.
 */
function sanitizeComment(raw: string): string {
  const flattened = raw.replace(/[\r\n\t]+/g, ' ').trim();
  const noBraces = flattened.replace(/[{}]/g, ' ');
  const collapsed = noBraces.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= PGN_COMMENT_MAX_LENGTH) return collapsed;
  // Усечение «по-человечески» — на границе слова, если возможно.
  const cut = collapsed.slice(0, PGN_COMMENT_MAX_LENGTH - 3);
  const lastSpace = cut.lastIndexOf(' ');
  const head = lastSpace > 40 ? cut.slice(0, lastSpace) : cut;
  return `${head}...`;
}

/**
 * @returns новый PGN со встроенными NAG, variations и (опционально)
 * PGN-комментариями к main-line ходам. Если входной PGN не парсится —
 * возвращает исходный без изменений (defensive).
 *
 * `options.commentByPly` (KS-3616) — маппинг `ply (1-based) → текст
 *   комментария`. Комментарии встраиваются в `{...}` после SAN (и
 *   после NAG-суффикса). Применяются только к main-line.
 */
export function applyAnnotationsToPgn(
  pgn: string,
  annotations: readonly Annotation[],
  options: ApplyAnnotationsOptions = {},
): string {
  const commentByPly = options.commentByPly;
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

    // KS-3616: PGN-комментарий к main-line ходу (если задан). Кладём
    // после SAN+NAG и до variations — стандартная PGN-семантика
    // «комментарий к сыгранному ходу».
    const rawComment = commentByPly?.[ply];
    if (rawComment && rawComment.trim().length > 0) {
      const safe = sanitizeComment(rawComment);
      if (safe.length > 0) tokens.push(`{${safe}}`);
    }

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
