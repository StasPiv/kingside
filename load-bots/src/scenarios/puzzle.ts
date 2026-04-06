import { BotUser } from '../bot-user.js';
import { ChessBrain } from '../chess-brain.js';
import { Metrics } from '../metrics.js';
import { Config } from '../config.js';

/**
 * Puzzle solving loop: GET next → think → POST attempt → repeat.
 */
export async function runPuzzleScenario(config: Config, metrics: Metrics): Promise<void> {
  const botCount = config.concurrency;
  console.log(`[Puzzles] Starting ${botCount} bots for ${config.durationSec}s`);

  const endTime = Date.now() + config.durationSec * 1000;
  const promises: Promise<void>[] = [];

  for (let i = 0; i < botCount; i++) {
    const bot = new BotUser(config.baseUrl, config.wsUrl, `${config.userPrefix}P${i}`, metrics);
    promises.push(solvePuzzlesLoop(bot, config, metrics, endTime));
  }

  await Promise.all(promises);
}

async function solvePuzzlesLoop(
  bot: BotUser,
  config: Config,
  metrics: Metrics,
  endTime: number,
): Promise<void> {
  try {
    await bot.login(config.devBypassSecret);
  } catch (e: unknown) {
    console.error(`[${bot.username}] Login failed:`, (e as Error).message);
    return;
  }

  let lastPuzzleId: string | undefined;

  while (Date.now() < endTime) {
    try {
      // Get next puzzle
      const excludeParam = lastPuzzleId ? `?excludeId=${lastPuzzleId}` : '';
      const puzzle = await bot.get<{
        id: string;
        fen: string;
        moves: string[];
        rating: number;
      }>(`/api/puzzles/next${excludeParam}`);

      lastPuzzleId = puzzle.id;

      // "Think" about the puzzle
      const [minMs, maxMs] = config.thinkTimeMs;
      const thinkTime = minMs + Math.random() * (maxMs - minMs);
      await sleep(thinkTime);

      // Try to solve: use ChessBrain to find the first move
      const brain = new ChessBrain('smart');
      brain.loadFen(puzzle.fen);
      const solved = Math.random() < 0.6; // 60% success rate

      // Submit attempt
      await bot.post(`/api/puzzles/${puzzle.id}/attempts`, {
        result: solved ? 'solved' : 'unsolved',
        timeMs: Math.round(thinkTime),
      });

      metrics.recordMove(); // reuse as "puzzle solved"
    } catch (e: unknown) {
      metrics.recordError();
      await sleep(2000); // back off on error
    }
  }

  bot.disconnect();
}

/**
 * Puzzle Rush session: start → solve puzzles in loop → session ends.
 */
export async function runPuzzleRushScenario(config: Config, metrics: Metrics): Promise<void> {
  const botCount = Math.min(config.concurrency, 5); // puzzle rush is heavier
  console.log(`[PuzzleRush] Starting ${botCount} bots for ${config.durationSec}s`);

  const endTime = Date.now() + config.durationSec * 1000;
  const promises: Promise<void>[] = [];

  for (let i = 0; i < botCount; i++) {
    const bot = new BotUser(config.baseUrl, config.wsUrl, `${config.userPrefix}R${i}`, metrics);
    promises.push(puzzleRushLoop(bot, config, metrics, endTime));
  }

  await Promise.all(promises);
}

async function puzzleRushLoop(
  bot: BotUser,
  config: Config,
  metrics: Metrics,
  endTime: number,
): Promise<void> {
  try {
    await bot.login(config.devBypassSecret);
  } catch (e: unknown) {
    console.error(`[${bot.username}] Login failed:`, (e as Error).message);
    return;
  }

  while (Date.now() < endTime) {
    try {
      // Start a puzzle rush session (3 min mode)
      const session = await bot.post<{ id: string }>('/api/puzzle-rush/start', {
        timeMode: '3',
      });

      metrics.recordGameStarted();

      // Solve puzzles until session ends or time runs out
      let sessionActive = true;
      while (sessionActive && Date.now() < endTime) {
        try {
          // Get current session state
          const state = await bot.get<{
            currentPuzzle?: { id: string; fen: string; moves: string[] };
            status: string;
            score: number;
          }>('/api/puzzle-rush/session');

          if (state.status !== 'active' || !state.currentPuzzle) {
            sessionActive = false;
            break;
          }

          // Think about the puzzle
          const [minMs, maxMs] = config.thinkTimeMs;
          await sleep(minMs + Math.random() * (maxMs - minMs) * 0.5); // faster in rush

          // Submit move (first move of solution)
          const brain = new ChessBrain('smart');
          brain.loadFen(state.currentPuzzle.fen);
          const move = brain.pickMove();

          if (move) {
            await bot.post('/api/puzzle-rush/solve', { uci: move });
            metrics.recordMove();
          }
        } catch {
          sessionActive = false;
        }
      }

      // End session
      try {
        await bot.post('/api/puzzle-rush/session', {}); // DELETE via post or dedicated
      } catch { /* ignore */ }

      metrics.recordGameCompleted();
      await sleep(2000); // pause between sessions
    } catch (e: unknown) {
      metrics.recordError();
      await sleep(3000);
    }
  }

  bot.disconnect();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
