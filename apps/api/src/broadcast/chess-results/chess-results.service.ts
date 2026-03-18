import { Injectable, Logger } from '@nestjs/common';

/** Regex to extract livechesscloud UUID from page text */
const LIVECHESS_RE =
  /view\.livechesscloud\.com[/#]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

/** Regex to extract tournament IDs from the main page */
const TOURNAMENT_LINK_RE = /tnr(\d+)\.aspx/g;

/** Regex to extract tournament name from <title> or heading */
const TITLE_RE = /<title[^>]*>([^<]+)<\/title>/i;

const BASE_URL = 'https://chess-results.com';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_TOURNAMENTS_PER_SCAN = 50;

export interface ChessResultsTournament {
  tournamentId: string;
  name: string;
  url: string;
  livechessUuids: string[];
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

    return {
      tournamentId,
      name,
      url,
      livechessUuids: uuids,
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
