import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DgtService, DgtPlayer } from './dgt.service';

const mockPlayer = (fname: string, lname: string): DgtPlayer => ({
  fname,
  mname: null,
  lname,
  title: null,
  fideid: null,
});

describe('DgtService', () => {
  let service: DgtService;

  beforeEach(() => {
    service = new DgtService();
  });

  describe('extractUuid', () => {
    it('extracts UUID from full URL', () => {
      const url = 'https://view.livechesscloud.com/#10284f4b-f4b0-4b10-a7fb-3103d0b62128';
      expect(service.extractUuid(url)).toBe('10284f4b-f4b0-4b10-a7fb-3103d0b62128');
    });

    it('returns UUID as-is when passed directly', () => {
      const uuid = '10284f4b-f4b0-4b10-a7fb-3103d0b62128';
      expect(service.extractUuid(uuid)).toBe(uuid);
    });

    it('throws BadRequestException for invalid input', () => {
      expect(() => service.extractUuid('not-a-uuid')).toThrow(BadRequestException);
    });

    it('throws BadRequestException for empty string', () => {
      expect(() => service.extractUuid('')).toThrow(BadRequestException);
    });
  });

  describe('extractSanMoves', () => {
    it('strips clock info from moves', () => {
      const raw = ['e4 305+1', 'g6 304+2', 'd4 306+3'];
      expect(service.extractSanMoves(raw)).toEqual(['e4', 'g6', 'd4']);
    });

    it('handles moves without clock info', () => {
      const raw = ['e4', 'e5', 'Nf3'];
      expect(service.extractSanMoves(raw)).toEqual(['e4', 'e5', 'Nf3']);
    });

    it('handles empty array', () => {
      expect(service.extractSanMoves([])).toEqual([]);
    });

    it('handles special moves like castling', () => {
      const raw = ['O-O 255+8', 'O-O-O 120+5'];
      expect(service.extractSanMoves(raw)).toEqual(['O-O', 'O-O-O']);
    });
  });

  describe('normalizePgnResult', () => {
    it('converts WHITEWIN to 1-0', () => {
      expect(service.normalizePgnResult('WHITEWIN')).toBe('1-0');
    });

    it('converts BLACKWIN to 0-1', () => {
      expect(service.normalizePgnResult('BLACKWIN')).toBe('0-1');
    });

    it('converts DRAW to 1/2-1/2', () => {
      expect(service.normalizePgnResult('DRAW')).toBe('1/2-1/2');
    });

    it('passes through standard PGN results', () => {
      expect(service.normalizePgnResult('1-0')).toBe('1-0');
      expect(service.normalizePgnResult('0-1')).toBe('0-1');
      expect(service.normalizePgnResult('1/2-1/2')).toBe('1/2-1/2');
    });

    it('returns * for unknown result', () => {
      expect(service.normalizePgnResult('UNKNOWN')).toBe('*');
    });
  });

  describe('centisecondsToHms', () => {
    it('converts 0 to 0:00:00', () => {
      expect(service.centisecondsToHms(0)).toBe('0:00:00');
    });

    it('converts 3050 cs to 0:05:05', () => {
      expect(service.centisecondsToHms(3050)).toBe('0:05:05');
    });

    it('converts 36000 cs to 1:00:00', () => {
      expect(service.centisecondsToHms(36000)).toBe('1:00:00');
    });

    it('converts 3049 cs (truncates sub-second)', () => {
      // 3049 cs = 304.9 seconds → 304s = 5m 4s
      expect(service.centisecondsToHms(3049)).toBe('0:05:04');
    });
  });

  describe('buildPgn', () => {
    it('builds a valid PGN with headers and moves', () => {
      const pgn = service.buildPgn({
        white: mockPlayer('Magnus', 'Carlsen'),
        black: mockPlayer('Fabiano', 'Caruana'),
        result: 'WHITEWIN',
        roundIndex: 1,
        tournamentName: 'Test Tournament',
        timecontrol: '5+3',
        sanMoves: ['e4', 'e5', 'Nf3', 'Nc6'],
        rawMoves: ['e4 300+0', 'e5 300+0', 'Nf3 298+2', 'Nc6 299+1'],
      });

      expect(pgn).toContain('[Event "Test Tournament"]');
      expect(pgn).toContain('[Round "1"]');
      expect(pgn).toContain('[White "Carlsen, Magnus"]');
      expect(pgn).toContain('[Black "Caruana, Fabiano"]');
      expect(pgn).toContain('[Result "1-0"]');
      expect(pgn).toContain('[TimeControl "5+3"]');
      expect(pgn).toContain('1. e4');
      expect(pgn).toContain('1-0');
    });

    it('includes clock annotations in moves', () => {
      const pgn = service.buildPgn({
        white: mockPlayer('A', 'B'),
        black: mockPlayer('C', 'D'),
        result: 'DRAW',
        roundIndex: 2,
        tournamentName: 'T',
        timecontrol: '10+0',
        sanMoves: ['d4', 'd5'],
        rawMoves: ['d4 600+0', 'd5 600+0'],
      });

      expect(pgn).toContain('[%clk');
      expect(pgn).toContain('1/2-1/2');
    });

    it('returns result only for empty moves', () => {
      const pgn = service.buildPgn({
        white: mockPlayer('A', 'B'),
        black: mockPlayer('C', 'D'),
        result: '*',
        roundIndex: 1,
        tournamentName: 'T',
        timecontrol: '5+0',
        sanMoves: [],
        rawMoves: [],
      });

      expect(pgn).toContain('*');
    });

    it('handles player with only last name', () => {
      const player: DgtPlayer = { fname: null, mname: null, lname: 'Smith', title: null, fideid: null };
      const pgn = service.buildPgn({
        white: player,
        black: mockPlayer('John', 'Doe'),
        result: 'BLACKWIN',
        roundIndex: 3,
        tournamentName: 'T',
        timecontrol: '3+2',
        sanMoves: ['e4'],
        rawMoves: ['e4 180'],
      });

      expect(pgn).toContain('[White "Smith"]');
    });
  });

  describe('resolveHost (integration, skipped in unit)', () => {
    it('throws NotFoundException for non-existent tournament', async () => {
      // Mock fetch for unit test
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, status: 404 }) as any;

      await expect(service.resolveHost('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
        NotFoundException,
      );

      global.fetch = originalFetch;
    });

    it('returns host from lookup response', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ host: '1.pool.livechesscloud.com' }),
      }) as any;

      const host = await service.resolveHost('10284f4b-f4b0-4b10-a7fb-3103d0b62128');
      expect(host).toBe('http://1.pool.livechesscloud.com');

      global.fetch = originalFetch;
    });
  });
});
