import { isBlunder, isUnique, isRecapture } from './blunder-detection';
import { Chess } from 'chess.js';

describe('isBlunder', () => {
  it('drop=200, threshold=200 → true', () => {
    expect(isBlunder(200, 200)).toBe(true);
  });
  it('drop=199, threshold=200 → false', () => {
    expect(isBlunder(199, 200)).toBe(false);
  });
  it('drop=0 → false', () => {
    expect(isBlunder(0, 200)).toBe(false);
  });
});

describe('isUnique', () => {
  it('spread=150, threshold=150 → true', () => {
    expect(isUnique(150, 150)).toBe(true);
  });
  it('spread=149 → false', () => {
    expect(isUnique(149, 150)).toBe(false);
  });
});

describe('isRecapture', () => {
  it('made-move = capture на e5, solution = takes на e5 → recapture', () => {
    // Создаём позицию: белый слон на e5 берёт чёрного коня. Затем
    // решение puzzle'а — взятие на e5 чёрной фигурой.
    const chess = new Chess();
    chess.move('e4');
    chess.move('e5');
    chess.move('Nf3');
    chess.move('Nc6');
    chess.move('Bb5');
    chess.move('Nf6');
    chess.move('Bxc6'); // captures
    const made = chess.history({ verbose: true })[6];
    expect(made.captured).toBeDefined();
    expect(made.to).toBe('c6');
    expect(isRecapture(made, 'b7c6')).toBe(true);
    expect(isRecapture(made, 'd7c6')).toBe(true);
  });

  it('non-capture move → not recapture', () => {
    const chess = new Chess();
    chess.move('e4');
    const made = chess.history({ verbose: true })[0];
    expect(made.captured).toBeUndefined();
    expect(isRecapture(made, 'd2d4')).toBe(false);
  });

  it('capture on different square → not recapture', () => {
    const chess = new Chess();
    chess.move('e4');
    chess.move('d5');
    chess.move('exd5'); // captures on d5
    const made = chess.history({ verbose: true })[2];
    expect(made.captured).toBeDefined();
    expect(made.to).toBe('d5');
    // решение — другой ход совсем
    expect(isRecapture(made, 'g8f6')).toBe(false);
  });
});
