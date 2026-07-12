/**
 * KS-4882 / ADR-160 §4. Построение текста уведомления о занятии:
 * заголовок + список заданий с адресами разделов + ссылка на страницу
 * занятия. Чистые функции — модульно тестируются без Nest-контекста.
 */

/** Задание занятия в виде, достаточном для текста уведомления. */
export interface NotifiableTask {
  type: string;
  params: Record<string, unknown> | null;
  targetCount: number;
}

/** Переводчик: ключ внутри messages.json + аргументы подстановки. */
export type StudyTranslator = (
  key: string,
  args?: Record<string, string | number>,
) => string;

/** Относительный адрес раздела для типа задания (deep-link §4). */
export function taskPath(task: NotifiableTask): string {
  const params = task.params ?? {};
  switch (task.type) {
    case 'sm2_review':
      return '/lessons';
    case 'puzzle_theme': {
      const theme = typeof params.theme === 'string' ? params.theme : null;
      return theme ? `/puzzles?themes=${encodeURIComponent(theme)}` : '/puzzles';
    }
    case 'lesson': {
      const courseSlug = typeof params.courseSlug === 'string' ? params.courseSlug : null;
      const lessonId = typeof params.lessonId === 'string' ? params.lessonId : null;
      return courseSlug && lessonId ? `/lessons/${courseSlug}/${lessonId}` : '/lessons';
    }
    case 'mistakes':
      return '/puzzles/mistakes-practice';
    case 'precision':
      return '/precision';
    case 'drill':
      return '/drills';
    case 'rated_game':
      return '/play';
    case 'game_review':
      return '/archive';
    case 'puzzle_rush':
      return '/puzzle-rush';
    default:
      return '/study';
  }
}

/**
 * Однострочное описание задания на языке пользователя. Ключи —
 * `study.notification.taskLine.<type>` из tools/study-plan/texts.*.json
 * (KS-4910 / ADR-162 §3.2: тексты из данных, не из кода).
 */
export function taskLine(task: NotifiableTask, t: StudyTranslator): string {
  const params = task.params ?? {};
  const base = 'study.notification.taskLine';
  switch (task.type) {
    case 'puzzle_theme': {
      const theme = typeof params.theme === 'string' ? params.theme : null;
      return theme
        ? t(`${base}.puzzle_theme`, { count: task.targetCount, theme })
        : t(`${base}.puzzle_theme_mix`, { count: task.targetCount });
    }
    case 'external_games': {
      const provider = typeof params.provider === 'string' ? params.provider : 'lichess';
      return t(`${base}.external_games`, { count: task.targetCount, provider });
    }
    case 'lesson': {
      const lessonTitle =
        typeof params.themeLabel === 'string' ? params.themeLabel : '';
      return t(`${base}.lesson`, { lessonTitle });
    }
    case 'rated_game':
      return t(`${base}.rated_game`, { timeControl: 'blitz' });
    case 'puzzle_rush':
      return t(`${base}.puzzle_rush`, { target: task.targetCount });
    case 'sm2_review':
    case 'mistakes':
    case 'precision':
    case 'drill':
      return t(`${base}.${task.type}`, { count: task.targetCount });
    case 'game_review':
      return t(`${base}.game_review`);
    default:
      return task.type;
  }
}

/**
 * Текст Telegram-сообщения: заголовок, нумерованный список заданий со
 * ссылками, ссылка на страницу занятия. `origin` — схема+хост фронта.
 * Строки — из tools/study-plan/texts.*.json.
 */
export function buildTelegramText(
  tasks: NotifiableTask[],
  origin: string,
  t: StudyTranslator,
  opts?: { sessionMinutes?: number },
): string {
  const lines = [
    `♟ ${t('study.notification.title')}`,
    '',
    t('study.notification.intro', {
      taskCount: tasks.length,
      minutes: opts?.sessionMinutes ?? 30,
    }),
    ...tasks.map(
      (task, i) => `${i + 1}. ${taskLine(task, t)} — ${origin}${taskPath(task)}`,
    ),
    '',
    t('study.notification.openSession', { url: `${origin}/study` }),
  ];
  return lines.join('\n');
}
