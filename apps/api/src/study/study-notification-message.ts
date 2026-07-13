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

/** Однострочное описание задания на языке пользователя. */
export function taskLine(task: NotifiableTask, t: StudyTranslator): string {
  const params = task.params ?? {};
  switch (task.type) {
    case 'puzzle_theme': {
      const theme = typeof params.theme === 'string' ? params.theme : null;
      return theme
        ? t('study.task.puzzle_theme', { count: task.targetCount, theme })
        : t('study.task.puzzle_theme_mix', { count: task.targetCount });
    }
    case 'external_games': {
      const provider = typeof params.provider === 'string' ? params.provider : 'lichess';
      return t('study.task.external_games', { count: task.targetCount, provider });
    }
    case 'sm2_review':
    case 'mistakes':
    case 'precision':
    case 'drill':
    case 'puzzle_rush':
      return t(`study.task.${task.type}`, { count: task.targetCount });
    case 'lesson':
    case 'rated_game':
    case 'game_review':
      return t(`study.task.${task.type}`);
    default:
      return task.type;
  }
}

/**
 * Текст Telegram-сообщения: заголовок, нумерованный список заданий со
 * ссылками, ссылка на страницу занятия. `origin` — схема+хост фронта.
 *
 * KS-4927 / ADR-163 §5: `scheduleName` — имя тренировки в заголовке
 * («какое из моих занятий пришло»); пустая строка → заголовок без имени.
 */
export function buildTelegramText(
  tasks: NotifiableTask[],
  origin: string,
  t: StudyTranslator,
  scheduleName = '',
): string {
  const title = scheduleName.trim()
    ? `♟ ${t('study.notification.title')} — ${scheduleName.trim()}`
    : `♟ ${t('study.notification.title')}`;
  const lines = [
    title,
    '',
    t('study.notification.intro'),
    ...tasks.map(
      (task, i) => `${i + 1}. ${taskLine(task, t)} — ${origin}${taskPath(task)}`,
    ),
    '',
    `${t('study.notification.openSession')}: ${origin}/study`,
  ];
  return lines.join('\n');
}
