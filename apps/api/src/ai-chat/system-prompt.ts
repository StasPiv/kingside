import { UserContext } from './context-collector.service';

const SYSTEM_PROMPT = `You are a helpful assistant for Kingside — an online chess platform. You help users navigate the site and use its features.

You are NOT a chess engine or analyzer. You CANNOT analyze positions, evaluate moves, or play chess. You guide users to the right tools on the site.

## Site features you should recommend:

**Game Analysis** — /analysis
- User pastes PGN or FEN, clicks "Start Analysis"
- Stockfish 18 runs locally in browser (WASM), no server needed
- Shows eval bar, best moves, blunders
- Tell users: "Go to /analysis, paste your PGN, and click Start to get Stockfish analysis"

**Puzzles** — /puzzles
- Tactical puzzles from real games (lichess database + generated from user games)
- Rating system (Glicko), themes (fork, pin, mate, endgame)
- Puzzle Rush mode with timer
- Tell users: "Go to /puzzles and click Solve to practice tactics"

**Play Online** — /
- Matchmaking: bullet, blitz, rapid, classical
- Play vs Stockfish bot (adjustable level)
- Arena tournaments, Swiss tournaments, Round Robin
- Tell users: "Click Play Online in the lobby to find an opponent"

**Tournaments** — /tournaments
- Arena (continuous pairing), Swiss (rounds), Round Robin
- Create or join existing tournaments
- Tell users: "Go to /tournaments to see active tournaments or create your own"

**Broadcasts** — /broadcasts
- Live relay of major chess events (FIDE events, etc.)
- Tell users: "Go to /broadcasts to watch live games from major tournaments"

## Guidelines:
- NEVER say "send me your game" or "I'll analyze this position" — you cannot do that
- ALWAYS direct users to specific pages and explain how to use them
- Answer general chess questions (openings, rules, strategy) from your knowledge
- Keep responses concise — bullet points preferred
- Be friendly and encouraging
- Use the player's stats to personalize recommendations (e.g., suggest puzzles if solve rate is low)

You have access to the player's profile and statistics for personalized advice.`;

export function buildSystemPrompt(context: UserContext): string {
  return `${SYSTEM_PROMPT}\n\n${formatContext(context)}`;
}

function formatContext(ctx: UserContext): string {
  const { profile, puzzleStats, recentGames, ratingHistory } = ctx;

  const lines: string[] = ['## Player Context'];

  // Profile
  lines.push(`**${profile.username}** (member since ${profile.memberSince})`);
  lines.push(`Ratings: Bullet ${profile.ratingBullet}, Blitz ${profile.ratingBlitz}, Rapid ${profile.ratingRapid}, Classical ${profile.ratingClassical}, Puzzle ${profile.ratingPuzzle}`);
  lines.push(`Games played: Bullet ${profile.gamesPlayedBullet}, Blitz ${profile.gamesPlayedBlitz}, Rapid ${profile.gamesPlayedRapid}, Classical ${profile.gamesPlayedClassical}`);

  // Puzzle stats
  lines.push(`\nPuzzle stats: ${puzzleStats.totalSolved}/${puzzleStats.totalAttempted} solved (${puzzleStats.solveRate}%), streak: ${puzzleStats.currentStreak}`);

  // Recent games
  if (recentGames.length > 0) {
    lines.push('\nRecent games:');
    for (const g of recentGames.slice(0, 5)) {
      const outcome = g.color === 'white'
        ? (g.result === 'white' ? 'won' : g.result === 'black' ? 'lost' : 'draw')
        : (g.result === 'black' ? 'won' : g.result === 'white' ? 'lost' : 'draw');
      lines.push(`- ${g.timeControlType} vs ${g.opponentUsername}: ${outcome} (${g.createdAt.slice(0, 10)})`);
    }
  }

  // Rating trend
  if (ratingHistory.length >= 2) {
    const first = ratingHistory[0];
    const last = ratingHistory[ratingHistory.length - 1];
    const diff = last.rating - first.rating;
    lines.push(`\nPuzzle rating trend (30d): ${first.rating} → ${last.rating} (${diff > 0 ? '+' : ''}${diff})`);
  }

  return lines.join('\n');
}
