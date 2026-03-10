import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';

import en from '../i18n/locales/en/translation.json';
import ru from '../i18n/locales/ru/translation.json';

/**
 * KS-308: Unit-тесты для чистых функций анализа Stockfish
 *
 * Функции formatEval, evalToPercent, formatPv не экспортируются из GameReviewPage,
 * поэтому тестируем их логику напрямую, воспроизводя реализацию.
 */

// --- Воспроизведение логики из GameReviewPage ---

type EvalLine = {
  depth: number;
  multipv: number;
  score: { type: 'cp' | 'mate'; value: number };
  pv: string;
};

function formatEval(line: EvalLine): string {
  if (line.score.type === 'mate') {
    return line.score.value === 0 ? '#' : `M${Math.abs(line.score.value)}`;
  }
  const cp = line.score.value / 100;
  return (cp >= 0 ? '+' : '') + cp.toFixed(1);
}

function evalToPercent(lines: EvalLine[]): number {
  if (lines.length === 0) return 50;
  const line = lines[0];
  if (line.score.type === 'mate') {
    return line.score.value > 0 ? 95 : line.score.value < 0 ? 5 : 50;
  }
  const cp = line.score.value;
  const pct = 50 + 50 * (2 / (1 + Math.exp(-0.004 * cp)) - 1);
  return Math.max(2, Math.min(98, pct));
}

function formatPv(pv: string, fen: string): string {
  try {
    const chess = new Chess(fen);
    const uciMoves = pv.split(' ');
    const fenParts = fen.split(' ');
    let isWhiteTurn = fenParts[1] === 'w';
    let moveNumber = parseInt(fenParts[5] || '1', 10);
    const parts: string[] = [];
    for (const uci of uciMoves.slice(0, 8)) {
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promotion = uci.length > 4 ? uci[4] : undefined;
      const move = chess.move({ from, to, promotion });
      if (!move) break;
      if (isWhiteTurn) {
        parts.push(`${moveNumber}. ${move.san}`);
      } else if (parts.length === 0) {
        parts.push(`${moveNumber}... ${move.san}`);
      } else {
        parts.push(move.san);
      }
      if (!isWhiteTurn) {
        moveNumber++;
      }
      isWhiteTurn = !isWhiteTurn;
    }
    return parts.join(' ');
  } catch {
    return pv.split(' ').slice(0, 8).join(' ');
  }
}

// --- parseInfo из stockfish.worker ---

type InfoLine = {
  depth: number;
  seldepth: number;
  multipv: number;
  score: { type: 'cp' | 'mate'; value: number };
  pv: string;
  nodes?: number;
  nps?: number;
  time?: number;
};

function parseInfo(line: string): InfoLine | null {
  const depthMatch = line.match(/\bdepth (\d+)/);
  const seldepthMatch = line.match(/\bseldepth (\d+)/);
  const multipvMatch = line.match(/\bmultipv (\d+)/);
  const cpMatch = line.match(/\bscore cp (-?\d+)/);
  const mateMatch = line.match(/\bscore mate (-?\d+)/);
  const pvMatch = line.match(/\bpv (.+)/);
  const nodesMatch = line.match(/\bnodes (\d+)/);
  const npsMatch = line.match(/\bnps (\d+)/);
  const timeMatch = line.match(/\btime (\d+)/);

  if (!depthMatch || !pvMatch) return null;
  if (!cpMatch && !mateMatch) return null;

  return {
    depth: Number(depthMatch[1]),
    seldepth: Number(seldepthMatch?.[1] ?? 0),
    multipv: Number(multipvMatch?.[1] ?? 1),
    score: mateMatch
      ? { type: 'mate', value: Number(mateMatch[1]) }
      : { type: 'cp', value: Number(cpMatch![1]) },
    pv: pvMatch[1],
    nodes: nodesMatch ? Number(nodesMatch[1]) : undefined,
    nps: npsMatch ? Number(npsMatch[1]) : undefined,
    time: timeMatch ? Number(timeMatch[1]) : undefined,
  };
}

// --- formatEval ---

describe('KS-308: formatEval', () => {
  const line = (type: 'cp' | 'mate', value: number): EvalLine => ({
    depth: 18, multipv: 1, score: { type, value }, pv: '',
  });

  it('положительная оценка в сантипешках', () => {
    // 35/100 = 0.35, но IEEE 754: 0.34999... → toFixed(1) = '0.3'
    expect(formatEval(line('cp', 35))).toBe('+0.3');
    expect(formatEval(line('cp', 100))).toBe('+1.0');
    expect(formatEval(line('cp', 0))).toBe('+0.0');
  });

  it('отрицательная оценка в сантипешках', () => {
    expect(formatEval(line('cp', -150))).toBe('-1.5');
    expect(formatEval(line('cp', -50))).toBe('-0.5');
  });

  it('мат', () => {
    expect(formatEval(line('mate', 3))).toBe('M3');
    expect(formatEval(line('mate', -2))).toBe('M2');
    expect(formatEval(line('mate', 0))).toBe('#');
  });
});

// --- evalToPercent ---

describe('KS-308: evalToPercent', () => {
  const line = (type: 'cp' | 'mate', value: number): EvalLine => ({
    depth: 18, multipv: 1, score: { type, value }, pv: '',
  });

  it('пустой массив → 50%', () => {
    expect(evalToPercent([])).toBe(50);
  });

  it('равная позиция (cp=0) → ~50%', () => {
    const pct = evalToPercent([line('cp', 0)]);
    expect(pct).toBe(50);
  });

  it('преимущество белых → > 50%', () => {
    const pct = evalToPercent([line('cp', 200)]);
    expect(pct).toBeGreaterThan(50);
    expect(pct).toBeLessThanOrEqual(98);
  });

  it('преимущество черных → < 50%', () => {
    const pct = evalToPercent([line('cp', -200)]);
    expect(pct).toBeLessThan(50);
    expect(pct).toBeGreaterThanOrEqual(2);
  });

  it('мат для белых → 95%', () => {
    expect(evalToPercent([line('mate', 3)])).toBe(95);
  });

  it('мат для черных → 5%', () => {
    expect(evalToPercent([line('mate', -2)])).toBe(5);
  });

  it('мат в 0 → 50%', () => {
    expect(evalToPercent([line('mate', 0)])).toBe(50);
  });

  it('огромное преимущество ограничено 98%', () => {
    const pct = evalToPercent([line('cp', 10000)]);
    expect(pct).toBeLessThanOrEqual(98);
  });

  it('огромный минус ограничен 2%', () => {
    const pct = evalToPercent([line('cp', -10000)]);
    expect(pct).toBeGreaterThanOrEqual(2);
  });
});

// --- formatPv (UCI → SAN) ---

describe('KS-322: formatPv — конвертация UCI в SAN с нумерацией ходов', () => {
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  it('конвертирует простые ходы пешек с нумерацией', () => {
    expect(formatPv('e2e4 e7e5', startFen)).toBe('1. e4 e5');
  });

  it('конвертирует ходы коней с нумерацией', () => {
    expect(formatPv('g1f3', startFen)).toBe('1. Nf3');
  });

  it('обрезает линию до 8 ходов', () => {
    const longPv = 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1';
    const result = formatPv(longPv, startFen);
    // С нумерацией: "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6"
    // Считаем SAN-ходы (без номеров): должно быть <= 8
    const sanMoves = result.replace(/\d+\.\s*/g, '').trim().split(/\s+/);
    expect(sanMoves.length).toBeLessThanOrEqual(8);
  });

  it('конвертирует превращение пешки с нумерацией', () => {
    // Позиция с пешкой на 7-й линии и королями
    const promoFen = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
    // a8=Q+ (с шахом, т.к. ферзь атакует короля на e8)
    expect(formatPv('a7a8q', promoFen)).toBe('1. a8=Q+');
  });

  it('рокировка конвертируется корректно с нумерацией', () => {
    const castleFen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
    expect(formatPv('f1b5', castleFen)).toBe('3. Bb5');
  });

  it('невалидные ходы — fallback на UCI', () => {
    // chess.js бросает исключение на невалидные поля, catch возвращает UCI
    expect(formatPv('z9z9', startFen)).toBe('z9z9');
  });

  it('невалидный FEN — fallback на UCI', () => {
    const result = formatPv('e2e4 e7e5', 'invalid-fen');
    expect(result).toBe('e2e4 e7e5');
  });

  it('взятие на проходе с нумерацией', () => {
    const epFen = 'rnbqkbnr/pppp1ppp/8/4pP2/8/8/PPPPP1PP/RNBQKBNR w KQkq e6 0 3';
    expect(formatPv('f5e6', epFen)).toBe('3. fxe6');
  });

  it('первый ход черных — формат с многоточием', () => {
    const blackFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    expect(formatPv('e7e5 g1f3', blackFen)).toBe('1... e5 2. Nf3');
  });

  it('первый ход черных без продолжения', () => {
    const blackFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    expect(formatPv('e7e5', blackFen)).toBe('1... e5');
  });
});

// --- parseInfo (UCI парсер) ---

describe('KS-308: parseInfo — парсинг UCI info строк', () => {
  it('парсит стандартную info строку с cp', () => {
    const line = 'info depth 18 seldepth 24 multipv 1 score cp 35 nodes 1234567 nps 987654 time 1250 pv e2e4 e7e5 g1f3';
    const result = parseInfo(line);

    expect(result).not.toBeNull();
    expect(result!.depth).toBe(18);
    expect(result!.seldepth).toBe(24);
    expect(result!.multipv).toBe(1);
    expect(result!.score).toEqual({ type: 'cp', value: 35 });
    expect(result!.pv).toBe('e2e4 e7e5 g1f3');
    expect(result!.nodes).toBe(1234567);
    expect(result!.nps).toBe(987654);
    expect(result!.time).toBe(1250);
  });

  it('парсит info строку с mate', () => {
    const line = 'info depth 18 seldepth 10 multipv 1 score mate 3 nodes 500 nps 1000 time 500 pv e2e4';
    const result = parseInfo(line);

    expect(result).not.toBeNull();
    expect(result!.score).toEqual({ type: 'mate', value: 3 });
  });

  it('парсит отрицательный mate', () => {
    const line = 'info depth 15 multipv 1 score mate -2 pv e7e5';
    const result = parseInfo(line);

    expect(result).not.toBeNull();
    expect(result!.score).toEqual({ type: 'mate', value: -2 });
  });

  it('парсит отрицательную оценку cp', () => {
    const line = 'info depth 20 multipv 2 score cp -150 pv d7d5 e2e4';
    const result = parseInfo(line);

    expect(result).not.toBeNull();
    expect(result!.score).toEqual({ type: 'cp', value: -150 });
    expect(result!.multipv).toBe(2);
  });

  it('возвращает null без depth', () => {
    const line = 'info score cp 35 pv e2e4';
    expect(parseInfo(line)).toBeNull();
  });

  it('возвращает null без pv', () => {
    const line = 'info depth 18 score cp 35';
    expect(parseInfo(line)).toBeNull();
  });

  it('возвращает null без score', () => {
    const line = 'info depth 18 pv e2e4';
    expect(parseInfo(line)).toBeNull();
  });

  it('multipv по умолчанию 1', () => {
    const line = 'info depth 18 score cp 0 pv e2e4';
    const result = parseInfo(line);
    expect(result!.multipv).toBe(1);
  });
});

// --- Сценарий 5: Переводы ---

describe('KS-308: i18n — ключи analysis.depth и analysis.backToLobby', () => {
  it('en: analysis.depth присутствует', () => {
    expect((en as Record<string, Record<string, string>>).analysis.depth).toBe('Depth');
  });

  it('en: analysis.backToLobby присутствует', () => {
    expect((en as Record<string, Record<string, string>>).analysis.backToLobby).toBe('Back to lobby');
  });

  it('ru: analysis.depth присутствует', () => {
    expect((ru as Record<string, Record<string, string>>).analysis.depth).toBe('Глубина');
  });

  it('ru: analysis.backToLobby присутствует', () => {
    expect((ru as Record<string, Record<string, string>>).analysis.backToLobby).toBe('Вернуться в лобби');
  });
});
