import { BotMoveService } from './bot-move.service';
import { INITIAL_FEN } from '@kingside/shared';

describe('BotMoveService', () => {
  let service: BotMoveService;

  beforeEach(() => {
    service = new BotMoveService();
    service.onModuleInit();
  });

  it('should pick a valid move for initial position', () => {
    const uci = service.pickMove(INITIAL_FEN);
    expect(uci).toBeTruthy();
    expect(uci!.length).toBeGreaterThanOrEqual(4);
  });

  it('should return valid UCI format', () => {
    const uci = service.pickMove(INITIAL_FEN);
    expect(uci).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
  });

  it('should pick a move from a mid-game position', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    const uci = service.pickMove(fen);
    expect(uci).toBeTruthy();
  });

  it('should return null for checkmate position', () => {
    // Scholar's mate — black is mated
    const fen = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';
    const uci = service.pickMove(fen);
    expect(uci).toBeNull();
  });
});
