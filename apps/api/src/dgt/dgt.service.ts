import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';

const LOOKUP_URL = 'http://lookup.livechesscloud.com';

export interface DgtPlayer {
  fname: string | null;
  mname: string | null;
  lname: string | null;
  title: string | null;
  fideid: number | null;
}

export interface DgtPairing {
  white: DgtPlayer;
  black: DgtPlayer;
  result: string;
  live: boolean;
}

export interface DgtRoundInfo {
  count: number;
  live: number;
}

export interface DgtTournament {
  id: string;
  name: string;
  location: string | null;
  country: string | null;
  timecontrol: string;
  chess960: string;
  rounds: DgtRoundInfo[];
}

export interface DgtGame {
  roundIndex: number;
  gameIndex: number;
  white: DgtPlayer;
  black: DgtPlayer;
  result: string;
  pgn: string;
  moves: string[];
}

export interface DgtTournamentResult {
  uuid: string;
  tournament: DgtTournament;
  totalRounds: number;
}

export interface DgtRoundResult {
  uuid: string;
  roundIndex: number;
  pairings: DgtPairing[];
  games: DgtGame[];
}

@Injectable()
export class DgtService {
  extractUuid(input: string): string {
    const uuidRegex = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
    const match = uuidRegex.exec(input);
    if (!match) {
      throw new BadRequestException('Invalid DGT LiveChess Cloud URL or tournament ID');
    }
    return match[1];
  }

  async resolveHost(uuid: string): Promise<string> {
    const res = await fetch(`${LOOKUP_URL}/meta/${uuid}`);
    if (!res.ok) {
      if (res.status === 404) {
        throw new NotFoundException(`Tournament ${uuid} not found`);
      }
      throw new Error(`Lookup failed: ${res.status}`);
    }
    const data = (await res.json()) as { host: string };
    return `http://${data.host}`;
  }

  async fetchTournament(uuid: string): Promise<{ host: string; tournament: DgtTournament }> {
    const host = await this.resolveHost(uuid);
    const res = await fetch(`${host}/get/${uuid}/tournament.json`);
    if (!res.ok) {
      throw new NotFoundException(`Tournament data not found for ${uuid}`);
    }
    const tournament = (await res.json()) as DgtTournament;
    return { host, tournament };
  }

  async getTournamentInfo(input: string): Promise<DgtTournamentResult> {
    const uuid = this.extractUuid(input);
    const { tournament } = await this.fetchTournament(uuid);
    return {
      uuid,
      tournament,
      totalRounds: tournament.rounds.length,
    };
  }

  async getRound(input: string, roundIndex: number): Promise<DgtRoundResult> {
    const uuid = this.extractUuid(input);
    const { host, tournament } = await this.fetchTournament(uuid);

    if (roundIndex < 1 || roundIndex > tournament.rounds.length) {
      throw new BadRequestException(
        `Round ${roundIndex} out of range (1–${tournament.rounds.length})`,
      );
    }

    const roundRes = await fetch(`${host}/get/${uuid}/round-${roundIndex}/index.json`);
    if (!roundRes.ok) {
      throw new NotFoundException(`Round ${roundIndex} not found`);
    }
    const roundData = (await roundRes.json()) as { pairings: DgtPairing[] };
    const pairings = roundData.pairings;

    const games: DgtGame[] = await Promise.all(
      pairings.map(async (pairing, i) => {
        const gameIndex = i + 1;
        const gameRes = await fetch(
          `${host}/get/${uuid}/round-${roundIndex}/game-${gameIndex}.json`,
        );
        if (!gameRes.ok) {
          return {
            roundIndex,
            gameIndex,
            white: pairing.white,
            black: pairing.black,
            result: pairing.result,
            pgn: '',
            moves: [],
          };
        }
        const gameData = (await gameRes.json()) as {
          moves: string[];
          result: string;
          chess960: number;
        };
        const sanMoves = this.extractSanMoves(gameData.moves ?? []);
        const pgn = this.buildPgn({
          white: pairing.white,
          black: pairing.black,
          result: pairing.result,
          roundIndex,
          tournamentName: tournament.name,
          timecontrol: tournament.timecontrol,
          sanMoves,
          rawMoves: gameData.moves ?? [],
        });
        return {
          roundIndex,
          gameIndex,
          white: pairing.white,
          black: pairing.black,
          result: pairing.result,
          pgn,
          moves: sanMoves,
        };
      }),
    );

    return { uuid, roundIndex, pairings, games };
  }

  extractSanMoves(rawMoves: string[]): string[] {
    return rawMoves.map((m) => {
      const spaceIdx = m.indexOf(' ');
      return spaceIdx >= 0 ? m.substring(0, spaceIdx) : m;
    });
  }

  buildPgn(params: {
    white: DgtPlayer;
    black: DgtPlayer;
    result: string;
    roundIndex: number;
    tournamentName: string;
    timecontrol: string;
    sanMoves: string[];
    rawMoves: string[];
  }): string {
    const { white, black, result, roundIndex, tournamentName, timecontrol, sanMoves, rawMoves } =
      params;

    const whiteName = this.formatPlayerName(white);
    const blackName = this.formatPlayerName(black);
    const pgnResult = this.normalizePgnResult(result);

    const headers = [
      `[Event "${tournamentName}"]`,
      `[Round "${roundIndex}"]`,
      `[White "${whiteName}"]`,
      `[Black "${blackName}"]`,
      `[Result "${pgnResult}"]`,
      `[TimeControl "${timecontrol}"]`,
    ];

    const movesText = this.formatMoveText(sanMoves, rawMoves, pgnResult);

    return headers.join('\n') + '\n\n' + movesText + '\n';
  }

  private formatPlayerName(player: DgtPlayer): string {
    const parts = [player.lname, player.fname].filter(Boolean);
    return parts.join(', ') || '?';
  }

  normalizePgnResult(result: string): string {
    if (result === 'WHITEWIN' || result === '1-0') return '1-0';
    if (result === 'BLACKWIN' || result === '0-1') return '0-1';
    if (result === 'DRAW' || result === '1/2-1/2') return '1/2-1/2';
    return '*';
  }

  private formatMoveText(sanMoves: string[], rawMoves: string[], result: string): string {
    if (sanMoves.length === 0) return result;

    const parts: string[] = [];
    for (let i = 0; i < sanMoves.length; i++) {
      if (i % 2 === 0) {
        parts.push(`${Math.floor(i / 2) + 1}.`);
      }
      const san = sanMoves[i];
      const clockAnnotation = this.extractClockAnnotation(rawMoves[i]);
      if (clockAnnotation) {
        parts.push(`${san} { ${clockAnnotation} }`);
      } else {
        parts.push(san);
      }
    }
    parts.push(result);
    return parts.join(' ');
  }

  private extractClockAnnotation(rawMove: string): string | null {
    const spaceIdx = rawMove.indexOf(' ');
    if (spaceIdx < 0) return null;
    const clockPart = rawMove.substring(spaceIdx + 1);
    // Format: remainingCentiseconds+usedCentiseconds
    const match = /^(\d+)(?:\+\d+)?$/.exec(clockPart);
    if (!match) return null;
    const remainingCs = parseInt(match[1], 10);
    return `[%clk ${this.centisecondsToHms(remainingCs)}]`;
  }

  centisecondsToHms(cs: number): string {
    const totalSeconds = Math.floor(cs / 10);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
}
