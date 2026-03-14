export interface DgtPlayer {
  fname: string | null;
  mname: string | null;
  lname: string | null;
  title: string | null;
  fideid: number | null;
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

export interface DgtTournamentResult {
  uuid: string;
  tournament: DgtTournament;
  totalRounds: number;
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

export interface DgtRoundResult {
  uuid: string;
  roundIndex: number;
  games: DgtGame[];
}

export function formatPlayerName(player: DgtPlayer): string {
  const parts = [player.lname, player.fname].filter(Boolean);
  return parts.join(', ') || '?';
}

export function formatResult(result: string): string {
  if (result === 'WHITEWIN') return '1-0';
  if (result === 'BLACKWIN') return '0-1';
  if (result === 'DRAW') return '½-½';
  if (result === '*') return '…';
  return result;
}
