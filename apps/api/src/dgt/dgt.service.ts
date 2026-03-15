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
      throw new BadRequestException(
        'Неверный формат URL или ID турнира DGT. Ожидается UUID или URL с UUID, например: http://localhost:3001/api/dgt/tournament/<uuid>/round/1',
      );
    }
    return match[1];
  }

  /**
   * Extracts the base host from a local DGT URL.
   * Returns null if the URL references the livechesscloud.com domain or is not a valid URL.
   * Local URLs (localhost, IP, custom host) return "protocol://host".
   */
  extractLocalHost(input: string): string | null {
    try {
      const url = new URL(input);
      if (!url.hostname.includes('livechesscloud.com')) {
        return `${url.protocol}//${url.host}`;
      }
    } catch {
      // Not a valid URL — input is a plain UUID or cloud reference
    }
    return null;
  }

  async resolveHost(uuid: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${LOOKUP_URL}/meta/${uuid}`);
    } catch (e: any) {
      throw new Error(
        `Не удалось подключиться к облачному сервису DGT LiveChess (${LOOKUP_URL}): ${e.message}`,
      );
    }
    if (!res.ok) {
      if (res.status === 404) {
        throw new NotFoundException(
          `Турнир ${uuid} не найден в облаке DGT LiveChess. Если это локальная доска, передайте полный URL хоста.`,
        );
      }
      throw new Error(`Lookup failed: ${res.status}`);
    }
    const data = (await res.json()) as { host: string };
    return `http://${data.host}`;
  }

  async fetchTournament(
    uuid: string,
    hostOverride?: string,
  ): Promise<{ host: string; tournament: DgtTournament }> {
    const host = hostOverride ?? (await this.resolveHost(uuid));
    let res: Response;
    try {
      res = await fetch(`${host}/get/${uuid}/tournament.json`);
    } catch (e: any) {
      throw new BadRequestException(
        `Не удалось подключиться к DGT-источнику (${host}): ${e.message}`,
      );
    }
    if (!res.ok) {
      throw new NotFoundException(
        `Данные турнира не найдены на хосте ${host} для UUID ${uuid}`,
      );
    }
    const tournament = (await res.json()) as DgtTournament;
    return { host, tournament };
  }

  async getTournamentInfo(input: string): Promise<DgtTournamentResult> {
    const uuid = this.extractUuid(input);
    const localHost = this.extractLocalHost(input) ?? undefined;
    const { tournament } = await this.fetchTournament(uuid, localHost);
    return {
      uuid,
      tournament,
      totalRounds: tournament.rounds.length,
    };
  }

  async getRound(input: string, roundIndex: number): Promise<DgtRoundResult> {
    const uuid = this.extractUuid(input);
    const localHost = this.extractLocalHost(input) ?? undefined;
    const { host, tournament } = await this.fetchTournament(uuid, localHost);

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
