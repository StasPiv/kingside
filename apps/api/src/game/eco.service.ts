import { Injectable } from '@nestjs/common';

interface EcoEntry {
  code: string;
  name: string;
}

/**
 * Определяет ECO-код и название дебюта по начальным ходам партии (SAN).
 * Использует longest-prefix match по массиву ходов.
 */
@Injectable()
export class EcoService {
  private readonly ecoMap: Map<string, EcoEntry>;

  constructor() {
    this.ecoMap = new Map();
    this.initEcoData();
  }

  /**
   * Определяет дебют по массиву SAN-ходов.
   * Возвращает наиболее специфичное совпадение.
   */
  classify(sanMoves: string[]): EcoEntry {
    let bestMatch: EcoEntry = { code: 'A00', name: 'Uncommon Opening' };

    for (let length = 1; length <= Math.min(sanMoves.length, 20); length++) {
      const key = sanMoves.slice(0, length).join(' ');
      const entry = this.ecoMap.get(key);
      if (entry) {
        bestMatch = entry;
      }
    }

    return bestMatch;
  }

  private initEcoData(): void {
    const entries: [string, string, string][] = [
      // A: Flank openings
      ['e4', 'B00', 'King\'s Pawn Opening'],
      ['d4', 'A40', 'Queen\'s Pawn Opening'],
      ['c4', 'A10', 'English Opening'],
      ['Nf3', 'A04', 'Reti Opening'],
      ['f4', 'A02', 'Bird\'s Opening'],
      ['g3', 'A00', 'Hungarian Opening'],
      ['b3', 'A01', 'Nimzo-Larsen Attack'],
      ['b4', 'A00', 'Sokolsky Opening'],

      // B: Semi-open games (1.e4, not 1...e5)
      ['e4 c5', 'B20', 'Sicilian Defense'],
      ['e4 c5 Nf3', 'B27', 'Sicilian Defense'],
      ['e4 c5 Nf3 d6', 'B50', 'Sicilian Defense'],
      ['e4 c5 Nf3 d6 d4', 'B53', 'Sicilian Defense'],
      ['e4 c5 Nf3 d6 d4 cxd4 Nxd4', 'B80', 'Sicilian Defense: Open'],
      ['e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3', 'B90', 'Sicilian Defense: Najdorf Variation'],
      ['e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6', 'B90', 'Sicilian Defense: Najdorf Variation'],
      ['e4 c5 Nf3 Nc6', 'B30', 'Sicilian Defense'],
      ['e4 c5 Nf3 e6', 'B40', 'Sicilian Defense'],
      ['e4 c5 Nc3', 'B23', 'Sicilian Defense: Closed'],
      ['e4 e6', 'C00', 'French Defense'],
      ['e4 e6 d4', 'C00', 'French Defense'],
      ['e4 e6 d4 d5', 'C00', 'French Defense'],
      ['e4 e6 d4 d5 Nc3', 'C03', 'French Defense'],
      ['e4 e6 d4 d5 Nd2', 'C01', 'French Defense: Tarrasch Variation'],
      ['e4 e6 d4 d5 e5', 'C02', 'French Defense: Advance Variation'],
      ['e4 c6', 'B10', 'Caro-Kann Defense'],
      ['e4 c6 d4', 'B12', 'Caro-Kann Defense'],
      ['e4 c6 d4 d5', 'B12', 'Caro-Kann Defense'],
      ['e4 c6 d4 d5 Nc3', 'B15', 'Caro-Kann Defense: Main Line'],
      ['e4 c6 d4 d5 e5', 'B12', 'Caro-Kann Defense: Advance Variation'],
      ['e4 d5', 'B01', 'Scandinavian Defense'],
      ['e4 d6', 'B06', 'Pirc Defense'],
      ['e4 d6 d4 Nf6 Nc3', 'B07', 'Pirc Defense'],
      ['e4 g6', 'B06', 'Modern Defense'],
      ['e4 Nf6', 'B02', 'Alekhine\'s Defense'],

      // C: Open games (1.e4 e5)
      ['e4 e5', 'C20', 'King\'s Pawn Game'],
      ['e4 e5 Nf3', 'C40', 'King\'s Knight Opening'],
      ['e4 e5 Nf3 Nc6', 'C44', 'King\'s Knight Opening'],
      ['e4 e5 Nf3 Nc6 Bb5', 'C60', 'Ruy Lopez'],
      ['e4 e5 Nf3 Nc6 Bb5 a6', 'C68', 'Ruy Lopez'],
      ['e4 e5 Nf3 Nc6 Bb5 a6 Ba4', 'C70', 'Ruy Lopez'],
      ['e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6', 'C78', 'Ruy Lopez'],
      ['e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O', 'C88', 'Ruy Lopez'],
      ['e4 e5 Nf3 Nc6 Bc4', 'C50', 'Italian Game'],
      ['e4 e5 Nf3 Nc6 Bc4 Bc5', 'C50', 'Italian Game: Giuoco Piano'],
      ['e4 e5 Nf3 Nc6 Bc4 Nf6', 'C55', 'Italian Game: Two Knights Defense'],
      ['e4 e5 Nf3 Nc6 d4', 'C44', 'Scotch Game'],
      ['e4 e5 Nf3 Nc6 d4 exd4', 'C45', 'Scotch Game'],
      ['e4 e5 Nf3 Nf6', 'C42', 'Petrov\'s Defense'],
      ['e4 e5 Nf3 d6', 'C41', 'Philidor Defense'],
      ['e4 e5 f4', 'C30', 'King\'s Gambit'],
      ['e4 e5 d4', 'C21', 'Center Game'],
      ['e4 e5 Bc4', 'C23', 'Bishop\'s Opening'],

      // D: Closed/Semi-closed (1.d4 d5)
      ['d4 d5', 'D00', 'Queen\'s Pawn Game'],
      ['d4 d5 c4', 'D06', 'Queen\'s Gambit'],
      ['d4 d5 c4 e6', 'D30', 'Queen\'s Gambit Declined'],
      ['d4 d5 c4 e6 Nc3', 'D31', 'Queen\'s Gambit Declined'],
      ['d4 d5 c4 e6 Nc3 Nf6', 'D35', 'Queen\'s Gambit Declined'],
      ['d4 d5 c4 e6 Nf3', 'D30', 'Queen\'s Gambit Declined'],
      ['d4 d5 c4 dxc4', 'D20', 'Queen\'s Gambit Accepted'],
      ['d4 d5 c4 c6', 'D10', 'Slav Defense'],
      ['d4 d5 c4 c6 Nf3 Nf6', 'D11', 'Slav Defense'],
      ['d4 d5 Nf3', 'D02', 'Queen\'s Pawn Game'],
      ['d4 d5 Nf3 Nf6', 'D02', 'Queen\'s Pawn Game'],
      ['d4 d5 Bf4', 'D00', 'London System'],
      ['d4 d5 Nf3 Nf6 Bf4', 'D00', 'London System'],

      // E: Indian systems (1.d4 Nf6)
      ['d4 Nf6', 'A46', 'Indian Defense'],
      ['d4 Nf6 c4', 'A15', 'Indian Defense'],
      ['d4 Nf6 c4 e6', 'E00', 'Indian Defense'],
      ['d4 Nf6 c4 e6 Nc3', 'E20', 'Nimzo-Indian Defense'],
      ['d4 Nf6 c4 e6 Nc3 Bb4', 'E20', 'Nimzo-Indian Defense'],
      ['d4 Nf6 c4 e6 Nf3', 'E10', 'Indian Defense'],
      ['d4 Nf6 c4 e6 Nf3 b6', 'E10', 'Queen\'s Indian Defense'],
      ['d4 Nf6 c4 e6 g3', 'E00', 'Catalan Opening'],
      ['d4 Nf6 c4 g6', 'E60', 'King\'s Indian Defense'],
      ['d4 Nf6 c4 g6 Nc3', 'E61', 'King\'s Indian Defense'],
      ['d4 Nf6 c4 g6 Nc3 Bg7', 'E61', 'King\'s Indian Defense'],
      ['d4 Nf6 c4 g6 Nc3 Bg7 e4', 'E70', 'King\'s Indian Defense'],
      ['d4 Nf6 c4 g6 Nc3 Bg7 e4 d6', 'E70', 'King\'s Indian Defense'],
      ['d4 Nf6 c4 c5', 'A50', 'Benoni Defense'],
      ['d4 Nf6 Nf3', 'A46', 'Indian Defense'],
      ['d4 Nf6 Nf3 g6', 'A48', 'King\'s Indian Defense'],
      ['d4 Nf6 Bf4', 'A46', 'London System'],
      ['d4 Nf6 Nf3 d5 Bf4', 'D00', 'London System'],

      // English variations
      ['c4 e5', 'A20', 'English Opening: Reversed Sicilian'],
      ['c4 Nf6', 'A15', 'English Opening: Anglo-Indian'],
      ['c4 c5', 'A30', 'English Opening: Symmetrical'],

      // Reti
      ['Nf3 d5', 'A04', 'Reti Opening'],
      ['Nf3 d5 c4', 'A09', 'Reti Opening'],
      ['Nf3 Nf6', 'A04', 'Reti Opening'],
    ];

    for (const [moves, code, name] of entries) {
      this.ecoMap.set(moves, { code, name });
    }
  }
}
