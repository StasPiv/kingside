import { FEATURES, type FeatureFlagsSnapshot } from '@kingside/shared';
import { buildSystemPrompt, __TESTING__ } from './system-prompt';
import type { UserContext } from './context-collector.service';

/**
 * KS-2962 / ADR-062 §8.3 + KS-2966 / ADR-063 §5 — гарантирует, что
 * каждая запись FEATURES попадает в собранный промт, в
 * STATIC_HEADER/STATIC_FOOTER нет «голых» URL, а slim-summary каждой
 * записи валиден (≥30 / ≤200, заканчивается точкой, без URL и без
 * подстановок).
 */

const SITE_URL = 'https://kingside.test';

const STUB_CONTEXT: UserContext = {
  profile: {
    username: 'alice',
    ratingBullet: 1500,
    ratingBlitz: 1600,
    ratingRapid: 1700,
    ratingClassical: 1800,
    ratingPuzzle: 1900,
    gamesPlayedBullet: 10,
    gamesPlayedBlitz: 20,
    gamesPlayedRapid: 30,
    gamesPlayedClassical: 5,
    puzzleStreak: 3,
    memberSince: '2024-01-01',
  },
  puzzleStats: {
    totalAttempted: 100,
    totalSolved: 70,
    solveRate: 70,
    currentStreak: 3,
  },
  recentGames: [],
  ratingHistory: [],
  recentPuzzleAttempts: [],
};

const ALL_ENABLED_FLAGS: FeatureFlagsSnapshot = {
  lessonsEnabled: true,
  puzzlesEnabled: true,
  broadcastsEnabled: true,
  tournamentsEnabled: true,
  assistantEnabled: true,
  drillsEnabled: true,
  studiesEnabled: true,
};

const ALL_DISABLED_FLAGS: FeatureFlagsSnapshot = {
  lessonsEnabled: false,
  puzzlesEnabled: false,
  broadcastsEnabled: false,
  tournamentsEnabled: false,
  assistantEnabled: false,
  drillsEnabled: false,
  studiesEnabled: false,
};

describe('buildSystemPrompt (KS-2962 / ADR-062 + KS-2966 / ADR-063)', () => {
  it('every FEATURES entry appears in the rendered prompt (title + all paths)', () => {
    const prompt = buildSystemPrompt(STUB_CONTEXT, ALL_ENABLED_FLAGS, SITE_URL);
    for (const f of FEATURES) {
      expect(prompt).toContain(f.title);
      for (const p of f.paths) {
        // Каждый path должен присутствовать как полный URL.
        expect(prompt).toContain(`${SITE_URL}${p}`);
      }
    }
  });

  it('feature gated by a DISABLED flag has the "Do NOT recommend" availability note', () => {
    const prompt = buildSystemPrompt(STUB_CONTEXT, ALL_DISABLED_FLAGS, SITE_URL);
    const gated = FEATURES.find((f) => f.featureFlag === 'puzzlesEnabled');
    expect(gated).toBeDefined();
    expect(prompt).toContain('Currently disabled for this user');
    expect(prompt).toContain('Do NOT recommend this section');
  });

  it('feature gated by an ENABLED flag does NOT have the "Do NOT recommend" note', () => {
    const prompt = buildSystemPrompt(STUB_CONTEXT, ALL_ENABLED_FLAGS, SITE_URL);
    expect(prompt).not.toContain('Currently disabled for this user');
    expect(prompt).not.toContain('Do NOT recommend this section');
    // Но содержит availability-блок с "Currently enabled".
    expect(prompt).toContain('Currently enabled for this user');
  });

  it('rendered prompt contains no {siteUrl} placeholder leftovers', () => {
    const prompt = buildSystemPrompt(STUB_CONTEXT, ALL_ENABLED_FLAGS, SITE_URL);
    expect(prompt).not.toContain('{siteUrl}');
  });

  it('STATIC_HEADER and STATIC_FOOTER do NOT contain bare URLs outside FEATURES', () => {
    // §7 ADR-062 «Безопасность от регрессии»: если кто-то «по-быстрому»
    // дописал «See https://kingside.site/foo» в костяк — каталог
    // обходится в обход CI-чека. Этот тест ловит такие случаи.
    const header = __TESTING__.STATIC_HEADER(SITE_URL);
    const footer = __TESTING__.STATIC_FOOTER;

    const bareUrlsHeader = findBareUrlsExcludingRoot(header, SITE_URL);
    const bareUrlsFooter = findBareUrlsExcludingRoot(footer, SITE_URL);

    expect(bareUrlsHeader).toEqual(
      [], // если этот тест упал — нашлась голая ссылка в STATIC_HEADER
    );
    expect(bareUrlsFooter).toEqual(
      [], // если этот тест упал — нашлась голая ссылка в STATIC_FOOTER
    );

    // Сообщение «add it to FEATURES instead» — в jest reporter'е.
    if (bareUrlsHeader.length > 0 || bareUrlsFooter.length > 0) {
      throw new Error(
        `Bare URL(s) detected in STATIC_HEADER/FOOTER outside of FEATURES catalog. ` +
          `add it to FEATURES instead. ` +
          `Found: ${[...bareUrlsHeader, ...bareUrlsFooter].join(', ')}`,
      );
    }
  });

  it('catalog has at least one entry per major section (Precision, Drills, Studies, Mistakes, Lessons, Gamebook reader)', () => {
    const ids = new Set(FEATURES.map((f) => f.id));
    expect(ids).toContain('precision');
    expect(ids).toContain('drills');
    expect(ids).toContain('studies');
    expect(ids).toContain('mistakes');
    expect(ids).toContain('lessons');
    expect(ids).toContain('gamebook-reader');
  });

  it('Precision section is present and recommends the right URLs', () => {
    const prompt = buildSystemPrompt(STUB_CONTEXT, ALL_ENABLED_FLAGS, SITE_URL);
    expect(prompt).toContain(`${SITE_URL}/precision`);
    expect(prompt).toContain(`${SITE_URL}/precision/stats`);
    expect(prompt).toContain(`${SITE_URL}/precision/history`);
    expect(prompt).toContain(`${SITE_URL}/precision/attempts/:id`);
  });

  // ── KS-2966 / ADR-063 §5: slim-summary валидации ────────────────

  it('every summary is in [30..200] characters', () => {
    for (const f of FEATURES) {
      expect(typeof f.summary).toBe('string');
      expect(f.summary.length).toBeGreaterThanOrEqual(30);
      expect(f.summary.length).toBeLessThanOrEqual(200);
    }
  });

  it('every summary ends with a period (one sentence convention)', () => {
    for (const f of FEATURES) {
      expect(f.summary.endsWith('.')).toBe(true);
    }
  });

  it('summaries do not contain URLs or {siteUrl} placeholders (URLs live only in paths)', () => {
    for (const f of FEATURES) {
      expect(f.summary).not.toContain('{siteUrl}');
      expect(f.summary).not.toMatch(/https?:\/\//);
      expect(f.summary).not.toContain('kingside.site');
    }
  });

  it('summaries are unique across the catalog (sanity)', () => {
    const seen = new Map<string, string>();
    for (const f of FEATURES) {
      const dup = seen.get(f.summary);
      expect(dup).toBeUndefined();
      seen.set(f.summary, f.id);
    }
  });

  it('AssistantFeature shape: no legacy highlights / caveats fields on any record', () => {
    for (const f of FEATURES) {
      const bag = f as unknown as Record<string, unknown>;
      expect(bag.highlights).toBeUndefined();
      expect(bag.caveats).toBeUndefined();
    }
  });
});

/**
 * Возвращает все вхождения «голых» URL вида `${siteUrl}/<path>` или
 * `kingside.site/<path>` в строке, исключая чистый корень и сам siteUrl
 * как литерал без path-сегмента.
 */
function findBareUrlsExcludingRoot(text: string, siteUrl: string): string[] {
  const found: string[] = [];
  // Точные литералы siteUrl с path-сегментом (не корень).
  const literalRe = new RegExp(
    `${escapeRegex(siteUrl)}\\/[A-Za-z0-9_:/\\-]+`,
    'g',
  );
  for (const m of text.matchAll(literalRe)) {
    found.push(m[0]);
  }
  // Шаблон ${siteUrl}/...
  const tplRe = /\$\{siteUrl\}\/[A-Za-z0-9_:/\-]+/g;
  for (const m of text.matchAll(tplRe)) {
    found.push(m[0]);
  }
  // Голый «kingside.site/something».
  const bareRe = /kingside\.site\/[A-Za-z0-9_:/\-]+/g;
  for (const m of text.matchAll(bareRe)) {
    // Не считать совпадения, которые сами совпали с literalRe (избежать
    // двойного счёта одного и того же субдомена).
    if (text.includes(`https://${m[0]}`) || text.includes(`http://${m[0]}`)) {
      continue;
    }
    found.push(m[0]);
  }
  return found;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
