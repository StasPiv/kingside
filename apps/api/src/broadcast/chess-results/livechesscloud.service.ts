import { Injectable, Logger } from '@nestjs/common';

const LIVECHESS_API = 'https://1.pool.livechesscloud.com/get';
const FETCH_TIMEOUT_MS = 10_000;

export interface LivechessTournamentInfo {
  name: string;
  location: string | null;
  country: string | null;
  timecontrol: string | null;
  rounds: { count: number; live: number }[];
  isLive: boolean;
  totalRounds: number;
}

@Injectable()
export class LivechesscloudService {
  private readonly logger = new Logger(LivechesscloudService.name);

  /**
   * Fetch tournament info from livechesscloud API.
   * Returns null if tournament not found or API error.
   */
  async getTournamentInfo(uuid: string): Promise<LivechessTournamentInfo | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const response = await fetch(`${LIVECHESS_API}/${uuid}/tournament.json`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timeout);

      if (!response.ok) return null;

      const data = await response.json();
      const rounds: { count: number; live: number }[] = data.rounds ?? [];
      const isLive = rounds.some((r) => r.live > 0);
      const totalRounds = rounds.length;

      return {
        name: data.name ?? '',
        location: data.location ?? null,
        country: data.country ?? null,
        timecontrol: data.timecontrol ?? null,
        rounds,
        isLive,
        totalRounds,
      };
    } catch (e: any) {
      this.logger.warn(`Failed to fetch livechesscloud info for ${uuid}: ${e.message}`);
      return null;
    }
  }

  /**
   * Determine tournament status: "live", "archived", or "unknown".
   */
  async getStatus(uuid: string): Promise<'live' | 'archived' | 'unknown'> {
    const info = await this.getTournamentInfo(uuid);
    if (!info) return 'unknown';
    return info.isLive ? 'live' : 'archived';
  }
}
