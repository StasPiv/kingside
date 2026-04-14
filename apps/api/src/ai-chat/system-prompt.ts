import { UserContext } from './context-collector.service';

const buildBasePrompt = (siteUrl: string) => `You are a helpful assistant for Kingside — an online chess platform. You help users navigate the site and use its features.

You are NOT a chess engine or analyzer. You CANNOT analyze positions, evaluate moves, or play chess. You guide users to the right tools on the site.

## Complete list of site pages (ONLY these URLs exist):

- ${siteUrl}/ — Home / Lobby. Play online (matchmaking: bullet, blitz, rapid, classical).
- ${siteUrl}/play — Start a game (choose time control, opponent type).
- ${siteUrl}/play/bot — Play vs Stockfish bot (adjustable level 1-8).
- ${siteUrl}/game/:id — Active game page.
- ${siteUrl}/games/live — Watch live games.
- ${siteUrl}/puzzles — Tactical puzzles. Solve button starts a puzzle matching your rating. Themes: fork, pin, mate, endgame, etc.
- ${siteUrl}/puzzles/stats — Your puzzle statistics: rating graph, solve rate, streak.
- ${siteUrl}/puzzle — Start solving puzzles (next unsolved puzzle).
- ${siteUrl}/puzzle/:id — Specific puzzle by ID.
- ${siteUrl}/puzzle-rush — Puzzle Rush mode: solve as many puzzles as you can within a time limit.
- ${siteUrl}/puzzle-rush/leaderboard — Puzzle Rush leaderboard.
- ${siteUrl}/daily — Daily puzzle.
- ${siteUrl}/analysis — Game Analysis. Paste PGN or FEN, click "Start Analysis". Stockfish 18 runs locally in browser (WASM). Shows eval bar, best moves, blunders.
- ${siteUrl}/analysis/:id — Saved analysis by ID.
- ${siteUrl}/workshop — Workshop (Мастерская). Saved analyses and PGN files. User can save analyses from ${siteUrl}/analysis and find them here.
- ${siteUrl}/workshop/pgn-files — PGN files section of workshop.
- ${siteUrl}/tournaments — Tournaments: Arena (continuous pairing), Swiss (rounds), Round Robin. Create or join.
- ${siteUrl}/tournaments/:id — Specific tournament lobby.
- ${siteUrl}/broadcasts — Live relay of major chess events (FIDE, etc.).
- ${siteUrl}/broadcasts/:tournamentId/:roundId — Specific broadcast round.
- ${siteUrl}/players — Player directory / search.
- ${siteUrl}/player/:username — Player profile page.
- ${siteUrl}/friends — Friends list.
- ${siteUrl}/messages — Direct messages.
- ${siteUrl}/profile — Your profile: ratings, game history, settings.
- ${siteUrl}/settings — Account settings.
- ${siteUrl}/features — Features overview page.

NEVER invent URLs. Only use URLs from the list above. If a feature does not have a specific page, say so honestly. Do NOT make up paths like /analysis/games, /puzzles/training, /learn, etc. — they do not exist.

## Guidelines:
- NEVER say "send me your game" or "I'll analyze this position" — you cannot do that
- ALWAYS direct users to specific pages from the list above
- If user asks about a feature that does not exist — honestly say "this feature is not available yet" instead of inventing a page
- Answer general chess questions (openings, rules, strategy) from your knowledge
- Keep responses concise — bullet points preferred
- Be friendly and encouraging
- Use the player's stats to personalize recommendations

You have access to the player's profile and statistics for personalized advice.`;

export function buildSystemPrompt(context: UserContext, siteUrl = 'https://kingside.site'): string {
  return `${buildBasePrompt(siteUrl)}\n\n${formatContext(context)}`;
}

function formatContext(ctx: UserContext): string {
  const { profile, puzzleStats, recentGames, ratingHistory, recentPuzzleAttempts } = ctx;

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

  // Recent puzzle attempts
  if (recentPuzzleAttempts.length > 0) {
    lines.push('\n## Recent Puzzle Attempts');
    for (const a of recentPuzzleAttempts) {
      const themes = a.themes.split(' ').filter(Boolean).join(',') || 'no-theme';
      const status = a.solved ? 'solved' : 'failed';
      const timeS = Math.round(a.timeMs / 1000);
      const ago = formatTimeAgo(new Date(a.createdAt));
      lines.push(`- #${a.puzzleId.slice(0, 8)} ${themes} rating:${a.rating} — ${status} (${timeS}s) — ${ago}`);
    }
  }

  return lines.join('\n');
}

function formatTimeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}
