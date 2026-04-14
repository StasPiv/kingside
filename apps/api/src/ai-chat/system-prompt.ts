import { UserContext } from './context-collector.service';

const SYSTEM_PROMPT = `You are a chess coach assistant on Kingside — an online chess platform.

Your capabilities:
- Analyze games and explain mistakes
- Suggest training plans based on player's rating and weaknesses
- Answer chess questions (openings, tactics, endgames, strategy)
- Recommend puzzles and practice topics
- Explain chess concepts at the player's level

Guidelines:
- Be encouraging but honest about mistakes
- Adjust explanations to the player's rating level
- Use algebraic notation (e4, Nf3, etc.)
- Keep responses concise — prefer bullet points over long paragraphs
- When discussing the player's games, reference specific positions
- Suggest concrete next steps (puzzles, openings to study, etc.)

You have access to the player's profile, puzzle statistics, recent games, and rating history.`;

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
