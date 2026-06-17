/**
 * Bot level configuration — mirrors server LEVEL_MAP
 * (apps/game-service/src/engine/stockfish.service.ts)
 */

export type BotLevelConfig = {
  skillLevel: number;
  depth: number;
  movetime: number;
};

export const BOT_LEVELS: Record<number, BotLevelConfig> = {
  1:  { skillLevel: 0,  depth: 1,  movetime: 50 },
  2:  { skillLevel: 1,  depth: 1,  movetime: 75 },
  3:  { skillLevel: 2,  depth: 2,  movetime: 100 },
  4:  { skillLevel: 3,  depth: 2,  movetime: 125 },
  5:  { skillLevel: 4,  depth: 3,  movetime: 150 },
  6:  { skillLevel: 5,  depth: 4,  movetime: 200 },
  7:  { skillLevel: 6,  depth: 5,  movetime: 250 },
  8:  { skillLevel: 7,  depth: 6,  movetime: 300 },
  9:  { skillLevel: 8,  depth: 7,  movetime: 400 },
  10: { skillLevel: 9,  depth: 8,  movetime: 500 },
  11: { skillLevel: 10, depth: 9,  movetime: 600 },
  12: { skillLevel: 11, depth: 10, movetime: 700 },
  13: { skillLevel: 12, depth: 11, movetime: 800 },
  14: { skillLevel: 13, depth: 12, movetime: 1000 },
  15: { skillLevel: 14, depth: 13, movetime: 1200 },
  16: { skillLevel: 15, depth: 14, movetime: 1500 },
  17: { skillLevel: 16, depth: 16, movetime: 1800 },
  18: { skillLevel: 17, depth: 18, movetime: 2000 },
  19: { skillLevel: 18, depth: 20, movetime: 2500 },
  20: { skillLevel: 20, depth: 22, movetime: 3000 },
};

export function getBotLevelConfig(level: number): BotLevelConfig {
  return BOT_LEVELS[Math.max(1, Math.min(20, level))] ?? BOT_LEVELS[10];
}
