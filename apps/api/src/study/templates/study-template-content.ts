/**
 * KS-4911 / ADR-162. Наполнение шаблонных курсов занятий
 * `study-template-<shelf>` для ленивого сидера
 * (study-template-seeder.service.ts). Тексты перенесены ДОСЛОВНО из
 * tools/study-plan/lesson-templates.{ru,en}.json (наполнение content,
 * KS-4913); файлы данных удалены по решению architect
 * (/tmp/KS-4909-templates-details.md).
 *
 * После первого сидинга источник истины — БД (Course/Lesson/LessonStep):
 * content правит шаблоны через lessons/admin API; сидер работает в
 * режиме create-if-missing и существующие курсы НЕ перезаписывает.
 *
 * Контракт плейсхолдеров (фиксирован KS-4910/4911):
 *   text-шаги: {{focusTheme}}, {{notes}}, {{homeworkCarryOver}};
 *   text-шаг самопроверки: {{white}}, {{black}}, {{result}}, {{opening}};
 *   puzzle-шаг: selection заменяется билдером (тема+окно);
 *   game-шаг: pgn заменяется партией пользователя.
 * Обязательные шаги шаблона: >=1 text. game/text-самопроверка
 * пропускаются билдером, если партий нет.
 */

export interface StudyTemplateStep {
  type: 'text' | 'puzzle' | 'game' | 'drill';
  /** text: markdown с плейсхолдерами. */
  bodyMarkdown?: string;
}

export interface StudyTemplateLessonContent {
  title: string;
  steps: StudyTemplateStep[];
}

/** Контент по полкам и языкам: [shelfKey][lang]. */
export const STUDY_TEMPLATE_CONTENT: Record<
  string,
  Record<'ru' | 'en', StudyTemplateLessonContent>
> = {
  novice: {
    ru: {
      title: `Занятие: {{focusTheme}}`,
      steps: [
        { type: 'text', bodyMarkdown: `## Сегодняшнее занятие

Тема занятия — **{{focusTheme}}**.

{{notes}}

Главный навык на вашем уровне — внимательность. В каждой позиции сначала спросите себя: какие мои фигуры под боем? какие фигуры соперника я могу взять? Не торопитесь: лишняя минута размышлений спасает целую партию.

{{homeworkCarryOver}}

Решите задачи на тему «{{focusTheme}}». Перед каждым ходом проверьте все шахи и взятия — на вашем уровне почти каждое решение начинается с них.

После урока вас ждёт домашнее задание — оно закрепит тему до следующего занятия. Невыполненная домашняя работа перейдёт в следующий урок, так что лучше закрыть её сразу.` },
        { type: 'puzzle' },
        { type: 'game' },
        { type: 'text', bodyMarkdown: `### Ваша партия: {{white}} — {{black}} ({{result}})

Пройдите партию ходом за ходом (дебют: {{opening}}) и ответьте себе:

1. Были ли ходы, после которых ваша фигура осталась под боем без защиты?
2. Все ли шахи и взятия — свои и соперника — вы видели во время партии?
3. Где можно было выиграть материал, применив идею «{{focusTheme}}»?` },
        { type: 'drill' },
      ],
    },
    en: {
      title: `Study session: {{focusTheme}}`,
      steps: [
        { type: 'text', bodyMarkdown: `## Today's session

The topic of this session is **{{focusTheme}}**.

{{notes}}

The key skill at your level is attentiveness. In every position, first ask yourself: which of my pieces are hanging? Which of my opponent's pieces can I take? Take your time — an extra minute of thought saves a whole game.

{{homeworkCarryOver}}

Solve puzzles on “{{focusTheme}}”. Before every move, check all checks and captures — at your level almost every solution starts with one.

Homework follows the lesson — it reinforces the topic until the next session. Unfinished homework carries over into the next lesson, so it pays to close it right away.` },
        { type: 'puzzle' },
        { type: 'game' },
        { type: 'text', bodyMarkdown: `### Your game: {{white}} — {{black}} ({{result}})

Replay the game move by move (opening: {{opening}}) and answer for yourself:

1. Were there moves that left one of your pieces hanging without protection?
2. Did you see all checks and captures — yours and your opponent's — during the game?
3. Where could you have won material using the “{{focusTheme}}” idea?` },
        { type: 'drill' },
      ],
    },
  },
  beginner: {
    ru: {
      title: `Занятие: {{focusTheme}}`,
      steps: [
        { type: 'text', bodyMarkdown: `## Сегодняшнее занятие

Тема занятия — **{{focusTheme}}**.

{{notes}}

Ваше правило на каждое обдумывание хода: шахи → взятия → угрозы, сначала за соперника, потом за себя. Сегодняшняя тактика и разбор партии построены вокруг этого навыка.

{{homeworkCarryOver}}

Решите задачи на тему «{{focusTheme}}». Алгоритм: найдите все форсированные продолжения (шахи, взятия, угрозы), только потом выбирайте между ними.

После урока вас ждёт домашнее задание — оно закрепит тему до следующего занятия. Невыполненная домашняя работа перейдёт в следующий урок, так что лучше закрыть её сразу.` },
        { type: 'puzzle' },
        { type: 'game' },
        { type: 'text', bodyMarkdown: `### Ваша партия: {{white}} — {{black}} ({{result}})

Пройдите партию ходом за ходом (дебют: {{opening}}) и ответьте себе:

1. Где позиция впервые стала хуже — зевок или постепенное ухудшение?
2. Перед каждым ли ходом вы проверяли шахи, взятия и угрозы соперника?
3. Был ли момент для тактики на тему «{{focusTheme}}» — найдите его на доске.` },
        { type: 'drill' },
      ],
    },
    en: {
      title: `Study session: {{focusTheme}}`,
      steps: [
        { type: 'text', bodyMarkdown: `## Today's session

The topic of this session is **{{focusTheme}}**.

{{notes}}

Your rule for every move: checks → captures → threats, first for your opponent, then for yourself. Today's tactics and game review are built around this habit.

{{homeworkCarryOver}}

Solve puzzles on “{{focusTheme}}”. The algorithm: find all forcing continuations (checks, captures, threats) first, and only then choose between them.

Homework follows the lesson — it reinforces the topic until the next session. Unfinished homework carries over into the next lesson, so it pays to close it right away.` },
        { type: 'puzzle' },
        { type: 'game' },
        { type: 'text', bodyMarkdown: `### Your game: {{white}} — {{black}} ({{result}})

Replay the game move by move (opening: {{opening}}) and answer for yourself:

1. Where did the position first turn worse — a blunder or gradual drift?
2. Did you check your opponent's checks, captures and threats before every move?
3. Was there a tactical moment on “{{focusTheme}}”? Find it on the board.` },
        { type: 'drill' },
      ],
    },
  },
  intermediate: {
    ru: {
      title: `Занятие: {{focusTheme}}`,
      steps: [
        { type: 'text', bodyMarkdown: `## Сегодняшнее занятие

Тема занятия — **{{focusTheme}}**.

{{notes}}

На вашем уровне партии решает не только тактика, но и умение играть по плану. В разборе партии ищите моменты, где вы делали ходы «просто так» — без вопроса «что я улучшаю этим ходом?».

{{homeworkCarryOver}}

Решите задачи на тему «{{focusTheme}}». Перед ходом называйте про себя мотив: почему комбинация работает именно здесь — какая фигура перегружена, какое поле ослаблено.

После урока вас ждёт домашнее задание — оно закрепит тему до следующего занятия. Невыполненная домашняя работа перейдёт в следующий урок, так что лучше закрыть её сразу.` },
        { type: 'puzzle' },
        { type: 'game' },
        { type: 'text', bodyMarkdown: `### Ваша партия: {{white}} — {{black}} ({{result}})

Пройдите партию ходом за ходом (дебют: {{opening}}) и ответьте себе:

1. Найдите три критических момента партии и предложите в каждом два хода-кандидата.
2. Где вы играли без плана — ход не улучшал позицию и не мешал сопернику?
3. Вытекал ли ваш план из пешечной структуры дебюта, и был ли шанс на тактику «{{focusTheme}}»?` },
        { type: 'drill' },
      ],
    },
    en: {
      title: `Study session: {{focusTheme}}`,
      steps: [
        { type: 'text', bodyMarkdown: `## Today's session

The topic of this session is **{{focusTheme}}**.

{{notes}}

At your level games are decided not only by tactics but by playing with a plan. In the game review, look for moments when you made moves “just because” — without asking “what does this move improve?”.

{{homeworkCarryOver}}

Solve puzzles on “{{focusTheme}}”. Before moving, name the motif to yourself: why does the combination work here — which piece is overloaded, which square is weak?

Homework follows the lesson — it reinforces the topic until the next session. Unfinished homework carries over into the next lesson, so it pays to close it right away.` },
        { type: 'puzzle' },
        { type: 'game' },
        { type: 'text', bodyMarkdown: `### Your game: {{white}} — {{black}} ({{result}})

Replay the game move by move (opening: {{opening}}) and answer for yourself:

1. Find three critical moments of the game and suggest two candidate moves in each.
2. Where did you play without a plan — a move that neither improved your position nor hindered your opponent?
3. Did your plan follow from the pawn structure of the opening, and was there a chance for “{{focusTheme}}” tactics?` },
        { type: 'drill' },
      ],
    },
  },
  advanced: {
    ru: {
      title: `Занятие: {{focusTheme}}`,
      steps: [
        { type: 'text', bodyMarkdown: `## Сегодняшнее занятие

Тема занятия — **{{focusTheme}}**.

{{notes}}

Фокус вашего уровня — критические моменты и профилактика. В каждой позиции сегодняшнего урока задавайте два вопроса: «что хочет соперник?» и «не пора ли считать конкретно, а не играть по общим соображениям?».

{{homeworkCarryOver}}

Решите задачи на тему «{{focusTheme}}». Считайте варианты до конца — до оценки конечной позиции, а не до «выглядит хорошо». Проверяйте промежуточные ходы соперника.

После урока вас ждёт домашнее задание — оно закрепит тему до следующего занятия. Невыполненная домашняя работа перейдёт в следующий урок, так что лучше закрыть её сразу.` },
        { type: 'puzzle' },
        { type: 'game' },
        { type: 'text', bodyMarkdown: `### Ваша партия: {{white}} — {{black}} ({{result}})

Пройдите партию ходом за ходом (дебют: {{opening}}) и ответьте себе:

1. Отметьте критические моменты — где партия могла пойти по другому руслу. Совпадают ли они с местами, где вы долго думали?
2. Где сработала бы профилактика — вопрос «что хочет соперник?» до собственного плана?
3. Оцените размены и переходы в окончание: какие были в вашу пользу, а какие нет? Не упущена ли тактика «{{focusTheme}}»?` },
        { type: 'drill' },
      ],
    },
    en: {
      title: `Study session: {{focusTheme}}`,
      steps: [
        { type: 'text', bodyMarkdown: `## Today's session

The topic of this session is **{{focusTheme}}**.

{{notes}}

The focus at your level is critical moments and prophylaxis. In every position of today's lesson ask two questions: “what does my opponent want?” and “is it time to calculate concretely rather than play on general grounds?”.

{{homeworkCarryOver}}

Solve puzzles on “{{focusTheme}}”. Calculate lines to the end — to an evaluation of the final position, not to “looks good”. Check your opponent's in-between moves.

Homework follows the lesson — it reinforces the topic until the next session. Unfinished homework carries over into the next lesson, so it pays to close it right away.` },
        { type: 'puzzle' },
        { type: 'game' },
        { type: 'text', bodyMarkdown: `### Your game: {{white}} — {{black}} ({{result}})

Replay the game move by move (opening: {{opening}}) and answer for yourself:

1. Mark the critical moments — where the game could have taken a different course. Do they match the places where you thought longest?
2. Where would prophylaxis have worked — asking “what does my opponent want?” before your own plan?
3. Evaluate the exchanges and transitions to the endgame: which were in your favour and which were not? Was a “{{focusTheme}}” tactic missed?` },
        { type: 'drill' },
      ],
    },
  },
  club_strong: {
    ru: {
      title: `Занятие: {{focusTheme}}`,
      steps: [
        { type: 'text', bodyMarkdown: `## Сегодняшнее занятие

Тема занятия — **{{focusTheme}}**.

{{notes}}

На вашем уровне рост даёт работа над качеством расчёта и типологией собственных ошибок. Разбирая партию, ищите не отдельные зевки, а повторяющиеся сценарии: цейтнотные решения, усталость в четвёртом часу игры, самоуспокоенность в лучших позициях.

{{homeworkCarryOver}}

Решите задачи на тему «{{focusTheme}}» в турнирном режиме: полный расчёт до оценки, проверка ходов-кандидатов за соперника, никаких ходов «на глаз». Фиксируйте, где расчёт оборвался раньше времени.

После урока вас ждёт домашнее задание — оно закрепит тему до следующего занятия. Невыполненная домашняя работа перейдёт в следующий урок, так что лучше закрыть её сразу.` },
        { type: 'puzzle' },
        { type: 'game' },
        { type: 'text', bodyMarkdown: `### Ваша партия: {{white}} — {{black}} ({{result}})

Пройдите партию ходом за ходом (дебют: {{opening}}) и ответьте себе:

1. Восстановите свой расчёт в ключевых позициях: где дерево вариантов было неполным — пропущен ход-кандидат за соперника?
2. К какому типу относятся ваши ошибки в этой партии: оценка, расчёт, психология, дебютная подготовка?
3. Сравните свои планы с требованиями позиции: где стоило менять характер борьбы, и была ли недооценена тема «{{focusTheme}}»?` },
        { type: 'drill' },
      ],
    },
    en: {
      title: `Study session: {{focusTheme}}`,
      steps: [
        { type: 'text', bodyMarkdown: `## Today's session

The topic of this session is **{{focusTheme}}**.

{{notes}}

At your level, growth comes from the quality of calculation and from mapping your own error patterns. Reviewing the game, look not for isolated blunders but for recurring scenarios: time-trouble decisions, fatigue in hour four, complacency in better positions.

{{homeworkCarryOver}}

Solve puzzles on “{{focusTheme}}” in tournament mode: full calculation to an evaluation, checking candidate moves for your opponent, no moves “by eye”. Note where your calculation stopped short.

Homework follows the lesson — it reinforces the topic until the next session. Unfinished homework carries over into the next lesson, so it pays to close it right away.` },
        { type: 'puzzle' },
        { type: 'game' },
        { type: 'text', bodyMarkdown: `### Your game: {{white}} — {{black}} ({{result}})

Replay the game move by move (opening: {{opening}}) and answer for yourself:

1. Reconstruct your calculation in the key positions: where was the tree of variations incomplete — a candidate move for your opponent missed?
2. What type were your errors in this game: evaluation, calculation, psychology, opening preparation?
3. Compare your plans with the demands of the position: where should you have changed the character of the struggle, and was the “{{focusTheme}}” theme underestimated?` },
        { type: 'drill' },
      ],
    },
  },
};

/** Строки наблюдений (notes) вводного шага — по языкам. */
export const STUDY_NOTE_LINES: Record<'ru' | 'en', Record<string, string>> = {
  ru: {
    results: `Итоги последних партий: побед — {{wins}}, поражений — {{losses}}, ничьих — {{draws}}.`,
    openings: `Ваши частые дебюты: {{openings}}.`,
    colors: `Вы чаще играете за {{color}}.`,
    carryOver: `Переносим с прошлого занятия: «{{theme}}» — в этот раз доведите тему до конца.`,
    noGames: `Партий пока нет — привяжите chess.com/lichess или загрузите PGN, и уроки будут строиться на ваших собственных партиях.`,
  },
  en: {
    results: `Your recent games: {{wins}} wins, {{losses}} losses, {{draws}} draws.`,
    openings: `Your frequent openings: {{openings}}.`,
    colors: `You play {{color}} more often.`,
    carryOver: `Carried over from the previous session: “{{theme}}” — see it through this time.`,
    noGames: `No games yet — link chess.com/lichess or upload a PGN, and your lessons will be built from your own games.`,
  },
};
