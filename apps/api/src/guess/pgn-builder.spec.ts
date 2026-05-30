/**
 * KS-3460 / ADR-089 §3, §4. Unit-тесты PGN-builder'а.
 *
 * Покрытие (требование acceptance):
 *   1. strongest — единственный guess-ход, верный сильнейший.
 *   2. blunder реальной партии + смешанные verdict'ы пользователя.
 *   3. promotion в варианте пользователя (e7e8q).
 *   4. короткая партия (1-2 хода).
 *   5. длинная партия с десятком guess-ходов.
 *
 * Обратимость: каждый result-PGN скармливаем `Chess#loadPgn` без
 * ошибки. Дополнительно проверяем наличие нужных NAG-кодов и SAN
 * в текстовых сценариях.
 */
import { Chess } from 'chess.js';
import {
  buildAnnotatedPgn,
  type GuessMoveForBuilder,
  type PgnTranslator,
} from './pgn-builder';

// Простая i18n-стаб: возвращает ключ + JSON-args (детерминированно).
const stubTranslate: PgnTranslator = (key, args) =>
  args ? `${key}(${JSON.stringify(args)})` : key;

function expectLoadPgnOk(pgn: string): void {
  const chess = new Chess();
  expect(() => chess.loadPgn(pgn)).not.toThrow();
}

describe('buildAnnotatedPgn — fixtures', () => {
  it('1) strongest single move — NAG $3 в варианте, NAG основной нет (loss=0)', () => {
    // 1.e4 e5 2.Nf3. Игрок угадал тот же ход Nf3 (нет, лучше другой):
    // Возьмём ply=3 (white): playedUci=g1f3, userUci=b1c3 (Nc3 strongest).
    // lossPlayer=0 (Nf3 = best), userUci !== playedUci → variant Nc3 $3.
    // Wait: strongest означает что user НАШЁЛ сильнейший. Это значит
    // userUci = bestUci. Сценарий: реальный ход был НЕ best (но любой
    // lossPlayer), а user угадал best.
    // Чтобы main NAG отсутствовал — берём lossPlayer=0.04 (≤0.05).
    const pgn = '1. e4 e5 2. Nf3 *';
    const moves: GuessMoveForBuilder[] = [
      {
        ply: 3,
        fenBefore: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
        playedUci: 'g1f3',
        userUci: 'b1c3',
        lossPlayer: 0.0,
        lossUser: 0.02,
        accuracyPlayer: 100,
        accuracyUser: 98,
        userClass: 'best',
        verdict: 'strongest',
      },
    ];
    const out = buildAnnotatedPgn(pgn, 'white', moves, stubTranslate);
    expectLoadPgnOk(out);
    // В выходе есть основная партия 1. e4 e5 2. Nf3, вариант (2. Nc3 ... $3).
    expect(out).toMatch(/2\.\s*Nf3\b/);
    // Внутри варианта: `2. Nc3 $3 {comment}`.
    expect(out).toMatch(/\(\s*2\.\s*Nc3\s*\$3\s*\{[^}]+\}\s*\)/);
    // main NAG для loss=0 нет.
    expect(out).not.toMatch(/2\.\s*Nf3\s*\$[246]/);
  });

  it('2) blunder реальной партии — $4 на основной + смесь verdict у user', () => {
    // 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O Be7 6.Re1 b5 7.Bb3 d6
    // 8.c3 O-O 9.h3. White ply: 1,3,5,7,9,11,13,15,17.
    // Возьмём guess-ходы за white:
    //  - ply=15 (8.c3) — playedUci=c2c3, userUci=d2d4 (Bb3-d4? нет, центральный),
    //    lossPlayer=0.30 (blunder), userUci !== playedUci, verdict='weaker',
    //    userClass='mistake' → variant $2.
    //  - ply=17 (9.h3) — playedUci=h2h3, userUci=h2h3 (тот же ход),
    //    lossPlayer=0.07 (inaccuracy в реале), verdict='asPlayer'. userUci===playedUci
    //    → варианта НЕ вставляем; но main NAG $6 ставим.
    const pgn =
      '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 *';
    const moves: GuessMoveForBuilder[] = [
      {
        ply: 15,
        fenBefore:
          'r1bq1rk1/2ppbppp/p1n2n2/1p2p3/4P3/1B3N2/PPPP1PPP/RNBQR1K1 w - - 2 8',
        playedUci: 'c2c3',
        userUci: 'd2d4',
        lossPlayer: 0.3,
        lossUser: 0.18,
        accuracyPlayer: 30,
        accuracyUser: 55,
        userClass: 'mistake',
        verdict: 'weaker',
      },
      {
        ply: 17,
        fenBefore:
          'r1bq1rk1/2pnbppp/p1n5/1p2p3/4P3/1BP2N2/PP1P1PPP/RNBQR1K1 w - - 0 9',
        playedUci: 'h2h3',
        userUci: 'h2h3',
        lossPlayer: 0.07,
        lossUser: 0.07,
        accuracyPlayer: 65,
        accuracyUser: 65,
        userClass: 'inaccuracy',
        verdict: 'asPlayer',
      },
    ];
    const out = buildAnnotatedPgn(pgn, 'white', moves, stubTranslate);
    expectLoadPgnOk(out);
    // Основная: c3 с $4 (blunder), вариант (8. d4 ... $2).
    expect(out).toMatch(/8\.\s*c3\s*\$4/);
    expect(out).toMatch(/\(\s*8\.\s*d4\s*\$2\s*\{[^}]+\}\s*\)/);
    // 9. h3 с $6 (inaccuracy), без варианта (asPlayer + одинаковый ход).
    expect(out).toMatch(/9\.\s*h3\s*\$6/);
    // не должно быть варианта на 9 ходу (тот же ход).
    expect(out).not.toMatch(/\(\s*9\./);
  });

  it('3) promotion — userUci=e7e8q в варианте', () => {
    // KS-FEN с пешкой e7 (белая, ход 1). userMove — продвижение в Q (e7e8q).
    // playedMove — продвижение в R (e7e8r), verdict='weaker' class=inaccuracy.
    // Чёрный король на a8 (e8 свободна для промоушна e7→e8).
    const pgn = '[FEN "k7/4P3/8/8/8/8/8/4K3 w - - 0 1"]\n[Result "*"]\n\n1. e8=R *';
    const moves: GuessMoveForBuilder[] = [
      {
        ply: 1,
        fenBefore: 'k7/4P3/8/8/8/8/8/4K3 w - - 0 1',
        playedUci: 'e7e8r',
        userUci: 'e7e8q',
        lossPlayer: 0.06,
        lossUser: 0.0,
        accuracyPlayer: 80,
        accuracyUser: 100,
        userClass: 'best',
        verdict: 'betterThanPlayer',
      },
    ];
    const out = buildAnnotatedPgn(pgn, 'white', moves, stubTranslate);
    expectLoadPgnOk(out);
    // В варианте есть продвижение в ферзя (=Q или Q в SAN).
    expect(out).toMatch(/\(\s*1\.\s*e8=Q[+#]?\s*\$1/);
    // main NAG $6 (loss=0.06 > 0.05).
    expect(out).toMatch(/1\.\s*e8=R\+?\s*\$6/);
  });

  it('4) короткая партия (1 ход) — без NAG если loss=0 и userUci===playedUci', () => {
    const pgn = '1. e4 *';
    const moves: GuessMoveForBuilder[] = [
      {
        ply: 1,
        fenBefore:
          'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        playedUci: 'e2e4',
        userUci: 'e2e4',
        lossPlayer: 0.0,
        lossUser: 0.0,
        accuracyPlayer: 100,
        accuracyUser: 100,
        userClass: 'best',
        verdict: 'asPlayer',
      },
    ];
    const out = buildAnnotatedPgn(pgn, 'white', moves, stubTranslate);
    expectLoadPgnOk(out);
    // Чистый PGN без NAG.
    expect(out).toMatch(/1\.\s*e4\b/);
    expect(out).not.toMatch(/\$\d/);
    // И без варианта (тот же ход).
    expect(out).not.toMatch(/\(/);
  });

  it('5) длинная партия с десятком guess-ходов (12) — обратимость через loadPgn', () => {
    // Берём реальную короткую партию из лессов: Italian Game ~24 хода.
    const pgn =
      '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4 exd4 6. cxd4 Bb4+ 7. Nc3 Nxe4 8. O-O Bxc3 9. d5 Bf6 10. Re1 Ne7 11. Rxe4 d6 12. Bg5 Bxg5 13. Nxg5 O-O 14. Nxh7 Kxh7 15. Qh5+ Kg8 16. Rh4 f5 17. Qxf5 *';
    // Сгенерируем guess-ходы для white (ply 1,3,5,...,33). Возьмём 12
    // ходов из этих. Для простоты — userUci=playedUci всегда (asPlayer),
    // varied lossPlayer чтобы покрыть все 4 ветки NAG основной линии.
    const whitePliesPgn = [
      { ply: 1, played: 'e2e4', loss: 0.0 }, // none
      { ply: 3, played: 'g1f3', loss: 0.04 }, // none
      { ply: 5, played: 'f1c4', loss: 0.06 }, // $6
      { ply: 7, played: 'c2c3', loss: 0.13 }, // $2
      { ply: 9, played: 'd2d4', loss: 0.26 }, // $4
      { ply: 11, played: 'c3d4', loss: 0.0 },
      { ply: 13, played: 'b1c3', loss: 0.07 }, // $6
      { ply: 15, played: 'e1g1', loss: 0.0 },
      { ply: 17, played: 'd4d5', loss: 0.0 },
      { ply: 19, played: 'f1e1', loss: 0.0 },
      { ply: 21, played: 'e1e4', loss: 0.0 },
      { ply: 23, played: 'c1g5', loss: 0.0 },
    ];
    const moves: GuessMoveForBuilder[] = whitePliesPgn.map((p) => ({
      ply: p.ply,
      // fenBefore не критичен для теста — userUci=playedUci, варианта нет.
      fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      playedUci: p.played,
      userUci: p.played,
      lossPlayer: p.loss,
      lossUser: p.loss,
      accuracyPlayer: 90,
      accuracyUser: 90,
      userClass: 'best',
      verdict: 'asPlayer',
    }));
    const out = buildAnnotatedPgn(pgn, 'white', moves, stubTranslate);
    expectLoadPgnOk(out);
    // Проверяем что нужные NAG присутствуют по содержимому.
    expect(out).toMatch(/\$6/); // inaccuracy
    expect(out).toMatch(/\$2/); // mistake
    expect(out).toMatch(/\$4/); // blunder
    // Вариантов нет (все asPlayer + userUci===playedUci).
    expect(out).not.toMatch(/\(/);
  });
});

describe('buildAnnotatedPgn — детали', () => {
  it('annotator передаётся в header, GuessSide выставляется', () => {
    const out = buildAnnotatedPgn('1. e4 *', 'black', [], stubTranslate, {
      annotator: 'Kingside guess',
    });
    expect(out).toMatch(/\[Annotator "Kingside guess"\]/);
    expect(out).toMatch(/\[GuessSide "Black"\]/);
  });

  it('weaker mistake — комментарий weakerLoss с lossUser%', () => {
    const pgn = '1. e4 *';
    const moves: GuessMoveForBuilder[] = [
      {
        ply: 1,
        fenBefore:
          'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        playedUci: 'e2e4',
        userUci: 'a2a3',
        lossPlayer: 0.0,
        lossUser: 0.14,
        accuracyPlayer: 100,
        accuracyUser: 60,
        userClass: 'mistake',
        verdict: 'weaker',
      },
    ];
    const out = buildAnnotatedPgn(pgn, 'white', moves, stubTranslate);
    expectLoadPgnOk(out);
    // Комментарий содержит ключ weakerLoss + loss=14 (round of 0.14).
    expect(out).toMatch(/\{[^}]*weakerLoss.*"loss":\s*14[^}]*\}/);
    expect(out).toMatch(/\$2\s*\{/); // mistake → $2 перед комментарием
  });
});
