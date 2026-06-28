-- KS-4763: seed hints в test-стек (правила из KS-4753/rules.json).
-- Идемпотентно через ON CONFLICT (key).

INSERT INTO events.hints
  (key, i18n, cta, anchor, placement, rule, priority, enabled,
   accepted_by, target_actor_types, cooldown_sec, ttl_sec, max_shows)
VALUES
  ('guest-register-prompt', '{"ru": {"title": "Сохрани свой прогресс", "body": "30 секунд на регистрацию — и у тебя будут рейтинг, история партий и статистика тактики.", "ctaLabel": "Создать аккаунт"}, "en": {"title": "Save your progress", "body": "Sign up in 30 seconds and keep your rating, game history and tactics stats.", "ctaLabel": "Create account"}}'::jsonb, '{"href": "/register"}'::jsonb, 'landing-signup-button', 'bottom', '{"all": [{"actorType": {"equals": "guest"}}, {"page": {"matches": "/"}}, {"count": {"event": "guest_landing_viewed", "windowMin": 5, "gte": 1}}, {"not": {"exists": {"event": "guest_signup_form_opened", "windowDays": 1}}}]}'::jsonb,
   60, true, ARRAY['guest_signup_form_opened']::VARCHAR(64)[], ARRAY['guest']::VARCHAR(64)[],
   86400, 0, 4)
ON CONFLICT (key) DO UPDATE SET
  i18n = EXCLUDED.i18n, cta = EXCLUDED.cta, anchor = EXCLUDED.anchor,
  placement = EXCLUDED.placement, rule = EXCLUDED.rule,
  priority = EXCLUDED.priority, enabled = EXCLUDED.enabled,
  accepted_by = EXCLUDED.accepted_by, target_actor_types = EXCLUDED.target_actor_types,
  cooldown_sec = EXCLUDED.cooldown_sec, ttl_sec = EXCLUDED.ttl_sec,
  max_shows = EXCLUDED.max_shows, deleted_at = NULL, updated_at = now();

INSERT INTO events.hints
  (key, i18n, cta, anchor, placement, rule, priority, enabled,
   accepted_by, target_actor_types, cooldown_sec, ttl_sec, max_shows)
VALUES
  ('guest-play-friction', '{"ru": {"title": "Чтобы играть с соперниками — нужен аккаунт", "body": "Регистрация занимает 30 секунд, и у тебя сразу появятся подбор по рейтингу и история партий.", "ctaLabel": "Зарегистрироваться"}, "en": {"title": "To play opponents, you need an account", "body": "Signup takes 30 seconds and unlocks rating-based matchmaking and your game history.", "ctaLabel": "Sign up"}}'::jsonb, '{"href": "/register"}'::jsonb, 'landing-signup-button', 'bottom', '{"all": [{"actorType": {"equals": "guest"}}, {"page": {"matches": "/"}}, {"count": {"event": "guest_play_attempted", "windowHours": 1, "gte": 2}}]}'::jsonb,
   70, true, ARRAY['guest_signup_form_opened']::VARCHAR(64)[], ARRAY['guest']::VARCHAR(64)[],
   21600, 0, 5)
ON CONFLICT (key) DO UPDATE SET
  i18n = EXCLUDED.i18n, cta = EXCLUDED.cta, anchor = EXCLUDED.anchor,
  placement = EXCLUDED.placement, rule = EXCLUDED.rule,
  priority = EXCLUDED.priority, enabled = EXCLUDED.enabled,
  accepted_by = EXCLUDED.accepted_by, target_actor_types = EXCLUDED.target_actor_types,
  cooldown_sec = EXCLUDED.cooldown_sec, ttl_sec = EXCLUDED.ttl_sec,
  max_shows = EXCLUDED.max_shows, deleted_at = NULL, updated_at = now();

INSERT INTO events.hints
  (key, i18n, cta, anchor, placement, rule, priority, enabled,
   accepted_by, target_actor_types, cooldown_sec, ttl_sec, max_shows)
VALUES
  ('puzzle-comeback-after-week', '{"ru": {"title": "Не решал пазлы неделю", "body": "Тактический рейтинг тает быстро. Пять минут на разминку — и форма вернётся.", "ctaLabel": "К пазлам"}, "en": {"title": "No puzzles for a week", "body": "Tactical rating fades fast. Five minutes of practice will bring your shape back.", "ctaLabel": "Open puzzles"}}'::jsonb, '{"href": "/puzzles"}'::jsonb, 'home-puzzles-tile', 'right', '{"all": [{"actorType": {"equals": "user"}}, {"any": [{"page": {"matches": "/play"}}, {"page": {"matches": "/play/*"}}]}, {"timeSince": {"event": "puzzle_start", "gtDays": 7}}]}'::jsonb,
   40, true, ARRAY['puzzle_start']::VARCHAR(64)[], ARRAY['user']::VARCHAR(64)[],
   172800, 0, 4)
ON CONFLICT (key) DO UPDATE SET
  i18n = EXCLUDED.i18n, cta = EXCLUDED.cta, anchor = EXCLUDED.anchor,
  placement = EXCLUDED.placement, rule = EXCLUDED.rule,
  priority = EXCLUDED.priority, enabled = EXCLUDED.enabled,
  accepted_by = EXCLUDED.accepted_by, target_actor_types = EXCLUDED.target_actor_types,
  cooldown_sec = EXCLUDED.cooldown_sec, ttl_sec = EXCLUDED.ttl_sec,
  max_shows = EXCLUDED.max_shows, deleted_at = NULL, updated_at = now();

INSERT INTO events.hints
  (key, i18n, cta, anchor, placement, rule, priority, enabled,
   accepted_by, target_actor_types, cooldown_sec, ttl_sec, max_shows)
VALUES
  ('home-idle-suggest-puzzles', '{"ru": {"title": "Задержался в лобби", "body": "Не знаешь чем заняться? Пазлы — самый быстрый способ занять 5 минут с пользой для рейтинга.", "ctaLabel": "Решить пазл"}, "en": {"title": "Lingering in the lobby?", "body": "Not sure what to do? Puzzles are the quickest way to spend five minutes on something rating-positive.", "ctaLabel": "Solve a puzzle"}}'::jsonb, '{"href": "/puzzles"}'::jsonb, 'home-puzzles-tile', 'right', '{"all": [{"actorType": {"equals": "user"}}, {"page": {"matches": "/play"}}, {"count": {"event": "session_idle", "where": {"page": "/play"}, "windowMin": 5, "gte": 1}}]}'::jsonb,
   30, true, ARRAY['puzzle_start']::VARCHAR(64)[], ARRAY['user']::VARCHAR(64)[],
   86400, 30, 3)
ON CONFLICT (key) DO UPDATE SET
  i18n = EXCLUDED.i18n, cta = EXCLUDED.cta, anchor = EXCLUDED.anchor,
  placement = EXCLUDED.placement, rule = EXCLUDED.rule,
  priority = EXCLUDED.priority, enabled = EXCLUDED.enabled,
  accepted_by = EXCLUDED.accepted_by, target_actor_types = EXCLUDED.target_actor_types,
  cooldown_sec = EXCLUDED.cooldown_sec, ttl_sec = EXCLUDED.ttl_sec,
  max_shows = EXCLUDED.max_shows, deleted_at = NULL, updated_at = now();

INSERT INTO events.hints
  (key, i18n, cta, anchor, placement, rule, priority, enabled,
   accepted_by, target_actor_types, cooldown_sec, ttl_sec, max_shows)
VALUES
  ('discover-puzzle-rush', '{"ru": {"title": "Понравились пазлы?", "body": "Попробуй Puzzle Rush — гонка на время, рейтинг по результату. Хороший разогрев перед партией.", "ctaLabel": "Запустить Rush"}, "en": {"title": "Enjoying puzzles?", "body": "Try Puzzle Rush — a timed sprint with its own rating. A great warm-up before a real game.", "ctaLabel": "Start Rush"}}'::jsonb, '{"href": "/puzzle-rush"}'::jsonb, 'puzzles-rush-tab', 'bottom', '{"all": [{"actorType": {"equals": "user"}}, {"any": [{"page": {"matches": "/puzzles"}}, {"page": {"matches": "/puzzles/*"}}]}, {"count": {"event": "puzzle_solved", "windowDays": 30, "gte": 10}}, {"not": {"exists": {"event": "rush_start", "windowDays": 30}}}]}'::jsonb,
   50, true, ARRAY['rush_start']::VARCHAR(64)[], ARRAY['user']::VARCHAR(64)[],
   604800, 0, 3)
ON CONFLICT (key) DO UPDATE SET
  i18n = EXCLUDED.i18n, cta = EXCLUDED.cta, anchor = EXCLUDED.anchor,
  placement = EXCLUDED.placement, rule = EXCLUDED.rule,
  priority = EXCLUDED.priority, enabled = EXCLUDED.enabled,
  accepted_by = EXCLUDED.accepted_by, target_actor_types = EXCLUDED.target_actor_types,
  cooldown_sec = EXCLUDED.cooldown_sec, ttl_sec = EXCLUDED.ttl_sec,
  max_shows = EXCLUDED.max_shows, deleted_at = NULL, updated_at = now();

INSERT INTO events.hints
  (key, i18n, cta, anchor, placement, rule, priority, enabled,
   accepted_by, target_actor_types, cooldown_sec, ttl_sec, max_shows)
VALUES
  ('rush-streak-recovery', '{"ru": {"title": "Серия сбивается слишком часто", "body": "Темп выше комфортного. Попробуй сбавить — переключись на классические пазлы и вернись с разогретой тактикой.", "ctaLabel": "К обычным пазлам"}, "en": {"title": "Streak keeps breaking", "body": "The pace is above your comfort zone. Switch to regular puzzles, warm up tactics and come back stronger.", "ctaLabel": "Regular puzzles"}}'::jsonb, '{"href": "/puzzles"}'::jsonb, 'puzzles-rush-tab', 'bottom', '{"all": [{"actorType": {"equals": "user"}}, {"any": [{"page": {"matches": "/puzzles"}}, {"page": {"matches": "/puzzles/*"}}]}, {"count": {"event": "rush_streak_broken", "windowHours": 24, "gte": 2}}]}'::jsonb,
   35, true, ARRAY['puzzle_start']::VARCHAR(64)[], ARRAY['user']::VARCHAR(64)[],
   86400, 0, 3)
ON CONFLICT (key) DO UPDATE SET
  i18n = EXCLUDED.i18n, cta = EXCLUDED.cta, anchor = EXCLUDED.anchor,
  placement = EXCLUDED.placement, rule = EXCLUDED.rule,
  priority = EXCLUDED.priority, enabled = EXCLUDED.enabled,
  accepted_by = EXCLUDED.accepted_by, target_actor_types = EXCLUDED.target_actor_types,
  cooldown_sec = EXCLUDED.cooldown_sec, ttl_sec = EXCLUDED.ttl_sec,
  max_shows = EXCLUDED.max_shows, deleted_at = NULL, updated_at = now();

INSERT INTO events.hints
  (key, i18n, cta, anchor, placement, rule, priority, enabled,
   accepted_by, target_actor_types, cooldown_sec, ttl_sec, max_shows)
VALUES
  ('mistakes-diary-after-failures', '{"ru": {"title": "Накопились ошибки в пазлах", "body": "Посмотри их в «Дневнике ошибок» — там видно повторяющиеся паттерны, на которых ты застреваешь.", "ctaLabel": "Открыть дневник"}, "en": {"title": "Puzzle mistakes are piling up", "body": "Open the Mistakes Diary — it highlights the recurring patterns where you stumble.", "ctaLabel": "Open diary"}}'::jsonb, '{"href": "/mistakes"}'::jsonb, 'profile-mistakes-link', 'right', '{"all": [{"actorType": {"equals": "user"}}, {"any": [{"page": {"matches": "/player/*"}}, {"page": {"matches": "/player/*/*"}}]}, {"count": {"event": "puzzle_failed", "windowDays": 7, "gte": 5}}, {"not": {"exists": {"event": "feature_used", "where": {"feature_key": "mistakes_diary_opened"}, "windowDays": 30}}}]}'::jsonb,
   55, true, ARRAY['feature_used']::VARCHAR(64)[], ARRAY['user']::VARCHAR(64)[],
   259200, 0, 3)
ON CONFLICT (key) DO UPDATE SET
  i18n = EXCLUDED.i18n, cta = EXCLUDED.cta, anchor = EXCLUDED.anchor,
  placement = EXCLUDED.placement, rule = EXCLUDED.rule,
  priority = EXCLUDED.priority, enabled = EXCLUDED.enabled,
  accepted_by = EXCLUDED.accepted_by, target_actor_types = EXCLUDED.target_actor_types,
  cooldown_sec = EXCLUDED.cooldown_sec, ttl_sec = EXCLUDED.ttl_sec,
  max_shows = EXCLUDED.max_shows, deleted_at = NULL, updated_at = now();

INSERT INTO events.hints
  (key, i18n, cta, anchor, placement, rule, priority, enabled,
   accepted_by, target_actor_types, cooldown_sec, ttl_sec, max_shows)
VALUES
  ('hint-overuse-mistakes-diary', '{"ru": {"title": "Часто нажимаешь «Подсказка» в пазлах", "body": "В «Дневнике ошибок» собраны темы, где ты застреваешь — точечная тренировка эффективнее, чем подсказки на ходу.", "ctaLabel": "К дневнику"}, "en": {"title": "Using hints a lot in puzzles", "body": "The Mistakes Diary groups topics where you get stuck — targeted training beats hint-spamming.", "ctaLabel": "Open diary"}}'::jsonb, '{"href": "/mistakes"}'::jsonb, 'profile-mistakes-link', 'right', '{"all": [{"actorType": {"equals": "user"}}, {"page": {"matches": "/player/*/*"}}, {"count": {"event": "hint_used", "windowDays": 7, "gte": 5}}, {"not": {"exists": {"event": "feature_used", "where": {"feature_key": "mistakes_diary_opened"}, "windowDays": 30}}}]}'::jsonb,
   50, true, ARRAY['feature_used']::VARCHAR(64)[], ARRAY['user']::VARCHAR(64)[],
   259200, 0, 3)
ON CONFLICT (key) DO UPDATE SET
  i18n = EXCLUDED.i18n, cta = EXCLUDED.cta, anchor = EXCLUDED.anchor,
  placement = EXCLUDED.placement, rule = EXCLUDED.rule,
  priority = EXCLUDED.priority, enabled = EXCLUDED.enabled,
  accepted_by = EXCLUDED.accepted_by, target_actor_types = EXCLUDED.target_actor_types,
  cooldown_sec = EXCLUDED.cooldown_sec, ttl_sec = EXCLUDED.ttl_sec,
  max_shows = EXCLUDED.max_shows, deleted_at = NULL, updated_at = now();

-- KS-4765 / T6. Добавлены 3 правила, которых не было в исходном rules.json:
-- bridge-promo-after-3-wasm, guest-try-puzzles, guest-features-discovery.
-- DSL/anchor/placement/priority/targetActorTypes — точные значения из dev-БД
-- (см. /tmp/KS-4753/active.json + apps/api/test/hints-fixtures/*.ts).
-- Тексты i18n.body/ctaLabel/cta.href и meta (cooldownSec/maxShows/acceptedBy)
-- — плейсхолдеры для test-стека: e2e-suite ассертит только селектор
-- [data-hint-popover][data-hint-key=<key>], текст popover'а не проверяется.

INSERT INTO events.hints
  (key, i18n, cta, anchor, placement, rule, priority, enabled,
   accepted_by, target_actor_types, cooldown_sec, ttl_sec, max_shows)
VALUES
  ('bridge-promo-after-3-wasm', '{"ru": {"title": "Хотите быстрее?", "body": "Установите десктоп-приложение с bridge-движком — анализ без задержки wasm.", "ctaLabel": "Подробнее"}, "en": {"title": "Want it faster?", "body": "Install the desktop app with bridge engine — analysis without wasm latency.", "ctaLabel": "Learn more"}}'::jsonb, '{"href": "/analysis"}'::jsonb, 'analysis-bridge-promo', 'top', '{"all": [{"any": [{"page": {"matches": "/analysis"}}, {"page": {"matches": "/analysis/*"}}]}, {"count": {"event": "engine_started", "where": {"source": "wasm"}, "windowDays": 30, "gte": 3}}, {"not": {"exists": {"event": "engine_started", "where": {"source": "bridge"}, "windowDays": 30}}}]}'::jsonb,
   50, true, ARRAY[]::VARCHAR(64)[], ARRAY['user']::VARCHAR(64)[],
   604800, 0, 3)
ON CONFLICT (key) DO UPDATE SET
  i18n = EXCLUDED.i18n, cta = EXCLUDED.cta, anchor = EXCLUDED.anchor,
  placement = EXCLUDED.placement, rule = EXCLUDED.rule,
  priority = EXCLUDED.priority, enabled = EXCLUDED.enabled,
  accepted_by = EXCLUDED.accepted_by, target_actor_types = EXCLUDED.target_actor_types,
  cooldown_sec = EXCLUDED.cooldown_sec, ttl_sec = EXCLUDED.ttl_sec,
  max_shows = EXCLUDED.max_shows, deleted_at = NULL, updated_at = now();

INSERT INTO events.hints
  (key, i18n, cta, anchor, placement, rule, priority, enabled,
   accepted_by, target_actor_types, cooldown_sec, ttl_sec, max_shows)
VALUES
  ('guest-try-puzzles', '{"ru": {"title": "Попробуй пазлы без регистрации", "body": "Тактическая разминка в один клик — без аккаунта и сохранения прогресса.", "ctaLabel": "Открыть пазлы"}, "en": {"title": "Try puzzles without signing up", "body": "One-click tactical warm-up — no account, no progress saving.", "ctaLabel": "Open puzzles"}}'::jsonb, '{"href": "/puzzles"}'::jsonb, 'landing-puzzles-tile', 'top', '{"all": [{"actorType": {"equals": "guest"}}, {"page": {"matches": "/"}}, {"count": {"event": "guest_landing_viewed", "windowMin": 10, "gte": 2}}, {"not": {"exists": {"event": "guest_puzzle_attempted"}}}]}'::jsonb,
   50, true, ARRAY['guest_puzzle_attempted']::VARCHAR(64)[], ARRAY['guest']::VARCHAR(64)[],
   86400, 0, 3)
ON CONFLICT (key) DO UPDATE SET
  i18n = EXCLUDED.i18n, cta = EXCLUDED.cta, anchor = EXCLUDED.anchor,
  placement = EXCLUDED.placement, rule = EXCLUDED.rule,
  priority = EXCLUDED.priority, enabled = EXCLUDED.enabled,
  accepted_by = EXCLUDED.accepted_by, target_actor_types = EXCLUDED.target_actor_types,
  cooldown_sec = EXCLUDED.cooldown_sec, ttl_sec = EXCLUDED.ttl_sec,
  max_shows = EXCLUDED.max_shows, deleted_at = NULL, updated_at = now();

INSERT INTO events.hints
  (key, i18n, cta, anchor, placement, rule, priority, enabled,
   accepted_by, target_actor_types, cooldown_sec, ttl_sec, max_shows)
VALUES
  ('guest-features-discovery', '{"ru": {"title": "Посмотри, что мы умеем", "body": "Пазлы, рейтинговые партии, обзор сыгранного — всё в одном месте.", "ctaLabel": "Посмотреть возможности"}, "en": {"title": "See what we can do", "body": "Puzzles, rated games, post-game analysis — all in one place.", "ctaLabel": "Explore features"}}'::jsonb, '{"href": "/features"}'::jsonb, 'landing-features-block', 'top', '{"all": [{"actorType": {"equals": "guest"}}, {"page": {"matches": "/"}}, {"count": {"event": "guest_landing_viewed", "windowDays": 7, "gte": 3}}, {"not": {"exists": {"event": "guest_signup_form_opened", "windowDays": 7}}}]}'::jsonb,
   25, true, ARRAY['guest_signup_form_opened']::VARCHAR(64)[], ARRAY['guest']::VARCHAR(64)[],
   86400, 0, 3)
ON CONFLICT (key) DO UPDATE SET
  i18n = EXCLUDED.i18n, cta = EXCLUDED.cta, anchor = EXCLUDED.anchor,
  placement = EXCLUDED.placement, rule = EXCLUDED.rule,
  priority = EXCLUDED.priority, enabled = EXCLUDED.enabled,
  accepted_by = EXCLUDED.accepted_by, target_actor_types = EXCLUDED.target_actor_types,
  cooldown_sec = EXCLUDED.cooldown_sec, ttl_sec = EXCLUDED.ttl_sec,
  max_shows = EXCLUDED.max_shows, deleted_at = NULL, updated_at = now();

-- Загружено правил: 11
