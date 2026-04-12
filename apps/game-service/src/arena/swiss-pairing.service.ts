import { Injectable } from '@nestjs/common';

interface Player {
  userId: string;
  score: number;
  rating: number;
  opponents: string[]; // previously played
  colorHistory: ('w' | 'b')[]; // recent colors
  hadBye?: boolean; // already received bye in a previous round
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
      // Pass 1: prefer non-repeat opponents
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

      // Pass 2: allow repeat opponents for unpaired players (fallback)
      for (let i = 0; i < sorted.length; i++) {
        if (paired.has(sorted[i].userId)) continue;

        for (let j = i + 1; j < sorted.length; j++) {
          if (paired.has(sorted[j].userId)) continue;

          const [white, black] = this.assignColors(sorted[i], sorted[j]);
          pairings.push({ whiteId: white, blackId: black, board: board++ });
          paired.add(sorted[i].userId);
          paired.add(sorted[j].userId);
          break;
        }
      }
    }

    // Bye for unpaired player (odd number) — player who hasn't had bye yet
    const unpaired = sorted.filter((p) => !paired.has(p.userId));
    if (unpaired.length > 0) {
      let byePlayer = unpaired.find((p) => !p.hadBye) ?? null;

      if (!byePlayer && unpaired.length === 1 && pairings.length > 0) {
        // Only unpaired player already had bye — swap with someone from last pairing
        const hadByePlayer = unpaired[0];
        // Search pairings from bottom (lowest-ranked) for a swap candidate without hadBye
        for (let k = pairings.length - 1; k >= 0; k--) {
          const p = pairings[k];
          if (p.blackId === null) continue;
          const whiteP = sorted.find((s) => s.userId === p.whiteId);
          const blackP = sorted.find((s) => s.userId === p.blackId);
          // Try to swap: give bye to one of the paired players (who hasn't had bye)
          // and pair hadByePlayer with the other
          if (blackP && !blackP.hadBye) {
            pairings[k] = { whiteId: hadByePlayer.userId, blackId: p.whiteId, board: p.board };
            byePlayer = blackP;
            break;
          }
          if (whiteP && !whiteP.hadBye) {
            pairings[k] = { whiteId: p.blackId!, blackId: hadByePlayer.userId, board: p.board };
            byePlayer = whiteP;
            break;
          }
        }
        // If no swap possible (everyone had bye), fallback
        if (!byePlayer) byePlayer = hadByePlayer;
      }

      if (!byePlayer) byePlayer = unpaired[0];
      pairings.push({ whiteId: byePlayer.userId, blackId: null, board: board++ });
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
