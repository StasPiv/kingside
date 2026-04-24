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

// 4 пары в winners quarter → 2 в winners semi → 1 winners final → grand_final
// Плюс losers ветка с параллельной структурой. Это упрощённая сетка
// (без всех пар double-elim, чтобы скрин был читаем).
//
// matchScore теперь агрегируется клиентом из `result` партий (KS-1825 v2,
// см. `computeMatchScore`). Поэтому мок содержит по 2-3 партии на пару с
// чередованием цветов — это даёт realistic-скор в песочнице.
function pairGames(
  base: string,
  p1: string,
  p2: string,
  stage: string,
  results: Array<{ whiteIsP1: boolean; result: string }>,
): BroadcastGameSummary[] {
  return results.map((r, i) =>
    mkGame(`${base}-${i + 1}`, {
      whitePlayer: r.whiteIsP1 ? p1 : p2,
      blackPlayer: r.whiteIsP1 ? p2 : p1,
      bracketStage: stage,
      bracketPairId: `${stage}:${p1}|${p2}`,
      result: r.result,
      pgn: r.result === '*' ? null : '1. e4',
    }),
  );
}

const MOCK_GAMES: BroadcastGameSummary[] = [
  // Winners quarter (4 пары, 2 партии каждая)
  ...pairGames('wq1', 'Carlsen', 'Caruana', 'winners_quarter', [
    { whiteIsP1: true, result: '1-0' },
    { whiteIsP1: false, result: '0-1' }, // Carlsen (black) won
  ]),
  ...pairGames('wq2', 'Firouzja', 'Nakamura', 'winners_quarter', [
    { whiteIsP1: true, result: '0-1' }, // Nakamura (black) won
    { whiteIsP1: false, result: '1-0' }, // Nakamura (white) won
    { whiteIsP1: true, result: '1/2-1/2' },
  ]),
  ...pairGames('wq3', 'Abdusattorov', 'Ding', 'winners_quarter', [
    { whiteIsP1: true, result: '1/2-1/2' },
    { whiteIsP1: false, result: '0-1' }, // Abdu (black) won
  ]),
  ...pairGames('wq4', 'Erigaisi', 'Gukesh', 'winners_quarter', [
    { whiteIsP1: false, result: '1-0' }, // Gukesh (white) won
    { whiteIsP1: true, result: '0-1' }, // Gukesh (black) won
  ]),
  // Winners semi (2 пары)
  ...pairGames('ws1', 'Carlsen', 'Nakamura', 'winners_semi', [
    { whiteIsP1: true, result: '1/2-1/2' },
    { whiteIsP1: false, result: '0-1' }, // Carlsen (black) won
    { whiteIsP1: true, result: '1/2-1/2' },
    { whiteIsP1: false, result: '1/2-1/2' },
  ]),
  ...pairGames('ws2', 'Abdusattorov', 'Gukesh', 'winners_semi', [
    { whiteIsP1: true, result: '1-0' },
    { whiteIsP1: false, result: '0-1' }, // Abdu won
  ]),
  // Winners final — в процессе (одна партия ещё идёт)
  ...pairGames('wf', 'Abdusattorov', 'Carlsen', 'winners_final', [
    { whiteIsP1: true, result: '1/2-1/2' },
    { whiteIsP1: false, result: '1/2-1/2' },
    { whiteIsP1: true, result: '*' },
  ]),
  // Losers (упрощённо)
  ...pairGames('lq1', 'Caruana', 'Firouzja', 'losers_quarter', [
    { whiteIsP1: true, result: '1-0' },
    { whiteIsP1: false, result: '1-0' }, // Firouzja (white) won
    { whiteIsP1: true, result: '1-0' }, // Caruana won
  ]),
  ...pairGames('lq2', 'Ding', 'Erigaisi', 'losers_quarter', [
    { whiteIsP1: true, result: '1-0' },
    { whiteIsP1: false, result: '0-1' }, // Ding (black) won
  ]),
  ...pairGames('ls1', 'Caruana', 'Ding', 'losers_semi', [
    { whiteIsP1: true, result: '1-0' },
    { whiteIsP1: false, result: '1-0' }, // Ding (white) won
    { whiteIsP1: true, result: '1/2-1/2' },
  ]),
  ...pairGames('lf', 'Caruana', 'Nakamura', 'losers_final', [
    { whiteIsP1: true, result: '1/2-1/2' },
    { whiteIsP1: false, result: '*' },
  ]),
  // Grand final — все партии «*»
  ...pairGames('gf', 'TBD1', 'TBD2', 'grand_final', [
    { whiteIsP1: true, result: '*' },
  ]),
];

const MOCK_LINKS: BracketLink[] = [
  // Winners chain
  { fromPairId: 'winners_quarter:Carlsen|Caruana', toPairId: 'winners_semi:Carlsen|Nakamura', kind: 'winner' },
  { fromPairId: 'winners_quarter:Firouzja|Nakamura', toPairId: 'winners_semi:Carlsen|Nakamura', kind: 'winner' },
  { fromPairId: 'winners_quarter:Abdusattorov|Ding', toPairId: 'winners_semi:Abdusattorov|Gukesh', kind: 'winner' },
  { fromPairId: 'winners_quarter:Erigaisi|Gukesh', toPairId: 'winners_semi:Abdusattorov|Gukesh', kind: 'winner' },
  { fromPairId: 'winners_semi:Carlsen|Nakamura', toPairId: 'winners_final:Abdusattorov|Carlsen', kind: 'winner' },
  { fromPairId: 'winners_semi:Abdusattorov|Gukesh', toPairId: 'winners_final:Abdusattorov|Carlsen', kind: 'winner' },
  // Winners → grand final
  { fromPairId: 'winners_final:Abdusattorov|Carlsen', toPairId: 'grand_final:TBD1|TBD2', kind: 'winner' },
  // Losers chain
  { fromPairId: 'losers_quarter:Caruana|Firouzja', toPairId: 'losers_semi:Caruana|Ding', kind: 'winner' },
  { fromPairId: 'losers_quarter:Ding|Erigaisi', toPairId: 'losers_semi:Caruana|Ding', kind: 'winner' },
  { fromPairId: 'losers_semi:Caruana|Ding', toPairId: 'losers_final:Caruana|Nakamura', kind: 'winner' },
  { fromPairId: 'losers_final:Caruana|Nakamura', toPairId: 'grand_final:TBD1|TBD2', kind: 'winner' },
  // Winners → losers (double-elim drop)
  { fromPairId: 'winners_quarter:Carlsen|Caruana', toPairId: 'losers_quarter:Caruana|Firouzja', kind: 'loser' },
  { fromPairId: 'winners_quarter:Abdusattorov|Ding', toPairId: 'losers_quarter:Ding|Erigaisi', kind: 'loser' },
  { fromPairId: 'winners_semi:Carlsen|Nakamura', toPairId: 'losers_final:Caruana|Nakamura', kind: 'loser' },
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
