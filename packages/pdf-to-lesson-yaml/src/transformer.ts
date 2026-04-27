/**
 * KS-2046 Этап 2 — трансформер AST → lesson YAML с поддержкой game_review.
 *
 * Базовый поток (Этап 1) — text-шаги с inline-диаграммами — сохранён;
 * добавлены два механизма распознавания партий:
 *
 *   1. **Single-block detection** — prose-блок целиком содержит ≥ 4
 *      long-algebraic полуходов; одной операцией становится game_review.
 *
 *   2. **Open-game accumulator** — ключевая часть Этапа 2.
 *      В Калиниченко 2016 партии разорваны на блоки PyMuPDF:
 *        - heading-блоки (bold-нотация ходов: «10. e4-e5 Bd6-c7 11. Bd3:h7+ …»);
 *        - prose-блоки между ними (комментарии «Это лучший ход…»).
 *      Чтобы собрать всю партию в один game_review, поддерживается
 *      состояние `openGame`:
 *        - heading-нотация (bold + 4+ ходов от текущей FEN) → продолжение;
 *        - prose-блок без ходов → comment к последнему добавленному ходу;
 *        - смена темы (диаграмма / heading-не-партия / heading L1) →
 *          закрыть openGame, эмитить game_review.
 *
 * FEN-нормализация: extractor отдаёт `<board> w - - 0 1`. Heuristic:
 *   - Стартовая позиция (полный комплект) → `KQkq`.
 *   - Иначе детектируем рокировки по позициям королей и ладей в
 *     начальных полях.
 */

import type {
  ConverterChapterConfig,
  PdfBlock,
  PdfDiagramBlock,
  PdfExtractResult,
  YamlGameReviewStep,
  YamlLessonFile,
  YamlStep,
  YamlTextStep,
} from './types.js';
import {
  attachProseToOpenGame,
  buildPgn,
  extendOpenGame,
  newOpenGame,
  tokenize,
  type OpenGame,
  type Token,
} from './notation.js';

interface StepBuilder {
  heading?: string;
  proseBlocks: string[];
  diagramFens: string[];
  diagramAt: number[];
}

const FRESH_STEP = (): StepBuilder => ({
  proseBlocks: [],
  diagramFens: [],
  diagramAt: [],
});

// ─── FEN castling-rights heuristic ────────────────────────────────────

const STARTPOS_BOARD = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

function normalizeFenCastling(fen: string): string {
  const parts = fen.split(/\s+/);
  const board = parts[0] ?? '';
  if (!board) return fen;
  if (board === STARTPOS_BOARD) {
    return `${board} w KQkq - 0 1`;
  }
  const rows = board.split('/');
  if (rows.length !== 8) return fen;
  const cells: string[][] = rows.map((row) => {
    const cs: string[] = [];
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let k = 0; k < Number(ch); k++) cs.push('.');
      } else {
        cs.push(ch);
      }
    }
    return cs;
  });
  const r8 = cells[0];
  const r1 = cells[7];
  let rights = '';
  if (r1[4] === 'K' && r1[7] === 'R') rights += 'K';
  if (r1[4] === 'K' && r1[0] === 'R') rights += 'Q';
  if (r8[4] === 'k' && r8[7] === 'r') rights += 'k';
  if (r8[4] === 'k' && r8[0] === 'r') rights += 'q';

  const stm = parts[1] ?? 'w';
  const ep = parts[3] ?? '-';
  const halfmove = parts[4] ?? '0';
  const fullmove = parts[5] ?? '1';
  const castlePart = rights || '-';
  return `${board} ${stm} ${castlePart} ${ep} ${halfmove} ${fullmove}`;
}

// ─── normalize prose ──────────────────────────────────────────────────

function normalizeProse(text: string): string {
  return text
    .replace(/-\n/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHeading(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildBodyMarkdown(s: StepBuilder): string {
  const lines: string[] = [];
  if (s.heading) {
    lines.push(`### ${s.heading}`);
    lines.push('');
  }
  for (let i = 0; i < s.proseBlocks.length; i++) {
    if (s.proseBlocks[i]) {
      lines.push(s.proseBlocks[i]);
      lines.push('');
    }
    for (let k = 0; k < s.diagramAt.length; k++) {
      if (s.diagramAt[k] === i) {
        lines.push(`{{diagram:${k}}}`);
        lines.push('');
      }
    }
  }
  for (let k = 0; k < s.diagramAt.length; k++) {
    if (s.diagramAt[k] === -1) {
      lines.unshift(`{{diagram:${k}}}`);
      lines.unshift('');
    }
  }
  return lines.join('\n').trim();
}

function builderToTextStep(s: StepBuilder): YamlTextStep | null {
  const body = buildBodyMarkdown(s);
  if (!body && s.diagramFens.length === 0) return null;
  const step: YamlTextStep = { type: 'text', bodyMarkdown: body };
  if (s.diagramFens.length > 0) {
    step.diagrams = s.diagramFens.map((fen) => ({ fen, orientation: 'white' }));
  }
  return step;
}

// ─── основной transformer ────────────────────────────────────────────

const MIN_MOVES_FOR_GAME = 4;

interface TransformContext {
  steps: YamlStep[];
  current: StepBuilder;
  /** Последняя встреченная диаграмма (для startFen game_review). */
  lastDiagramFen: string | null;
  /** Открытая партия (если идёт). */
  openGame: OpenGame | null;
  /** Минимум полуходов в openGame, чтобы её эмитировать как game_review;
   * иначе откатываем накопленное в text-шаги. */
  openGameMinMoves: number;
}

function makeContext(): TransformContext {
  return {
    steps: [],
    current: FRESH_STEP(),
    lastDiagramFen: null,
    openGame: null,
    openGameMinMoves: MIN_MOVES_FOR_GAME,
  };
}

function closeText(ctx: TransformContext): void {
  const step = builderToTextStep(ctx.current);
  if (step) ctx.steps.push(step);
  ctx.current = FRESH_STEP();
}

function closeOpenGame(ctx: TransformContext): void {
  if (!ctx.openGame) return;
  const og = ctx.openGame;
  ctx.openGame = null;
  if (og.moves.length < ctx.openGameMinMoves) {
    // Не наскребли на партию — откатываем содержимое в text-шаг
    // (мы не сохраняли raw блоков, поэтому используем PGN-style текст).
    const fallback: string[] = [];
    if (og.preComment) fallback.push(og.preComment);
    for (let i = 0; i < og.moves.length; i++) {
      fallback.push(`${Math.floor(i / 2) + 1}.${i % 2 === 0 ? '' : '..'} ${og.moves[i].san}`);
      if (og.moves[i].comment) fallback.push(og.moves[i].comment!);
    }
    if (og.postComment) fallback.push(og.postComment);
    if (fallback.length > 0) {
      ctx.current.proseBlocks.push(fallback.join(' '));
    }
    return;
  }
  closeText(ctx);
  const headers: Parameters<typeof buildPgn>[1] = {};
  if (og.startFen) headers.FEN = og.startFen;
  const pgn = buildPgn(
    {
      moves: og.moves,
      preComment: og.preComment,
      postComment: og.postComment,
      startFen: og.startFen,
    },
    headers,
  );
  const step: YamlGameReviewStep = { type: 'game_review', pgn };
  ctx.steps.push(step);
}

/**
 * Попытка скормить prose-блок как продолжение или начало openGame.
 * Возвращает true, если блок был принят (полностью или как prose-комментарий).
 */
function feedBlockToGame(ctx: TransformContext, prose: string): boolean {
  const tokens = tokenize(prose);
  const moveCount = tokens.filter((t: Token) => t.kind === 'move').length;

  // Если openGame уже идёт:
  if (ctx.openGame) {
    if (moveCount === 0) {
      // Чистый комментарий — добавляем к последнему ходу.
      attachProseToOpenGame(ctx.openGame, prose);
      return true;
    }
    // Пытаемся продолжить с текущей позиции.
    const ext = extendOpenGame(ctx.openGame, tokens);
    if (ext.ok) return true;
    // Не легализовалось — закрываем текущую игру, начнём новую.
    closeOpenGame(ctx);
  }

  // openGame нет / закрыли: пробуем открыть новую.
  if (moveCount < MIN_MOVES_FOR_GAME) return false;
  const startFen = ctx.lastDiagramFen
    ? normalizeFenCastling(ctx.lastDiagramFen)
    : undefined;
  const fresh = newOpenGame(startFen);
  if (!fresh) return false;
  const ext = extendOpenGame(fresh, tokens);
  if (!ext.ok) return false;
  ctx.openGame = fresh;
  // Перед открытием игры — закрываем текущий text-шаг с накопленной прозой
  // (но НЕ эмитим её как заголовок: те ходы, которые уже в openGame,
  // вырастут в game_review при closeOpenGame).
  return true;
}

export function transformAstToSteps(
  ast: PdfExtractResult,
  chapter: ConverterChapterConfig,
): YamlStep[] {
  const ctx = makeContext();

  for (const block of ast.blocks) {
    if (block.kind === 'heading') {
      // Heading-блок может оказаться нотацией партии (Калиниченко 2016
      // набирает таблицы ходов bold-шрифтом).
      const norm = normalizeProse(block.text);
      if (block.level >= 2 && feedBlockToGame(ctx, norm)) continue;

      // Не партия — закрываем openGame если был.
      closeOpenGame(ctx);

      if (block.level <= 1) continue;
      if (chapter.singleStep) {
        ctx.current.proseBlocks.push(`**${normalizeHeading(block.text)}**`);
        continue;
      }
      if (
        ctx.current.proseBlocks.length > 0 ||
        ctx.current.diagramFens.length > 0 ||
        ctx.current.heading
      ) {
        closeText(ctx);
      }
      ctx.current.heading = normalizeHeading(block.text);
      continue;
    }
    if (block.kind === 'diagram') {
      // Диаграмма всегда закрывает openGame: новая позиция = новый контекст.
      closeOpenGame(ctx);
      const diagramBlock = block as PdfDiagramBlock;
      ctx.lastDiagramFen = diagramBlock.fen_board + ' w - - 0 1';
      const localIdx = ctx.current.diagramFens.length;
      ctx.current.diagramFens.push(diagramBlock.fen);
      const after = ctx.current.proseBlocks.length - 1;
      ctx.current.diagramAt[localIdx] = after;
      continue;
    }
    if (block.kind === 'prose') {
      const norm = normalizeProse(block.text);
      if (feedBlockToGame(ctx, norm)) continue;
      // Не партия и не комментарий к открытой игре.
      closeOpenGame(ctx);
      ctx.current.proseBlocks.push(norm);
      continue;
    }
  }
  closeOpenGame(ctx);
  closeText(ctx);
  return ctx.steps;
}

export function buildLesson(
  ast: PdfExtractResult,
  chapter: ConverterChapterConfig,
  courseSlug: string,
): YamlLessonFile {
  const steps = transformAstToSteps(ast, chapter);
  if (steps.length === 0) {
    steps.push({
      type: 'text',
      bodyMarkdown: `// TODO: глава пуста после извлечения. Проверить page-range ${ast.pageRange[0]}–${ast.pageRange[1]} в PDF.`,
    });
  }
  const lesson: YamlLessonFile = {
    schemaVersion: 1,
    courseSlug,
    slug: chapter.slug,
    order: chapter.order,
    blockKey: chapter.blockKey,
    kind: chapter.kind,
    isPublished: chapter.isPublished ?? false,
    titleKey: chapter.titleKey,
    summaryKey: chapter.summaryKey,
    title: chapter.title,
    summary: chapter.summary,
    estMinutes: chapter.estMinutes,
    steps,
  };
  return lesson;
}
