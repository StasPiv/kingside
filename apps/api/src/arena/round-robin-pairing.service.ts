import { Injectable } from '@nestjs/common';
import type { Pairing } from './swiss-pairing.service';

@Injectable()
export class RoundRobinPairingService {
  /**
   * Berger table: generate all round pairings for N players.
   * Returns array of rounds, each containing pairings.
   */
  generateAllRounds(playerIds: string[]): Pairing[][] {
    const players = [...playerIds];
    // Add "BYE" if odd number
    if (players.length % 2 !== 0) {
      players.push('__BYE__');
    }

    const n = players.length;
    const totalRounds = n - 1;
    const allRounds: Pairing[][] = [];

    // Standard circle method: fix player[n-1], rotate positions 0..n-2
    // Round r: position[i] = players[(r + i) % (n-1)] for i=0..n-2, position[n-1] = players[n-1]
    for (let round = 0; round < totalRounds; round++) {
      const pairings: Pairing[] = [];
      let board = 1;

      // Build the rotated list for this round
      const rotated: string[] = [];
      for (let i = 0; i < n - 1; i++) {
        rotated.push(players[(round + i) % (n - 1)]);
      }
      rotated.push(players[n - 1]); // fixed player at end

      // Pair: first with last, second with second-to-last, etc.
      for (let i = 0; i < n / 2; i++) {
        const home = rotated[i];
        const away = rotated[n - 1 - i];

        let whiteId: string;
        let blackId: string | null;

        if (i === 0) {
          // First board: alternate colors by round parity for balanced colors
          whiteId = round % 2 === 0 ? home : away;
          blackId = round % 2 === 0 ? away : home;
        } else {
          whiteId = home;
          blackId = away;
        }

        // Handle BYE
        if (whiteId === '__BYE__') {
          pairings.push({ whiteId: blackId!, blackId: null, board: board++ });
        } else if (blackId === '__BYE__') {
          pairings.push({ whiteId, blackId: null, board: board++ });
        } else {
          pairings.push({ whiteId, blackId, board: board++ });
        }
      }

      allRounds.push(pairings);
    }

    return allRounds;
  }

  /**
   * Generate full schedule for multi-round RR.
   * In even cycles (2nd, 4th...) colors are inverted.
   */
  /**
   * Generate full schedule for multi-cycle RR.
   * cycles: number of circles (each circle = baseRounds.length rounds)
   * In even cycles (2nd, 4th...) colors are inverted.
   */
  generateFullSchedule(playerIds: string[], cycles: number): Pairing[][] {
    const baseRounds = this.generateAllRounds(playerIds);
    if (baseRounds.length === 0) return [];

    const cycleLength = baseRounds.length;
    const totalRounds = cycles * cycleLength;
    const schedule: Pairing[][] = [];

    for (let r = 0; r < totalRounds; r++) {
      const cycleNumber = Math.floor(r / cycleLength);
      const roundIndex = r % cycleLength;
      const basePairings = baseRounds[roundIndex];
      const invertColors = cycleNumber % 2 === 1;

      if (!invertColors) {
        schedule.push(basePairings);
      } else {
        // Invert white/black, but not for byes
        schedule.push(basePairings.map((p) => {
          if (!p.blackId) return p; // bye — keep as is
          return { whiteId: p.blackId, blackId: p.whiteId, board: p.board };
        }));
      }
    }

    return schedule;
  }
}
