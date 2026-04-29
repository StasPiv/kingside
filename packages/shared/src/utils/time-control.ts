export type TimeControlCategory = 'bullet' | 'blitz' | 'rapid' | 'classical';

/**
 * Категория контроля времени для архивных партий: к четырём базовым
 * добавлен `unknown` — для PGN-партий без `[TimeControl]` или с
 * нераспознанной формой (`-`, `?`, correspondence и т. п.).
 *
 * KS-2118: используется в `ArchiveGameSummary.timeControlCategory`
 * и в фильтре `timeControlCategory` на эндпоинтах `/games`,
 * `/players/:slug/games`.
 */
export type ArchiveTimeControlCategory = TimeControlCategory | 'unknown';

/**
 * Classify time control based on initial time and increment.
 * Formula: totalTime = initialSec + 40 * incrementSec
 *   - bullet: totalTime < 180
 *   - blitz: 180 <= totalTime < 600
 *   - rapid: 600 <= totalTime < 3600
 *   - classical: totalTime >= 3600
 */
export function classifyTimeControl(
  initialSec: number,
  incrementSec: number,
): TimeControlCategory {
  const totalTime = initialSec + 40 * incrementSec;

  if (totalTime < 180) return 'bullet';
  if (totalTime < 600) return 'blitz';
  if (totalTime < 3600) return 'rapid';
  return 'classical';
}

/**
 * KS-2118. Классификация PGN-тега `TimeControl` в одну из 5 категорий
 * (`bullet | blitz | rapid | classical | unknown`) для архивных партий.
 *
 * Поддержанные формы (PGN Standard + de-facto TWIC/Lichess):
 *   - `5400+30`, `60+0`, `180+1`            — sudden death + инкремент
 *   - `5400`                                — sudden death без инкремента
 *   - `40/7200`                             — этап `N ходов / X секунд`
 *   - `40/7200:1800+30`                     — составной (только первая фаза)
 *   - `40/7200+30:3600+30`                  — этапы с инкрементом
 *   - `-`, `?`, `null`, пустая строка       — `unknown`
 *   - `1/86400` (correspondence) и любая нераспознанная форма → `unknown`
 *
 * Семантика: для составных контролей категорию определяем по ПЕРВОЙ фазе
 * (как в ChessBase). Для простых — берём весь base. Дальше применяем
 * {@link classifyTimeControl} (база + 40·инкремент).
 */
export function classifyPgnTimeControl(
  tc: string | null | undefined,
): ArchiveTimeControlCategory {
  if (tc == null) return 'unknown';
  const trimmed = tc.trim();
  if (trimmed === '' || trimmed === '-' || trimmed === '?') return 'unknown';

  // Составной контроль — берём только первую фазу (до первого `:`).
  const firstStage = trimmed.split(':')[0];
  if (!firstStage) return 'unknown';

  // `1/86400` и любые `1/N` где N >= 86400 — correspondence → unknown.
  const correspondence = firstStage.match(/^(\d+)\/(\d+)$/);
  if (correspondence) {
    const moves = parseInt(correspondence[1]!, 10);
    const seconds = parseInt(correspondence[2]!, 10);
    if (moves === 1 && seconds >= 86400) return 'unknown';
    // Иначе `N/X` трактуем как «N ходов за X секунд» — без инкремента.
    if (Number.isFinite(seconds)) {
      return classifyTimeControl(seconds, 0);
    }
    return 'unknown';
  }

  // `N/X+Y` — этап с инкрементом.
  const stageWithInc = firstStage.match(/^(\d+)\/(\d+)\+(\d+)$/);
  if (stageWithInc) {
    return classifyTimeControl(
      parseInt(stageWithInc[2]!, 10),
      parseInt(stageWithInc[3]!, 10),
    );
  }

  // `X+Y` — sudden death с инкрементом.
  const suddenInc = firstStage.match(/^(\d+)\+(\d+)$/);
  if (suddenInc) {
    return classifyTimeControl(
      parseInt(suddenInc[1]!, 10),
      parseInt(suddenInc[2]!, 10),
    );
  }

  // `X` — sudden death без инкремента.
  const onlyBase = firstStage.match(/^(\d+)$/);
  if (onlyBase) {
    return classifyTimeControl(parseInt(onlyBase[1]!, 10), 0);
  }

  return 'unknown';
}

// ─── KS-2131. Эвристика по Event для категорий ────────────────────────────
//
// Контекст: TWIC-партии и ряд chess.com/lichess-выгрузок приходят без тега
// `[TimeControl]` или с `-`. По одному только PGN-тегу
// `classifyPgnTimeControl` ставит таким партиям `unknown` — а пользователь
// ожидает увидеть, например, Titled Tuesday в `blitz`. Полное решение
// (с учётом Site/Event blacklist'ов TWIC vs online-партий) живёт в
// `apps/archive-service/src/archive-import/classify.ts::deriveArchiveTimeControlCategory`,
// потому что требует знания `GameCategory` и Site, а не только PGN-тега.
//
// Здесь экспортируется лишь список ключевых слов в `Event`, чтобы
// миграция-backfill (SQL CASE по `event ILIKE …`) и runtime-классификатор
// archive-service использовали один и тот же словарь. Любое изменение
// списков требует новой миграции backfill для уже импортированных партий
// (см. ADR-015).

/** Подстроки в `Event`, однозначно указывающие на bullet (KS-2131). */
const EVENT_BULLET_HINTS = [
  'bullet brawl',
  'hourly bullet',
  'bullet arena',
  'bullet',
];

/**
 * Подстроки в `Event`, однозначно указывающие на blitz (KS-2131).
 *
 * Заметка о `titled tue` (а не `titled tuesday`): TWIC хранит сокращённую
 * форму вроде `Titled Tue 17th Jun Early`, `Titled Tue 23rd Sep 2025`.
 * Подстрока `titled tue` покрывает и полную (`Titled Tuesday Blitz`),
 * и сокращённую формы. Замена `titled tuesday → titled tue` сделана в
 * KS-2131-fix после обнаружения 113 609 партий `Titled Tue …` в проде,
 * которые после первого деплоя ушли в `unknown`.
 *
 * KS-2133. Добавлены:
 *   - `' 3-0 thu'` (с ведущим пробелом) — chess.com weekly-серия
 *     `1st/2nd/3rd 3-0 Thu …` / `1st 3-0 Thursday …` (3+0 = блиц).
 *     Покрыло 41 020 партий из `unknown` на проде, у всех PGN-тег TC = NULL.
 *     Ведущий пробел отсекает ложные срабатывания на счёт партии типа
 *     `3-0` в начале event-строки.
 *   - `'speedchess'` (slitno) — chess.com SpeedChess Championship хранит
 *     event'ом `chess.com SpeedChess 2025`. Существующий `'speed chess'`
 *     (с пробелом) такие не ловит. 287 партий.
 */
const EVENT_BLITZ_HINTS = [
  'titled tue',
  'titled cup',
  'blitz arena',
  'arena titled',
  'speed chess',
  'speedchess',
  ' 3-0 thu',
  'blitz',
];

/**
 * Подстроки в `Event`, однозначно указывающие на rapid (KS-2150).
 *
 * Devops snapshot подтвердил безопасность generic-keyword `'rapid'`:
 * 12 863 партии с `event ILIKE '%rapid%'` и `time_control_category=classical`
 * имеют `time_control = NULL` (TWIC не пишет PGN-тег для рапид-турниров →
 * fallback в classical). Topology турниров: World Rapid 2025, European
 * Rapid, FIDE Rapid Team, ch-RUS Rapid, Biel Rapid Open, etc. Дополнительный
 * хинт `'rapidplay'` — британский формат (British Rapidplay, 1 100 партий).
 *
 * False positives на `'rapid'` не найдено: SQL `event ILIKE '%rapid%'
 * AND time_control SIMILAR TO '[5-9][0-9]+%'` (классический контроль) — 0
 * строк. Generic safe.
 */
const EVENT_RAPID_HINTS = [
  'rapidplay',
  'rapid',
];

/**
 * KS-2131. Подстроки `Event`-эвристик — экспортированы для миграции-backfill
 * и runtime-классификатора archive-service. Bullet проверяется раньше blitz,
 * blitz раньше rapid — для `Titled Tuesday Bullet Brawl` ожидаем bullet
 * (а generic-keyword `blitz` сматчился бы вторым), для `4th CHN Rapid/Blitz
 * 2025` (KS-2150) ожидаем blitz (а generic-keyword `rapid` сматчился бы
 * третьим). Все сравнения case-insensitive в потребителях.
 *
 * Любое изменение здесь требует новой миграции backfill (ADR-015).
 *
 * KS-2150 фаза 2: Event override применяется ВСЕГДА, не только для
 * `online-unknown` category — TWIC даёт `time_control=NULL` для большинства
 * рапид/блиц турниров, и старая логика «PGN-тег приоритетнее» оставляла
 * 24 791 партию ошибочно в classical (см. devops-snapshot KS-2150).
 */
export const ARCHIVE_TIME_CONTROL_EVENT_HINTS = {
  bullet: EVENT_BULLET_HINTS,
  blitz: EVENT_BLITZ_HINTS,
  rapid: EVENT_RAPID_HINTS,
} as const;
