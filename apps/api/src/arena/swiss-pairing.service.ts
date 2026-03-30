import { Injectable } from '@nestjs/common';

interface Player {
  userId: string;
  score: number;
  rating: number;
  opponents: string[]; // previously played
  colorHistory: ('w' | 'b')[]; // recent colors
}

export interface Pairing {
  whiteId: string;
  blackId: string | null; // null = bye
  board: number;
}

@Injectable()
export class SwissPairingService {
  /**
   * Swiss pairing: group by score, pair within groups by rating, avoid repeats, balance colors.
   */
  pair(players: Player[], round: number): Pairing[] {
    if (players.length < 2) return [];

    // Sort by score desc, then rating desc
    const sorted = [...players].sort((a, b) => b.score - a.score || b.rating - a.rating);

    const paired = new Set<string>();
    const pairings: Pairing[] = [];
    let board = 1;

    // Round 1: top half vs bottom half
    if (round === 1) {
      const half = Math.floor(sorted.length / 2);
      for (let i = 0; i < half; i++) {
        const white = sorted[i];
        const black = sorted[i + half];
        pairings.push({ whiteId: white.userId, blackId: black.userId, board: board++ });
        paired.add(white.userId);
        paired.add(black.userId);
      }
    } else {
      // Group by score, pair within groups
      for (let i = 0; i < sorted.length; i++) {
        if (paired.has(sorted[i].userId)) continue;

        for (let j = i + 1; j < sorted.length; j++) {
          if (paired.has(sorted[j].userId)) continue;
          if (sorted[i].opponents.includes(sorted[j].userId)) continue;

          const [white, black] = this.assignColors(sorted[i], sorted[j]);
          pairings.push({ whiteId: white, blackId: black, board: board++ });
          paired.add(sorted[i].userId);
          paired.add(sorted[j].userId);
          break;
        }
      }
    }

    // Bye for unpaired player (odd number)
    for (const p of sorted) {
      if (!paired.has(p.userId)) {
        pairings.push({ whiteId: p.userId, blackId: null, board: board++ });
      }
    }

    return pairings;
  }

  private assignColors(a: Player, b: Player): [string, string] {
    const aWhites = a.colorHistory.filter((c) => c === 'w').length;
    const bWhites = b.colorHistory.filter((c) => c === 'w').length;
    // Give white to the player who had fewer whites
    if (aWhites < bWhites) return [a.userId, b.userId];
    if (bWhites < aWhites) return [b.userId, a.userId];
    // Tiebreak: higher-rated gets white in odd rounds
    return a.rating >= b.rating ? [a.userId, b.userId] : [b.userId, a.userId];
  }
}
