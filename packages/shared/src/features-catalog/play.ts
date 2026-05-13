import type { AssistantFeature } from './types.js';

export const play: AssistantFeature = {
  id: 'play',
  title: 'Play (matchmaking and bot)',
  paths: ['/play'],
  summary:
    'Primary entry point for starting a chess game. Combines matchmaking against real players and games against the Stockfish bot — both are configured from the same screen.',
  highlights: [
    'Time controls: ultra-bullet (15s, 30s), bullet (1+0, 1+1, 2+1), blitz (3+0, 3+2, 5+0, 5+3), rapid (10+0, 10+5, 15+10, 30+0), classical (30+20, 60+0, 60+30), and fully custom (1-180 min main / 0-180 sec increment)',
    'Matchmaking: pick a time control, click Play — the system finds an opponent near your rating. Rating filter is adjustable (relative ±200-1000 or absolute range). Each time control category has its own rating',
    'Bot mode (Stockfish on the server): difficulty slider 1-20, pick your color (white, black, random) and a time control. Max 3 active bot games at a time',
  ],
  caveats: [
    'Requires authentication',
  ],
  auth: 'user',
  featureFlag: null,
  mcpSection: null,
};
