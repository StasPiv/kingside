// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  parseLichessBroadcastPgn,
  useLichessPgnStream,
} from './useLichessPgnStream';

/**
 * KS-4856 / ADR-159 §2.2 + §2.4 + §3.2.
 *
 * Хук покрываем через мок `globalThis.fetch`. Feature-flag стабим через
 * `vi.stubEnv('VITE_BROADCAST_DIRECT_STREAM_ENABLED', 'true')`.
 */

const SAMPLE_PGN = `[Event "GCT Zagreb 2026"]
[Site "https://lichess.org/broadcast/gct-zagreb-2026/round-5"]
[Date "2026.07.07"]
[Round "5.1"]
[White "Carlsen, Magnus"]
[Black "Nakamura, Hikaru"]
[Result "*"]
[WhiteElo "2830"]
[BlackElo "2789"]
[GameURL "https://lichess.org/broadcast/gct-zagreb-2026/round-5/aaaaaaaa"]
[Variant "Standard"]

1. e4 { [%clk 1:29:55] } e5 { [%clk 1:29:50] } 2. Nf3 { [%clk 1:29:40] } *

[Event "GCT Zagreb 2026"]
[Site "https://lichess.org/broadcast/gct-zagreb-2026/round-5"]
[Date "2026.07.07"]
[Round "5.2"]
[White "Nepomniachtchi, Ian"]
[Black "Firouzja, Alireza"]
[Result "1-0"]
[WhiteElo "2795"]
[BlackElo "2762"]
[GameURL "https://lichess.org/broadcast/gct-zagreb-2026/round-5/bbbbbbbb"]
[Variant "Standard"]

1. d4 { [%clk 1:29:50] } Nf6 { [%clk 1:29:45] } 1-0`;

describe('parseLichessBroadcastPgn (KS-4856)', () => {
  it('парсит несколько партий из одного chunk\'а', () => {
    const games = parseLichessBroadcastPgn(SAMPLE_PGN);
    expect(games).toHaveLength(2);
    const [g1, g2] = games;
    expect(g1.whitePlayer).toBe('Carlsen, Magnus');
    expect(g1.blackPlayer).toBe('Nakamura, Hikaru');
    expect(g1.whiteElo).toBe(2830);
    expect(g1.blackElo).toBe(2789);
    expect(g1.lichessGameId).toBe('aaaaaaaa');
    // KS-4861: `id` (UUID БД) стрим не знает — намеренно пусто, пока
    // не сматчено с серверным snapshot'ом. Клик по такой карточке
    // блокируется в `handleGameClick` (см. проверку `!game.id`).
    expect(g1.id).toBe('');
    expect(g1.result).toBe('*');
    expect(g1.pgn).toContain('1. e4');
    expect(g1.currentFen).not.toBe(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );
    expect(g1.whiteClockMs).toBe((1 * 3600 + 29 * 60 + 40) * 1000);
    expect(g1.blackClockMs).toBe((1 * 3600 + 29 * 60 + 50) * 1000);
    expect(g1.clockUpdatedAt).not.toBeNull();
    expect(g2.result).toBe('1-0');
    expect(g2.lichessGameId).toBe('bbbbbbbb');
    expect(g2.id).toBe('');
  });

  it('возвращает пустой массив на пустой строке', () => {
    expect(parseLichessBroadcastPgn('')).toEqual([]);
    expect(parseLichessBroadcastPgn('   \n\n')).toEqual([]);
  });

  it('партия без ходов и часов → clocks=null, стартовая позиция', () => {
    const pgn = `[Event "X"]\n[White "Alpha"]\n[Black "Beta"]\n[Result "*"]\n[GameURL "https://lichess.org/broadcast/x/y/cccccccc"]\n\n*`;
    const [g] = parseLichessBroadcastPgn(pgn);
    expect(g.whiteClockMs).toBeNull();
    expect(g.blackClockMs).toBeNull();
    expect(g.clockUpdatedAt).toBeNull();
    expect(g.currentFen).toBe(
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    );
  });
});

describe('useLichessPgnStream (KS-4856)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_BROADCAST_DIRECT_STREAM_ENABLED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('флаг false → status=idle, fetch не вызывается', async () => {
    vi.stubEnv('VITE_BROADCAST_DIRECT_STREAM_ENABLED', 'false');
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const { result } = renderHook(() =>
      useLichessPgnStream({ lichessRoundId: 'rid1', enabled: true }),
    );
    await Promise.resolve();
    expect(result.current.status).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('enabled=false → status=idle', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const { result } = renderHook(() =>
      useLichessPgnStream({ lichessRoundId: 'rid1', enabled: false }),
    );
    await Promise.resolve();
    expect(result.current.status).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lichessRoundId=null → status=idle', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const { result } = renderHook(() =>
      useLichessPgnStream({ lichessRoundId: null, enabled: true }),
    );
    await Promise.resolve();
    expect(result.current.status).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('успешный chunk → status=streaming, games распарсились', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(SAMPLE_PGN + '\n\n\n'));
        // Не закрываем, чтобы reader висел на `read` без done.
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(stream, { status: 200 })),
    );
    const { result } = renderHook(() =>
      useLichessPgnStream({ lichessRoundId: 'rid1', enabled: true }),
    );

    await waitFor(() => expect(result.current.status).toBe('streaming'), {
      timeout: 3000,
    });
    expect(result.current.games).not.toBeNull();
    expect(result.current.games).toHaveLength(2);
    expect(result.current.failureCount).toBe(0);
  });

  it('HTTP 500 → failureCount растёт, error содержит код', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 500 })),
    );
    const { result } = renderHook(() =>
      useLichessPgnStream({ lichessRoundId: 'rid1', enabled: true }),
    );
    await waitFor(
      () => {
        expect(result.current.failureCount).toBeGreaterThanOrEqual(1);
      },
      { timeout: 1000 },
    );
    expect(result.current.error).toContain('500');
    expect(result.current.games).toBeNull();
  });

  it('смена lichessRoundId → новый fetch с новым URL', async () => {
    const encoder = new TextEncoder();
    const mkStream = () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(SAMPLE_PGN + '\n\n\n'));
        },
      });
    const fetchSpy = vi
      .fn()
      .mockImplementation(async () => new Response(mkStream(), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) =>
        useLichessPgnStream({ lichessRoundId: id, enabled: true }),
      { initialProps: { id: 'rid1' } },
    );
    await waitFor(() => expect(result.current.status).toBe('streaming'), {
      timeout: 3000,
    });
    rerender({ id: 'rid2' });
    await waitFor(
      () => {
        const url = fetchSpy.mock.calls.at(-1)?.[0] as string;
        expect(url).toContain('rid2');
      },
      { timeout: 3000 },
    );
  });
});
