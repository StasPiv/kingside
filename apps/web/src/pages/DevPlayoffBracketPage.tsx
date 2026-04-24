import type { BroadcastGameSummary } from '@kingside/shared';

import { PlayoffBracket } from '../components/broadcast/PlayoffBracket';

/**
 * Dev-песочница `PlayoffBracket` (KS-1814). Маршрут не protected —
 * нужен для скриншотов сетки на синтетических данных (продовый
 * trigger `tournamentType='playoff'` требует раунд с классификатором).
 */

const MOCK_GAMES: BroadcastGameSummary[] = [
  // Четвертьфиналы
  {
    id: 'q1-g1',
    lichessGameId: 'lg-q1-1',
    whitePlayer: 'Carlsen',
    blackPlayer: 'Caruana',
    whiteElo: 2830,
    blackElo: 2780,
    result: '1-0',
    pgn: '1. e4',
    currentFen: null,
    updatedAt: '2026-04-24T10:00:00.000Z',
    bracketStage: 'quarter',
    bracketPairId: 'quarter:Carlsen|Caruana',
    matchScore: '2-0',
  },
  {
    id: 'q1-g2',
    lichessGameId: 'lg-q1-2',
    whitePlayer: 'Caruana',
    blackPlayer: 'Carlsen',
    whiteElo: 2780,
    blackElo: 2830,
    result: '0-1',
    pgn: '1. d4',
    currentFen: null,
    updatedAt: '2026-04-24T11:00:00.000Z',
    bracketStage: 'quarter',
    bracketPairId: 'quarter:Carlsen|Caruana',
    matchScore: '2-0',
  },
  {
    id: 'q2-g1',
    lichessGameId: 'lg-q2-1',
    whitePlayer: 'Nakamura',
    blackPlayer: 'Firouzja',
    whiteElo: 2810,
    blackElo: 2790,
    result: '1/2-1/2',
    pgn: '1. e4',
    currentFen: null,
    updatedAt: '2026-04-24T10:00:00.000Z',
    bracketStage: 'quarter',
    bracketPairId: 'quarter:Firouzja|Nakamura',
    matchScore: '1½-1½',
  },
  // Полуфинал
  {
    id: 's1-g1',
    lichessGameId: 'lg-s1-1',
    whitePlayer: 'Carlsen',
    blackPlayer: 'Ding',
    whiteElo: 2830,
    blackElo: 2800,
    result: '*',
    pgn: '1. c4',
    currentFen: null,
    updatedAt: '2026-04-24T12:00:00.000Z',
    bracketStage: 'semi',
    bracketPairId: 'semi:Carlsen|Ding',
    matchScore: '0-0',
  },
];

export function DevPlayoffBracketPage() {
  return (
    <div className="dev-playoff-page" style={{ padding: 24, maxWidth: 1000 }}>
      <h1 style={{ marginTop: 0 }}>PlayoffBracket — dev sandbox</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        KS-1814 (L-broadcast). Рендер сетки плей-офф на синтетических данных.
      </p>
      <PlayoffBracket games={MOCK_GAMES} onGameClick={(g) => console.log(g.id)} />
    </div>
  );
}
