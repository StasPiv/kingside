import { Injectable, Logger } from '@nestjs/common';

/** Regex to extract livechesscloud UUID from page text */
const LIVECHESS_RE =
  /view\.livechesscloud\.com[/#]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** Regex to extract tournament IDs from the main page */
const TOURNAMENT_LINK_RE = /tnr(\d+)\.aspx/g;

/** Regex to extract tournament name from <title> or heading */
const TITLE_RE = /<title[^>]*>([^<]+)<\/title>/i;

/** Regex to extract CRmsg description text (may contain HTML tags) */
const CRMSG_RE = /<h3\s+[Cc]lass="CRmsg">([^]*?)<\/h3>/i;

/** Regex to extract player count from table rows */
const PLAYER_ROW_RE = /class="CRg[12][^"]*"/g;

/** Regex to extract last update date */
const LAST_UPDATE_RE = /Last update (\d{2}\.\d{2}\.\d{4})/i;

const BASE_URL = 'https://chess-results.com';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_TOURNAMENTS_PER_SCAN = 50;
/** Concurrent requests for batch scanning */
const SCAN_CONCURRENCY = 15;

/**
 * Approximate tournament IDs per day on chess-results.com.
 * Based on observation: ~620 new tournament IDs created per day.
 * Reference point: tnr814436 = Sep 2023, tnr1375000 = Mar 2026 (~920 days).
 */
const IDS_PER_DAY = 610;
/** Reference: tnr814436 was created around 2023-09-01 */
const REFERENCE_ID = 814436;
const REFERENCE_DATE = new Date('2023-09-01');

export interface TournamentMetadata {
  description: string | null;
  playerCount: number | null;
  lastUpdate: string | null;
}

export interface ChessResultsTournament {
  tournamentId: string;
  name: string;
  url: string;
  livechessUuids: string[];
  metadata: TournamentMetadata;
}

@Injectable()
export class ChessResultsService {
  private readonly logger = new Logger(ChessResultsService.name);

  /**
   * Scan chess-results.com for current tournaments with livechesscloud links.
   * Returns only tournaments that have at least one livechesscloud UUID.
   */
  async scanCurrentTournaments(): Promise<ChessResultsTournament[]> {
    const tournamentIds = await this.fetchCurrentTournamentIds();
    this.logger.log(`Found ${tournamentIds.length} current tournaments to scan`);

    const results: ChessResultsTournament[] = [];

    for (const id of tournamentIds.slice(0, MAX_TOURNAMENTS_PER_SCAN)) {
      try {
        const tournament = await this.parseTournament(id);
        if (tournament && tournament.livechessUuids.length > 0) {
          results.push(tournament);
          this.logger.log(
            `Tournament ${id}: found ${tournament.livechessUuids.length} livechesscloud UUID(s) — ${tournament.name}`,
          );
        }
      } catch (e: any) {
        this.logger.warn(`Failed to parse tournament ${id}: ${e.message}`);
      }
    }

    this.logger.log(`Scan complete: ${results.length} tournament(s) with livechesscloud links`);
    return results;
  }

  /**
   * Estimate the tournament ID range for a given date range.
   * chess-results IDs are roughly sequential with ~610 new IDs/day.
   */
  estimateIdRange(from: Date, to: Date): { startId: number; endId: number } {
    const fromDays = Math.floor((from.getTime() - REFERENCE_DATE.getTime()) / 86400000);
    const toDays = Math.ceil((to.getTime() - REFERENCE_DATE.getTime()) / 86400000);

    // Add margin of ±2 days for estimation error
    const startId = Math.max(1, REFERENCE_ID + (fromDays - 2) * IDS_PER_DAY);
    const endId = REFERENCE_ID + (toDays + 2) * IDS_PER_DAY;

    return { startId: Math.floor(startId), endId: Math.floor(endId) };
  }

  /**
   * Scan tournaments by date range — full scan of every ID with parallel batching.
   * `concurrency` controls how many pages are fetched in parallel (default 15).
   */
  async scanByDateRange(
    from: Date,
    to: Date,
    concurrency = SCAN_CONCURRENCY,
  ): Promise<ChessResultsTournament[]> {
    const { startId, endId } = this.estimateIdRange(from, to);
    const totalIds = endId - startId + 1;
    this.logger.log(
      `Full scan: IDs ${startId}–${endId} (${totalIds} total, concurrency ${concurrency})`,
    );

    const results: ChessResultsTournament[] = [];
    let checked = 0;
    let errors = 0;

    for (let batchStart = startId; batchStart <= endId; batchStart += concurrency) {
      const batchEnd = Math.min(batchStart + concurrency - 1, endId);
      const batchIds: number[] = [];
      for (let id = batchStart; id <= batchEnd; id++) batchIds.push(id);

      const batchResults = await Promise.allSettled(
        batchIds.map((id) => this.checkForLivechess(id)),
      );

      for (const r of batchResults) {
        if (r.status === 'fulfilled' && r.value) {
          results.push(r.value);
          this.logger.log(
            `  tnr${r.value.tournamentId}: ${r.value.livechessUuids.length} UUID(s) — ${r.value.name}`,
          );
        } else if (r.status === 'rejected') {
          errors++;
        }
      }

      checked += batchIds.length;
      if (checked % 150 === 0 || batchEnd >= endId) {
        const pct = Math.floor((checked / totalIds) * 100);
        this.logger.log(
          `  Progress: ${checked}/${totalIds} (${pct}%), found ${results.length}, errors ${errors}`,
        );
      }
    }

    this.logger.log(
      `Full scan complete: ${checked} checked, ${results.length} found, ${errors} errors`,
    );
    return results;
  }

  /**
   * Quick check: fetch page and return tournament only if it has livechesscloud links.
   * Extracts full metadata only for pages that match.
   */
  private async checkForLivechess(id: number): Promise<ChessResultsTournament | null> {
    const url = `${BASE_URL}/tnr${id}.aspx?lan=1`;
    const html = await this.fetchPage(url);
    const uuids = this.extractLivechessUuids(html);
    if (uuids.length === 0) return null;

    const name = this.extractTournamentName(html);
    const metadata = this.extractMetadata(html);

    return {
      tournamentId: String(id),
      name,
      url,
      livechessUuids: uuids,
      metadata,
    };
  }

  /**
   * Fetch the main page and extract current tournament IDs.
   * chess-results.com main page lists recent/active tournaments.
   */
  async fetchCurrentTournamentIds(): Promise<string[]> {
    const html = await this.fetchPage(`${BASE_URL}/`);
    const ids = new Set<string>();

    let match: RegExpExecArray | null;
    while ((match = TOURNAMENT_LINK_RE.exec(html)) !== null) {
      ids.add(match[1]);
    }

    return Array.from(ids);
  }

  /**
   * Parse a single tournament page and extract livechesscloud UUIDs.
   * Follows 302 redirects (chess-results.com redirects to s1/s2/s3 subdomains).
   */
  async parseTournament(tournamentId: string): Promise<ChessResultsTournament | null> {
    const url = `${BASE_URL}/tnr${tournamentId}.aspx?lan=1`;
    const html = await this.fetchPage(url);

    const uuids = this.extractLivechessUuids(html);
    const name = this.extractTournamentName(html);
    const metadata = this.extractMetadata(html);

    return {
      tournamentId,
      name,
      url,
      livechessUuids: uuids,
      metadata,
    };
  }

  /**
   * Extract livechesscloud UUIDs from HTML content.
   */
  extractLivechessUuids(html: string): string[] {
    const uuids = new Set<string>();
    let match: RegExpExecArray | null;

    // Reset regex lastIndex
    LIVECHESS_RE.lastIndex = 0;
    while ((match = LIVECHESS_RE.exec(html)) !== null) {
      uuids.add(match[1].toLowerCase());
    }

    return Array.from(uuids);
  }

  /**
   * Extract tournament name from HTML.
   */
  extractTournamentName(html: string): string {
    const titleMatch = TITLE_RE.exec(html);
    if (titleMatch) {
      // Title often has format "Chess-Results Server - Tournament Name"
      const title = titleMatch[1].trim();
      const dashIdx = title.indexOf(' - ');
      return dashIdx !== -1 ? title.slice(dashIdx + 3).trim() : title;
    }
    return 'Unknown Tournament';
  }

  /**
   * Extract metadata from tournament HTML.
   */
  extractMetadata(html: string): TournamentMetadata {
    // Description from CRmsg block (strip HTML tags)
    let description: string | null = null;
    const msgMatch = CRMSG_RE.exec(html);
    if (msgMatch) {
      description = msgMatch[1]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .trim();
      // Truncate if too long
      if (description.length > 500) {
        description = description.slice(0, 497) + '...';
      }
    }

    // Player count from table rows
    PLAYER_ROW_RE.lastIndex = 0;
    let playerCount = 0;
    while (PLAYER_ROW_RE.exec(html) !== null) playerCount++;
    const finalPlayerCount = playerCount > 0 ? playerCount : null;

    // Last update date
    let lastUpdate: string | null = null;
    const dateMatch = LAST_UPDATE_RE.exec(html);
    if (dateMatch) {
      lastUpdate = dateMatch[1];
    }

    return { description, playerCount: finalPlayerCount, lastUpdate };
  }

  /**
   * Fetch a page with timeout, following redirects.
   */
  private async fetchPage(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Kingside/1.0 (chess platform; broadcast sync)',
          Accept: 'text/html',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      return await response.text();
    } finally {
      clearTimeout(timeout);
    }
  }
}
