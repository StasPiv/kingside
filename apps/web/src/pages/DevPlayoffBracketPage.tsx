import type { BracketLink, BroadcastGameSummary } from '@kingside/shared';

import { PlayoffBracket } from '../components/broadcast/PlayoffBracket';

/**
 * Dev-песочница `PlayoffBracket` (KS-1814 / KS-1825). Маршрут не
 * protected — для скриншотов сетки с линиями на синтетических данных,
 * пока backend `/bracket` эндпоинт не задеплоен на прод.
 */

function mkGame(
  id: string,
  overrides: Partial<BroadcastGameSummary>,
): BroadcastGameSummary {
  return {
    id,
    lichessGameId: `lg-${id}`,
    whitePlayer: 'White',
    blackPlayer: 'Black',
    whiteElo: 2700,
    blackElo: 2700,
    result: '1-0',
    pgn: '1. e4',
    currentFen: null,
    updatedAt: '2026-04-24T10:00:00.000Z',
    bracketStage: null,
    bracketPairId: null,
    matchScore: null,
    ...overrides,
  };
}

// 8 пар в winners quarter → 4 в winners semi → 2 в winners final → grand_final
// Плюс losers ветка с параллельной структурой. Это упрощённая сетка
// (без всех пар double-elim, чтобы скрин был читаем).
const MOCK_GAMES: BroadcastGameSummary[] = [
  // Winners quarter (4 пары)
  mkGame('wq1', {
    whitePlayer: 'Carlsen',
    blackPlayer: 'Caruana',
    bracketStage: 'winners_quarter',
    bracketPairId: 'wq:Carlsen|Caruana',
    matchScore: '2-0',
  }),
  mkGame('wq2', {
    whitePlayer: 'Nakamura',
    blackPlayer: 'Firouzja',
    bracketStage: 'winners_quarter',
    bracketPairId: 'wq:Firouzja|Nakamura',
    matchScore: '2-1',
  }),
  mkGame('wq3', {
    whitePlayer: 'Ding',
    blackPlayer: 'Abdusattorov',
    bracketStage: 'winners_quarter',
    bracketPairId: 'wq:Abdusattorov|Ding',
    matchScore: '1½-½',
  }),
  mkGame('wq4', {
    whitePlayer: 'Gukesh',
    blackPlayer: 'Erigaisi',
    bracketStage: 'winners_quarter',
    bracketPairId: 'wq:Erigaisi|Gukesh',
    matchScore: '2-0',
  }),
  // Winners semi (2 пары)
  mkGame('ws1', {
    whitePlayer: 'Carlsen',
    blackPlayer: 'Nakamura',
    bracketStage: 'winners_semi',
    bracketPairId: 'ws:Carlsen|Nakamura',
    matchScore: '2½-1½',
  }),
  mkGame('ws2', {
    whitePlayer: 'Abdusattorov',
    blackPlayer: 'Gukesh',
    bracketStage: 'winners_semi',
    bracketPairId: 'ws:Abdusattorov|Gukesh',
    matchScore: '2-0',
  }),
  // Winners final
  mkGame('wf', {
    whitePlayer: 'Carlsen',
    blackPlayer: 'Abdusattorov',
    bracketStage: 'winners_final',
    bracketPairId: 'wf:Abdusattorov|Carlsen',
    matchScore: '2-2',
    result: '*',
  }),
  // Losers (упрощённо)
  mkGame('lq1', {
    whitePlayer: 'Caruana',
    blackPlayer: 'Firouzja',
    bracketStage: 'losers_quarter',
    bracketPairId: 'lq:Caruana|Firouzja',
    matchScore: '2-1',
  }),
  mkGame('lq2', {
    whitePlayer: 'Ding',
    blackPlayer: 'Erigaisi',
    bracketStage: 'losers_quarter',
    bracketPairId: 'lq:Ding|Erigaisi',
    matchScore: '2-0',
  }),
  mkGame('ls1', {
    whitePlayer: 'Caruana',
    blackPlayer: 'Ding',
    bracketStage: 'losers_semi',
    bracketPairId: 'ls:Caruana|Ding',
    matchScore: '2-1',
  }),
  mkGame('lf', {
    whitePlayer: 'Caruana',
    blackPlayer: 'Nakamura',
    bracketStage: 'losers_final',
    bracketPairId: 'lf:Caruana|Nakamura',
    matchScore: '1-1',
    result: '*',
  }),
  // Grand final
  mkGame('gf', {
    whitePlayer: 'TBD',
    blackPlayer: 'TBD',
    bracketStage: 'grand_final',
    bracketPairId: 'gf',
    matchScore: '—',
    result: '*',
  }),
];

const MOCK_LINKS: BracketLink[] = [
  // Winners chain
  { fromPairId: 'wq:Carlsen|Caruana', toPairId: 'ws:Carlsen|Nakamura', kind: 'winner' },
  { fromPairId: 'wq:Firouzja|Nakamura', toPairId: 'ws:Carlsen|Nakamura', kind: 'winner' },
  { fromPairId: 'wq:Abdusattorov|Ding', toPairId: 'ws:Abdusattorov|Gukesh', kind: 'winner' },
  { fromPairId: 'wq:Erigaisi|Gukesh', toPairId: 'ws:Abdusattorov|Gukesh', kind: 'winner' },
  { fromPairId: 'ws:Carlsen|Nakamura', toPairId: 'wf:Abdusattorov|Carlsen', kind: 'winner' },
  { fromPairId: 'ws:Abdusattorov|Gukesh', toPairId: 'wf:Abdusattorov|Carlsen', kind: 'winner' },
  // Winners → grand final
  { fromPairId: 'wf:Abdusattorov|Carlsen', toPairId: 'gf', kind: 'winner' },
  // Losers chain
  { fromPairId: 'lq:Caruana|Firouzja', toPairId: 'ls:Caruana|Ding', kind: 'winner' },
  { fromPairId: 'lq:Ding|Erigaisi', toPairId: 'ls:Caruana|Ding', kind: 'winner' },
  { fromPairId: 'ls:Caruana|Ding', toPairId: 'lf:Caruana|Nakamura', kind: 'winner' },
  { fromPairId: 'lf:Caruana|Nakamura', toPairId: 'gf', kind: 'winner' },
  // Winners → losers (double-elim drop)
  { fromPairId: 'wq:Carlsen|Caruana', toPairId: 'lq:Caruana|Firouzja', kind: 'loser' },
  { fromPairId: 'wq:Abdusattorov|Ding', toPairId: 'lq:Ding|Erigaisi', kind: 'loser' },
  { fromPairId: 'ws:Carlsen|Nakamura', toPairId: 'lf:Caruana|Nakamura', kind: 'loser' },
];

export function DevPlayoffBracketPage() {
  return (
    <div className="dev-playoff-page" style={{ padding: 24, maxWidth: 1280 }}>
      <h1 style={{ marginTop: 0 }}>PlayoffBracket — dev sandbox</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        KS-1814 / KS-1825. Синтетические данные для проверки линий
        (winner — сплошная зелёная, loser — пунктирная жёлтая).
      </p>
      <PlayoffBracket
        games={MOCK_GAMES}
        links={MOCK_LINKS}
        onGameClick={(g) => console.log(g.id)}
      />
    </div>
  );
}
