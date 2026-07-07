/**
 * KS-4860. Общие паттерны для распознавания формата турнира по строке
 * `Broadcast.format` (Lichess `tour.info.format`). Раньше жили inline в
 * `detect-tournament-type.ts` и `detect-round-tournament-type.ts`;
 * вынесены сюда, чтобы расширения по локализациям не расходились между
 * двумя детекторами.
 *
 * Швейцарский формат — Lichess/chess-results выдают локализованные
 * названия («Švajčiarsky systém na 9 kôl» словацкий, «Швейцарская
 * система» русский, «Schweizer System» немецкий и т. п.). Регулярка
 * расширена альтернацией на корни всех крупных языков. Флаги `i` +
 * `u` — case-insensitive и Unicode-aware (для диакритики и кириллицы).
 *
 * Round-robin и team — пока распознаются только по английским корням;
 * расширение локализаций для них — отдельной задачей, если понадобится.
 */

/**
 * Швейцарская система: английский `swiss` + локализованные корни.
 * Список источников для корней:
 *   - `swiss`     — англ.  «9-round Swiss»
 *   - `suisse`    — фр.    «Système suisse»
 *   - `schweizer` — нем.   «Schweizer System»
 *   - `švajčiar`  — слов.  «Švajčiarsky systém na 9 kôl» (наблюдение
 *                          пользователя, FIDE Open České Budějovice)
 *   - `svajciar`  — слов.  без диакритики
 *   - `švýcar`    — чеш.   «Švýcarský systém»
 *   - `svycar`    — чеш.   без диакритики
 *   - `svizzer`   — итал.  «Sistema svizzero»
 *   - `suizo`     — исп.   «Sistema suizo»
 *   - `suíço`     — порт.  «Sistema suíço»
 *   - `szwajcar`  — польс. «System szwajcarski»
 *   - `zwitsers`  — нидерл. «Zwitsers systeem»
 *   - `швейц`     — рус.   «Швейцарская система»
 *   - `швайц`     — укр./бел. «Швайцарський стиль»
 *
 * Word-boundaries не расставлены намеренно: с `u`-флагом `\b` вокруг
 * кириллицы и диакритики работает нестабильно между движками; риск
 * ложных срабатываний на реальных `tour.format`-строках минимален
 * (проверенный корпус — только шахматные форматы).
 */
export const SWISS_FORMAT_PATTERN =
  /(?:swiss|suisse|schweizer|švajčiar|svajciar|švýcar|svycar|svizzer|suizo|suíço|szwajcar|zwitsers|швейц|швайц)/iu;

/**
 * Round-robin. Пока только английский корень — локализации добавим при
 * первом наблюдении не-английского формата с этим типом.
 */
export const ROUND_ROBIN_FORMAT_PATTERN = /round[- ]?robin/i;

/**
 * Team-маркер. Тоже пока только английский корень — Lichess/chess-results
 * в team-турнирах обычно возвращают «team» в format.
 */
export const TEAM_FORMAT_PATTERN = /team/i;
