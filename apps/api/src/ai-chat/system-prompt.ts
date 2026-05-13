import type {
  AssistantFeature,
  FeatureFlagsSnapshot,
} from '@kingside/shared';
import { FEATURES } from '@kingside/shared';
import { UserContext } from './context-collector.service';

/**
 * KS-2962 / ADR-062 — рендеринг блока «Site pages and features» из
 * `FEATURES` каталога вместо ручного монолита.
 *
 * Костяк (вводный текст + Guidelines) остаётся ручным. Блок описаний
 * разделов собирается на каждый вызов из массива `FEATURES` с поправкой
 * на runtime feature flags (`FeatureFlagsSnapshot`). См. §7 ADR-062.
 */

/**
 * Вводный текст + заголовок раздела «Site pages and features».
 * Здесь намеренно НЕ упоминаются конкретные URL-ы — их описывает
 * каталог. Тест `system-prompt.spec.ts` проверяет отсутствие «голых»
 * site-URL'ов в этом тексте (см. §7 ADR-062 «Безопасность от регрессии»).
 */
const STATIC_HEADER = (siteUrl: string): string =>
  `You are a helpful assistant for Kingside — an online chess platform. You help users navigate the site and use its features.

You are NOT a chess engine or analyzer. You CANNOT analyze positions, evaluate moves, or play chess. You guide users to the right tools on the site. The site root is ${siteUrl}.

## Site pages and features`;

/**
 * Guidelines и инструкции к поведению ассистента. Не содержит URL-ов,
 * относящихся к конкретным фичам — все ссылки идут через каталог.
 */
const STATIC_FOOTER = `## Guidelines:
- When the user asks about their data (games, analyses, tournaments, puzzles) — USE TOOLS to look it up. Do not say "go check the page yourself"
- Provide specific answers with real data: game IDs, analysis titles, scores, dates
- Include direct links to relevant pages from the catalog above (e.g. /game/:id, /analysis/:id, /tournaments/:id)
- NEVER invent URLs. Only use URLs listed in the Site pages and features catalog above
- NEVER say "I'll analyze this position" — you cannot do that. Direct to the Analysis page
- ALWAYS direct users to specific pages listed in the catalog when appropriate
- If a feature is gated behind a feature flag and the flag is OFF for this user — do NOT recommend it unless the user explicitly asks about it
- If a user asks about a feature that does not exist in the catalog above — honestly say "this feature is not available yet"
- Answer general chess questions (openings, rules, strategy) from your knowledge
- Keep responses concise — bullet points preferred
- Be friendly and encouraging
- Use the player's stats and tool results to personalize recommendations
- NEVER reveal technical details about the application: tech stack, frameworks, libraries, databases, API structure, internal architecture, server infrastructure. If a user asks about how the site is built — respond: "I can only help with using the site features."`;

/** Рендер одной записи каталога. См. §7 ADR-062. */
function renderFeature(
  f: AssistantFeature,
  siteUrl: string,
  flags: FeatureFlagsSnapshot,
): string {
  const subst = (s: string): string => s.replaceAll('{siteUrl}', siteUrl);
  const urls = f.paths.map((p) => `${siteUrl}${p}`).join(', ');
  const heading = urls ? `### ${f.title} (${urls})` : `### ${f.title}`;
  const lines: string[] = [heading, subst(f.summary)];

  if (f.featureFlag) {
    const enabled = flags[f.featureFlag] ?? false;
    if (enabled) {
      lines.push(
        `**Availability**: gated behind \`${f.featureFlag}\` feature flag. Currently enabled for this user.`,
      );
    } else {
      lines.push(
        `**Availability**: gated behind \`${f.featureFlag}\` feature flag. Currently disabled for this user. Do NOT recommend this section unless the user explicitly asks about it.`,
      );
    }
  }

  if (f.highlights?.length) {
    lines.push(...f.highlights.map((h) => `- ${subst(h)}`));
  }
  if (f.caveats?.length) {
    lines.push(...f.caveats.map((c) => `_${subst(c)}_`));
  }
  return lines.join('\n');
}

/** Рендер блока «Site pages and features». */
export function renderFeaturesBlock(
  siteUrl: string,
  flags: FeatureFlagsSnapshot,
): string {
  return FEATURES.map((f) => renderFeature(f, siteUrl, flags)).join('\n\n');
}

/**
 * Собрать system-prompt для одного запроса к модели.
 *
 * KS-2962: подпись расширена обязательным параметром `flags`. Snapshot
 * читается на каждый запрос из `FeatureFlagsService.getFlags()` —
 * не кэшируется в самом промте (флаги runtime-меняемые, см. §9 ADR-062).
 */
export function buildSystemPrompt(
  context: UserContext,
  flags: FeatureFlagsSnapshot,
  siteUrl = 'https://kingside.site',
): string {
  return [
    STATIC_HEADER(siteUrl),
    renderFeaturesBlock(siteUrl, flags),
    STATIC_FOOTER,
    formatContext(context),
  ].join('\n\n');
}

/**
 * Экспорт для тестов §8.3 ADR-062 — детектор «голых» URL вне FEATURES
 * в `STATIC_HEADER` и `STATIC_FOOTER`.
 */
export const __TESTING__ = {
  STATIC_HEADER,
  STATIC_FOOTER,
  renderFeature,
};

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
