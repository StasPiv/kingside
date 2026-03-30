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

    // Berger table rotation: fix last player, rotate others
    for (let round = 0; round < totalRounds; round++) {
      const pairings: Pairing[] = [];
      let board = 1;

      for (let i = 0; i < n / 2; i++) {
        const home = i === 0 ? players[0] : players[((round + i - 1) % (n - 1)) + 1];
        const away = players[((round + (n / 2) - 1 + i - 1) % (n - 1)) + 1] ?? players[0];

        // Proper Berger: first pairing alternates home/away by round
        let whiteId: string;
        let blackId: string | null;

        if (i === 0) {
          // First board: alternate by round parity
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
}
