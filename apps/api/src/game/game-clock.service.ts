import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

export interface ClockState {
  whiteMs: number;
  blackMs: number;
  lastTick: number;
  running: boolean;
}

@Injectable()
export class GameClockService {
  constructor(private readonly redis: RedisService) {}

  private clockKey(gameId: string): string {
    return `game:${gameId}:clocks`;
  }

  async initClocks(gameId: string, timeMs: number): Promise<ClockState> {
    const state: ClockState = {
      whiteMs: timeMs,
      blackMs: timeMs,
      lastTick: Date.now(),
      running: false,
    };
    await this.redis.hset(this.clockKey(gameId), {
      white_ms: String(state.whiteMs),
      black_ms: String(state.blackMs),
      last_tick: String(state.lastTick),
      running: '0',
    });
    return state;
  }

  async startClock(gameId: string): Promise<void> {
    await this.redis.hset(this.clockKey(gameId), {
      last_tick: String(Date.now()),
      running: '1',
    });
  }

  async switchClock(
    gameId: string,
    colorThatMoved: 'white' | 'black',
    incrementMs: number,
  ): Promise<ClockState> {
    const raw = await this.redis.hgetall(this.clockKey(gameId));
    const now = Date.now();
    const elapsed = now - Number(raw.last_tick);

    const movedField = colorThatMoved === 'white' ? 'white_ms' : 'black_ms';
    const remaining = Math.max(0, Number(raw[movedField]) - elapsed + incrementMs);

    await this.redis.hset(this.clockKey(gameId), {
      [movedField]: String(remaining),
      last_tick: String(now),
    });

    const whiteMs = colorThatMoved === 'white' ? remaining : Number(raw.white_ms);
    const blackMs = colorThatMoved === 'black' ? remaining : Number(raw.black_ms);

    return { whiteMs, blackMs, lastTick: now, running: true };
  }

  async getClocks(gameId: string, activeColor?: 'white' | 'black'): Promise<ClockState> {
    const raw = await this.redis.hgetall(this.clockKey(gameId));
    if (!raw.white_ms) {
      return { whiteMs: 0, blackMs: 0, lastTick: 0, running: false };
    }

    const running = raw.running === '1';
    const now = Date.now();
    let whiteMs = Number(raw.white_ms);
    let blackMs = Number(raw.black_ms);

    // Subtract elapsed time from active player's clock
    if (running && activeColor) {
      const elapsed = now - Number(raw.last_tick);
      if (activeColor === 'white') {
        whiteMs = Math.max(0, whiteMs - elapsed);
      } else {
        blackMs = Math.max(0, blackMs - elapsed);
      }
    }

    return {
      whiteMs,
      blackMs,
      lastTick: (running && activeColor) ? now : Number(raw.last_tick),
      running,
    };
  }

  async checkTimeout(
    gameId: string,
    activeColor: 'white' | 'black',
  ): Promise<{ timedOut: boolean; clocks: ClockState }> {
    const raw = await this.redis.hgetall(this.clockKey(gameId));
    if (!raw.white_ms) {
      return { timedOut: false, clocks: { whiteMs: 0, blackMs: 0, lastTick: 0, running: false } };
    }

    const now = Date.now();
    const elapsed = now - Number(raw.last_tick);
    const field = activeColor === 'white' ? 'white_ms' : 'black_ms';
    const remaining = Number(raw[field]) - elapsed;

    const clocks: ClockState = {
      whiteMs: activeColor === 'white' ? Math.max(0, remaining) : Number(raw.white_ms),
      blackMs: activeColor === 'black' ? Math.max(0, remaining) : Number(raw.black_ms),
      lastTick: now,
      running: raw.running === '1',
    };

    return { timedOut: remaining <= 0, clocks };
  }

  async stopClock(gameId: string): Promise<ClockState> {
    const raw = await this.redis.hgetall(this.clockKey(gameId));
    await this.redis.hset(this.clockKey(gameId), { running: '0' });
    return {
      whiteMs: Number(raw.white_ms),
      blackMs: Number(raw.black_ms),
      lastTick: Number(raw.last_tick),
      running: false,
    };
  }

  async deleteClock(gameId: string): Promise<void> {
    await this.redis.del(this.clockKey(gameId));
  }
}
