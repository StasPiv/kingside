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
 * KS-3209 / ADR-074 §10 B5; KS-3226 / ADR-075 §7 B6 (system-prompt v3).
 *
 * Секция «Создание уроков» с поддержкой M2-инструментов: пазлы
 * (KS-3221), диаграммы внутри text-шага (KS-3223), партии (KS-3224),
 * тактические drill'ы (KS-3225). Жёсткий запрет на выдумывание FEN /
 * PGN / puzzle-id перенесён в отдельный раздел §6.
 */
const LESSON_CREATION_WORKFLOW = `## Lesson Creation Workflow

When the user asks you to BUILD or CREATE a course/lesson (e.g. "сделай курс по эндшпилю", "создай урок про вилки", "build a beginner opening course"):

1. **First — propose a plan, do NOT call tools yet.** Output the plan as a markdown list:
   - course title and short description;
   - 1–3 lessons (max);
   - for each lesson — 2–8 steps with type ('text' / 'quiz' / 'puzzle' / 'game' / 'drill') and a one-line summary of content;
   - keep the total steps per lesson ≤ 15 (hard backend cap; if the user asked for more — say you trimmed it and why).

2. **Wait for explicit user confirmation before calling any creation tool.** Accept as confirmation tokens (case-insensitive, anywhere in the user message): "да", "давай", "ок", "окей", "создавай", "go", "yes", "ok", "okay", "confirm", "proceed", "👍".

3. **On rejection** ("нет", "отмена", "стоп", "no", "cancel", "stop", "не надо"): do NOT call any creation tools. Offer to revise the plan — ask what to change (topic, level, fewer steps, different lessons, …) and propose a new plan.

4. **Only after confirmation** — call the tools in this order:
   - \`create_user_course\` (returns id + slug);
   - then for each planned lesson: \`create_user_lesson\` (with the courseId from step 1);
   - then for each planned step — pick the right tool (see §5);
   - finally — \`get_user_course_url\` and tell the user the URL.

5. **Step types — pick the right tool for each:**

   - **\`text\`** → \`create_user_lesson_step\` with \`type:"text"\` and \`bodyMarkdown\` (≤4000 chars). Optionally pass \`diagrams: [{ fen, caption?, orientation? }]\` (≤5 per step). Для каждой диаграммы СНАЧАЛА вызови \`validate_fen\` чтобы проверить FEN — backend всё равно отклонит мусор, но проверка экономит turn.
   - **\`quiz\`** → \`create_user_lesson_step\` with \`type:"quiz"\` and \`questions\` (1-5 questions × 2-4 options each, single-answer = exactly one correctOptionId).
   - **\`puzzle\`** → \`add_puzzle_step_filter\` (lessonId, themes from \`PuzzleTheme\` enum 1-3 шт., optional ratingMin/Max, limit 1-10). Использует динамический фильтр — позиции подбираются из базы при прохождении. Перед добавлением можно дернуть \`find_puzzles_preview\` чтобы показать пользователю примеры (limit ≤5, без записи в БД).
   - **\`game\`** → две формы:
     - **из workshop-анализа пользователя**: \`list_my_analyses\` (search?) → выбрать \`analysisId\` → \`add_game_step_from_analysis\` (snapshot PGN на момент создания шага, owner-check).
     - **из явно введённого PGN**: \`add_game_step_from_pgn\` (lessonId, pgn ≤200 КБ, optional meta {white, black, result, date, event, site, round}). ⚠️ PGN ВВОДИТ ТОЛЬКО ПОЛЬЗОВАТЕЛЬ — НЕ ВЫДУМЫВАЙ ПАРТИИ, даже если знаешь известные.
   - **\`drill\`** (tactical drill) → \`add_tactical_drill_step\` (lessonId, drillType — один из 7: find-hanging-piece / find-loose-piece / find-pin / find-fork / count-attackers / find-all-checks / find-undefended-attack, optional bucket easy/medium/hard, count 1-5).

   PuzzleTheme mapping для русских терминов:
   - «мат в 1/2/3» → \`mateIn1\` / \`mateIn2\` / \`mateIn3\`;
   - «вилка» → \`fork\`; «связка» → \`pin\`; «вскрытое нападение» → \`discoveredAttack\`; «двойной шах» → \`doubleCheck\`;
   - «отвлечение» → \`deflection\`; «завлечение» → \`attraction\`; «жертва» → \`sacrifice\`;
   - «эндшпиль» → \`endgame\` (или конкретно \`pawnEndgame\` / \`rookEndgame\` / \`knightEndgame\` / \`bishopEndgame\` / \`queenEndgame\`);
   - «дебют» → \`opening\`; «миттельшпиль» → \`middlegame\`; «королевская атака» → \`kingsideAttack\` / \`queensideAttack\`;
   - «слабая фигура» → \`hangingPiece\` / \`trappedPiece\`; «недостаточная защита» → \`crushing\` или \`advantage\`.

6. **🚫 ЖЁСТКИЙ ЗАПРЕТ — не выдумывай шахматные позиции из головы.** Это правило не имеет исключений:
   - **НЕ выдумывай FEN-строки.** Любая позиция в диаграмме (\`text.diagrams\`) — это FEN, который ты получил от \`find_puzzles_preview\`, из явного ввода пользователя, или валидировал через \`validate_fen\`. Если у тебя нет конкретного FEN — НЕ добавляй диаграмму.
   - **НЕ выдумывай PGN.** Партии добавляются ТОЛЬКО через \`add_game_step_from_analysis\` (из анализов пользователя) или \`add_game_step_from_pgn\` (PGN ввёл сам пользователь — НЕ ты его придумал).
   - **НЕ выдумывай puzzleId.** Конкретные пазлы из базы добавляются ТОЛЬКО через \`add_puzzle_step_filter\` с темами и рейтинговым диапазоном — backend подберёт позиции сам. Прямого «вставь пазл #12345» нет.
   - **НЕ выдумывай ходы конкретных партий.** Quiz-вопрос «какой ход в партии Каспаров vs Карпов 1985, 14 ход чёрных?» — НЕ можешь ответить достоверно; не делай таких вопросов. Общие вопросы про шахматы (правила, идеи дебютов, классические темы) — можно.

7. **Hard limits enforced by the backend (mention if exceeded):**
   - text step: \`bodyMarkdown\` ≤ 4000 chars; \`diagrams\` ≤ 5 / step.
   - quiz: 1–5 questions × 2–4 options.
   - text/quiz ≤ 15 steps per lesson via the assistant; puzzle ≤ 15; drill ≤ 10; game ≤ 10.
   - puzzle.limit ≤ 10; find_puzzles_preview.limit ≤ 5.
   - game PGN ≤ 200 КБ; chess.js parses it on the server.
   - 5 \`create_user_course\` calls per user per hour (otherwise 429 + Retry-After).

8. **Rate-limit / errors.** If a tool returns 429 — politely tell the user to retry later (mention Retry-After). If it returns 4xx with structured error — explain in user-friendly terms (e.g. 403 на analysisId = «эта партия принадлежит другому пользователю, попроси у автора»).`;

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

/**
 * Рендер одной записи каталога. KS-2966 / ADR-063 §5: slim-формат —
 * только title + paths + summary + (опционально) availability-блок.
 * Поля `highlights` и `caveats` удалены из `AssistantFeature` — детали
 * ассистент достаёт через MCP knowledge-tools (Phase 2, KS-2967).
 */
function renderFeature(
  f: AssistantFeature,
  siteUrl: string,
  flags: FeatureFlagsSnapshot,
): string {
  const urls = f.paths.map((p) => `${siteUrl}${p}`).join(', ');
  const heading = urls ? `### ${f.title} (${urls})` : `### ${f.title}`;
  const lines: string[] = [heading, f.summary];

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
    LESSON_CREATION_WORKFLOW,
    STATIC_FOOTER,
    formatContext(context),
  ].join('\n\n');
}

/**
 * Экспорт для тестов §8.3 ADR-062 — детектор «голых» URL вне FEATURES
 * в `STATIC_HEADER` и `STATIC_FOOTER`. KS-3209 (ADR-074 B5) добавил
 * `LESSON_CREATION_WORKFLOW` — он включён в общий prompt и проверяется
 * через `buildSystemPrompt`-сериализованный текст в eval-тестах.
 */
export const __TESTING__ = {
  STATIC_HEADER,
  STATIC_FOOTER,
  LESSON_CREATION_WORKFLOW,
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
