/**
 * KS-2250 (ADR-035 §11 / E6) — image-renderer для daily-drill.
 *
 * MVP реализация (Plan B): Playwright (chromium) рендерит HTML-template
 * с FEN-доской + overlay в PNG 1200×1200, кэш в local FS на 24ч.
 *
 * Plan A (S3+CloudFront) — после готовности KS-2316 (devops). При
 * переходе на S3 поменяется только метод хранения, public-контракт
 * (`imageUrl`) не меняется.
 *
 * Lazy-render: первый запрос на дату+locale — синхронный рендер (~1s),
 * следующие отдаются из FS-кэша. Cache TTL 24h — соответствует
 * Cache-Control: public, max-age=86400 на endpoint'е.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  DRILL_DIFFICULTY_LABEL,
  DRILL_TYPE_LABEL,
  type DailyTacticDrillResponse,
} from '@kingside/shared';
import type { Locale } from './daily-tactic-drill.service';

const CACHE_DIR = process.env.DAILY_DRILL_CACHE_DIR ?? '/tmp/kingside-daily-drills';
const IMAGE_SIZE = 1200;
/** TTL FS-кэша картинок. Telegram сам кэширует на ~24ч после первой загрузки. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class DailyTacticDrillImageService {
  private readonly logger = new Logger(DailyTacticDrillImageService.name);
  /**
   * Lazy-loaded Playwright module — не тянем chromium при старте API.
   * Браузер поднимается по требованию и переиспользуется (singleton).
   */
  private browserPromise: Promise<unknown> | null = null;

  /**
   * Получить картинку для (date, locale) — из кэша или рендером.
   * Возвращает абсолютный путь до PNG в local FS (для StreamableFile
   * в controller'е). 404 если данных недостаточно для рендера.
   */
  async getImagePath(
    response: DailyTacticDrillResponse,
    locale: Locale,
  ): Promise<string> {
    const filename = `daily-drill-${response.date}-${locale}.png`;
    const fullPath = path.join(CACHE_DIR, filename);

    // 1. Кэш-hit?
    const cached = await this.tryReadFresh(fullPath);
    if (cached) return fullPath;

    // 2. Рендер.
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const html = this.buildHtml(response, locale);
    try {
      await this.renderToPng(html, fullPath);
    } catch (e) {
      this.logger.error(
        `failed to render daily-drill image: ${(e as Error).message}`,
      );
      throw new NotFoundException({
        error: 'DAILY_DRILL_IMAGE_RENDER_FAILED',
        date: response.date,
        locale,
      });
    }
    return fullPath;
  }

  /**
   * Lazy-import + boot Playwright browser. Singleton: переиспользуем
   * один браузер на весь lifecycle сервиса. На staging/prod chromium
   * скачан в `~/.cache/ms-playwright`.
   */
  private async getBrowser(): Promise<{
    newPage(): Promise<{
      setViewportSize(s: { width: number; height: number }): Promise<void>;
      setContent(html: string, options?: { waitUntil?: string }): Promise<void>;
      screenshot(opts: {
        path: string;
        type?: 'png';
        fullPage?: boolean;
        clip?: { x: number; y: number; width: number; height: number };
      }): Promise<Buffer>;
      close(): Promise<void>;
    }>;
  }> {
    if (!this.browserPromise) {
      // Lazy require, чтобы chromium тянулся только при первом рендере.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const playwright = require('playwright') as {
        chromium: { launch(opts?: object): Promise<unknown> };
      };
      this.browserPromise = playwright.chromium.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    }
    return this.browserPromise as Promise<ReturnType<typeof this.getBrowser> extends Promise<infer T> ? T : never>;
  }

  /** Запустить screenshot HTML → PNG. */
  private async renderToPng(html: string, outPath: string): Promise<void> {
    const browser = (await this.getBrowser()) as {
      newPage(): Promise<{
        setViewportSize(s: { width: number; height: number }): Promise<void>;
        setContent(html: string, options?: { waitUntil?: string }): Promise<void>;
        screenshot(opts: { path: string; type?: 'png'; clip?: object }): Promise<Buffer>;
        close(): Promise<void>;
      }>;
    };
    const page = await browser.newPage();
    try {
      await page.setViewportSize({ width: IMAGE_SIZE, height: IMAGE_SIZE });
      await page.setContent(html, { waitUntil: 'load' });
      await page.screenshot({
        path: outPath,
        type: 'png',
        clip: { x: 0, y: 0, width: IMAGE_SIZE, height: IMAGE_SIZE },
      });
    } finally {
      await page.close();
    }
  }

  /** Читает кэш-файл если он свежий (< CACHE_TTL_MS). */
  private async tryReadFresh(p: string): Promise<boolean> {
    try {
      const stat = await fs.stat(p);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < CACHE_TTL_MS) return true;
      // Stale — удалим, чтобы пере-рендерить.
      await fs.unlink(p).catch(() => {});
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Сборка HTML-template для overlay по спеке `/tmp/KS-2250/overlay-spec.md`.
   * Doska — chess.js-like FEN render через CSS Grid + Unicode-фигуры.
   * Для MVP без подгрузки изображений фигур — Unicode (♔♕♖♗♘♙).
   */
  private buildHtml(r: DailyTacticDrillResponse, locale: Locale): string {
    const { drill, date, drillTypeLabel, difficulty, difficultyLabel } = r;
    const dots = difficulty === 'easy' ? '●○○' : difficulty === 'medium' ? '●●○' : '●●●';
    const dateLocalized = formatDate(date, locale);
    const sideLabel = formatSide(drill.sideToMove, locale);
    const sideIcon = drill.sideToMove === 'w' ? '⚪' : drill.sideToMove === 'b' ? '⚫' : '—';
    const board = renderBoardSvg(drill.fen, drill.context.highlight);

    return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${IMAGE_SIZE}px; height: ${IMAGE_SIZE}px; }
body {
  background: #1F2733;
  color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  display: grid;
  grid-template-rows: 120px 1fr 120px;
  padding: 0;
}
.header, .footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 32px;
}
.header .title { font-size: 36px; font-weight: 700; letter-spacing: 4px; }
.header .date { font-size: 24px; font-weight: 500; color: #A0A8B5; }
.header .brand { font-size: 20px; color: #A0A8B5; }
.footer .col { display: flex; flex-direction: column; gap: 8px; }
.footer .type { font-size: 32px; font-weight: 600; }
.footer .difficulty { font-size: 22px; color: #A0A8B5; }
.footer .difficulty .dots { color: #F5C518; font-weight: 700; font-size: 28px; margin-right: 12px; }
.footer .side { font-size: 22px; font-weight: 500; }
.footer .side-icon { font-size: 28px; margin-right: 8px; }
.board-wrap { display: flex; align-items: center; justify-content: center; }
.board-wrap svg { width: 960px; height: 960px; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="title">${locale === 'ru' ? 'DAILY DRILL' : 'DAILY DRILL'}</div>
      <div class="date">${escapeHtml(dateLocalized)}</div>
    </div>
    <div class="brand">kingside.app</div>
  </div>
  <div class="board-wrap">${board}</div>
  <div class="footer">
    <div class="col">
      <div class="type">${escapeHtml(drillTypeLabel[locale])}</div>
      <div class="difficulty"><span class="dots">${dots}</span>${escapeHtml(difficultyLabel[locale])}</div>
    </div>
    <div class="col" style="align-items: flex-end;">
      <div class="side"><span class="side-icon">${sideIcon}</span>${escapeHtml(sideLabel)}</div>
    </div>
  </div>
</body>
</html>`;
  }
}

// ─── HTML helpers ─────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MONTH_RU = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const MONTH_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function formatDate(iso: string, locale: 'ru' | 'en'): string {
  const [y, m, d] = iso.split('-').map((x) => Number.parseInt(x, 10));
  const monthIdx = m - 1;
  if (locale === 'ru') return `${d} ${MONTH_RU[monthIdx]} ${y}`;
  return `${MONTH_EN[monthIdx]} ${d}, ${y}`;
}

function formatSide(side: 'w' | 'b' | null, locale: 'ru' | 'en'): string {
  if (side === null) return '—';
  if (locale === 'ru') return side === 'w' ? 'Ход белых' : 'Ход чёрных';
  return side === 'w' ? 'White to move' : 'Black to move';
}

// ─── Board SVG renderer ──────────────────────────────────────────────

const PIECE_UNICODE: Record<string, string> = {
  K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
};

const BOARD_SIZE = 960;
const CELL = BOARD_SIZE / 8;
const LIGHT = '#EEEED2';
const DARK = '#769656';
const HIGHLIGHT = '#F5C518';

function renderBoardSvg(fen: string, highlight: string[]): string {
  const board = parseFen(fen);
  const highlightSet = new Set(highlight.map((s) => s.toLowerCase()));
  const cells: string[] = [];
  const labels: string[] = [];
  const pieces: string[] = [];

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const x = f * CELL;
      const y = r * CELL;
      const isLight = (r + f) % 2 === 0;
      const fill = isLight ? LIGHT : DARK;
      cells.push(
        `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" fill="${fill}"/>`,
      );

      const file = String.fromCharCode('a'.charCodeAt(0) + f);
      const rank = (8 - r).toString();
      const square = `${file}${rank}`;

      // Highlight overlay (4px рамка).
      if (highlightSet.has(square)) {
        cells.push(
          `<rect x="${x + 4}" y="${y + 4}" width="${CELL - 8}" height="${CELL - 8}" ` +
            `fill="${HIGHLIGHT}" fill-opacity="0.35" stroke="${HIGHLIGHT}" stroke-width="6"/>`,
        );
      }

      // Coordinates (только в углах: file на нижнем ranke, rank на левом).
      if (r === 7) {
        labels.push(
          `<text x="${x + CELL - 8}" y="${y + CELL - 8}" font-size="18" ` +
            `fill="${isLight ? DARK : LIGHT}" opacity="0.7" text-anchor="end">${file}</text>`,
        );
      }
      if (f === 0) {
        labels.push(
          `<text x="${x + 8}" y="${y + 22}" font-size="18" ` +
            `fill="${isLight ? DARK : LIGHT}" opacity="0.7">${rank}</text>`,
        );
      }

      // Piece.
      const piece = board[r][f];
      if (piece) {
        const symbol = PIECE_UNICODE[piece] ?? '';
        if (symbol) {
          pieces.push(
            `<text x="${x + CELL / 2}" y="${y + CELL / 2 + 28}" font-size="${CELL * 0.85}" ` +
              `text-anchor="middle" font-family="serif">${escapeHtml(symbol)}</text>`,
          );
        }
      }
    }
  }

  return (
    `<svg viewBox="0 0 ${BOARD_SIZE} ${BOARD_SIZE}" xmlns="http://www.w3.org/2000/svg">` +
    cells.join('') +
    pieces.join('') +
    labels.join('') +
    `</svg>`
  );
}

/** FEN → 8×8 array of piece-letter or empty. */
function parseFen(fen: string): (string | null)[][] {
  const rows = fen.split(' ')[0].split('/');
  const out: (string | null)[][] = [];
  for (const row of rows) {
    const arr: (string | null)[] = [];
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let i = 0; i < Number.parseInt(ch, 10); i++) arr.push(null);
      } else {
        arr.push(ch);
      }
    }
    while (arr.length < 8) arr.push(null);
    out.push(arr);
  }
  while (out.length < 8) out.push(Array(8).fill(null));
  return out;
}
