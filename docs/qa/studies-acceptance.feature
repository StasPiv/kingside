# language: ru
# Studies — Gherkin acceptance criteria (Wave A, ADR-060)
#
# Авторитетный чек-лист для QA-прогона. Покрывает весь функционал
# Studies, реализованный в Wave A (KS-2856 пакет + найденные после
# баги KS-2904..2907). Каждый сценарий проверяется в Playwright
# либо вручную; визуальные пункты — обязательны в light **и** dark
# темах и на desktop **и** mobile (явно отмечены в Then).
#
# Связано: ADR-060 §7 (acceptance), KS-2879 (предыдущий baseline),
# KS-2904 (delete chapter), KS-2905 (breadcrumb «Workshop»),
# KS-2906 (mobile editor без header'а), KS-2907 (gamebook reader 404
# для owner на private/unlisted), KS-2908 (этот документ).
#
# Соглашения:
#  • «<owner>», «<viewer>», «<contributor>» — отдельные тестовые
#    аккаунты. Через `beforeEach` в Playwright логиним нужного.
#  • «студия <S>» — короткое имя для bookkeeping. В Background создаём
#    студию с известным slug, чтобы scenario'ы не плодили мусор.
#  • «доска в стартовой позиции FEN» = `rnbqkbnr/pppppppp/8/8/8/8/
#    PPPPPPPP/RNBQKBNR w KQkq - 0 1`.
#  • «дерево пусто» = в `[data-testid="analysis-sidebar"]` нет
#    `[data-testid^="move-"]` элементов либо отображается «No moves».
#  • «light/dark» — у тестера запущены два прогона: `theme=light` и
#    `theme=dark`. Both должны быть зелёными.
#  • «desktop/mobile» — два viewport'а: 1440×900 (desktop), 414×896
#    (iPhone 14 Pro). Both должны быть зелёными.
#  • Все взаимодействия с доской через `useFastDrag` — pointer events.

Feature: Studies — Catalog (StudiesPage /studies)

  Background:
    Given feature-flag `studiesEnabled` = true

  Scenario: Anonymous видит публичные студии в каталоге
    Given в БД минимум 1 публичная студия и 1 приватная
    And пользователь не авторизован
    When он открывает `/studies`
    Then рендерится `[data-testid="studies-page"]`
    And по умолчанию активен таб `studies-tab-public`
    And в гриде `studies-grid` видны только публичные студии
    And приватные не видны
    And в light-теме фон каталога — `--c-surface-base`, текст читаем
    And в dark-теме фон — `--c-surface-base-dark`, текст читаем

  Scenario: Owner переключает таб «Мои» и видит все свои студии
    Given owner авторизован
    And у owner есть 2 студии: 1 публичная, 1 приватная
    When он открывает `/studies`
    And нажимает `studies-tab-mine`
    Then в гриде отображаются обе студии
    And приватная имеет `studies-card-badge-<slug>` со значением «Private»
    And публичная имеет badge «Public»
    And в light и dark темах badge'ы контрастны

  Scenario: Пустое состояние «Мои» — CTA на создание
    Given owner авторизован
    And у owner нет студий
    When он открывает `/studies` и переключает на `studies-tab-mine`
    Then виден `studies-empty` с текстом приглашения
    And виден `studies-empty-create-btn`
    And нет элементов `studies-grid`

  Scenario: Hover-стиль карточки в светлой теме читаем
    Given owner на `/studies`, таб `studies-tab-mine`
    When мышь над `studies-card-<slug>`
    Then фон карточки переходит на hover-цвет
    And текст имени остаётся читаемым (контраст ≥ WCAG AA)
    And в dark-теме hover тоже читаем

Feature: Studies — CreateStudyDialog

  Scenario: Owner создаёт публичную студию из каталога
    Given owner на `/studies`
    When он нажимает `studies-create-btn`
    Then открывается `create-study-dialog`
    And поле `create-study-dialog-name` имеет фокус
    When он вводит «Тестовая студия»
    And нажимает `create-study-dialog-public` (toggle public)
    And нажимает `create-study-dialog-submit`
    Then диалог закрывается
    And происходит navigate на `/studies/<новый-slug>`
    And отображается `study-page` с именем «Тестовая студия»

  Scenario: Валидация — пустое имя блокирует submit
    Given owner открыл `create-study-dialog`
    When он оставляет `create-study-dialog-name` пустым
    Then `create-study-dialog-submit` отключён (`disabled=true`)
    When он вводит «X»
    Then submit включён

  Scenario: Textarea описания читаемо в светлой теме (regression KS-2904)
    Given owner открыл `create-study-dialog`
    And тема `light`
    When он печатает в `create-study-dialog-description`
    Then цвет текста — тёмный (не белый/чёрный на тёмном фоне)
    And фон textarea — светлый, граница видна
    When он переключает тему на `dark`
    Then цвет текста — светлый, фон тёмный
    # KS-2904: было «чёрный textarea в light» — должно быть исправлено.

  Scenario: Cancel закрывает диалог без создания
    Given owner ввёл имя в `create-study-dialog-name`
    When он нажимает `create-study-dialog-cancel`
    Then диалог закрывается
    And URL остался `/studies`
    And в БД новой студии не появилось

Feature: Studies — StudyPage (/studies/:slug)

  Background:
    Given owner авторизован
    And студия <S> создана с 2 главами

  Scenario: StudyPage — header, owner-actions, список глав
    When owner открывает `/studies/<S.slug>`
    Then виден `study-page` data-state=`ready`
    And `study-page-name` = «<S.name>»
    And `study-page-badge` отображает текущую visibility
    And `study-owner-actions` содержит все 5 кнопок:
      | study-action-share         |
      | study-action-create-chapter |
      | study-action-import-pgn    |
      | study-action-members       |
      | study-action-delete        |
    And `study-chapter-list` содержит 2 элемента

  Scenario: Удаление главы из списка StudyPage (KS-2904)
    When owner наводит на `study-chapter-<chId>`
    Then виден `study-chapter-delete-<chId>` (кнопка-корзина либо
        контекстное меню)
    When он нажимает delete
    And подтверждает в confirm-dialog
    Then PATCH/DELETE на `/api/studies/<slug>/chapters/<chId>` возвращает 204
    And `study-chapter-list` обновлён, главы стало 1
    And `study-page-chapters-count` (если показано) уменьшился

  Scenario: Пустое состояние — нет глав
    Given у студии <S> 0 глав
    When owner открывает `/studies/<S.slug>`
    Then виден `study-chapters-empty`
    And в нём CTA на создание главы

  Scenario: Viewer видит публичную студию без owner-actions
    Given студия <S> публичная
    And viewer авторизован (не owner)
    When он открывает `/studies/<S.slug>`
    Then `study-owner-actions` отсутствует
    And список глав виден read-only
    And клик по главе ведёт в editor read-only режима

Feature: Studies — Создание главы

  Background:
    Given owner авторизован
    And студия <S> создана с 0 глав

  Scenario: Owner создаёт первую главу из StudyPage
    When owner на `/studies/<S.slug>` нажимает `study-action-create-chapter`
    Then создаётся chapter через POST `/api/studies/<S.slug>/chapters`
    And происходит navigate на `/studies/<S.slug>/<chId>`
    And в `analysis-header-breadcrumbs` видна цепочка «Студии → <S.name> → <chapter.name>»
    And breadcrumb section равен «Студии» (НЕ «Workshop» — regression KS-2905)
    And доска в стартовой позиции FEN
    And `analysis-sidebar` показывает «No moves» (дерево пусто)
    And в localStorage НЕТ восстановления ad-hoc PGN (regression KS-2904)

  Scenario: Создание главы после ранее открытого ad-hoc анализа
    Given owner ранее открывал `/analysis` и сделал ходы 1.e4 e5
    And в localStorage есть запись `analysis:adhoc:*` с PGN
    When owner создаёт новую главу в студии <S>
    Then доска в стартовой позиции
    And в `analysis-sidebar` нет ходов из ad-hoc-кэша
    # KS-2904: «чужая партия при создании главы» — должно быть исправлено.

  Scenario: Owner не может создать 65-ю главу
    Given у студии <S> уже 64 главы
    When owner пытается создать ещё одну
    Then POST `/api/studies/<S.slug>/chapters` возвращает 400
    And UI показывает понятную ошибку «Превышен лимит 64 главы»

Feature: Studies — Editor desktop (/studies/:slug/:chapterId)

  Background:
    Given owner авторизован
    And студия <S> с главой <ch> mode='analysis'
    And viewport 1440×900

  Scenario: Editor рендерит все элементы desktop-layout'а
    When owner открывает `/studies/<S.slug>/<ch.id>`
    Then видна `analysis-board-container` (доска)
    And виден `analysis-sidebar` (дерево + nav-кнопки + NagPalette trigger)
    And `analysis-header-breadcrumbs` содержит «Студии → <S.name> → <ch.name>»
    And видны owner-actions: mode-switcher, flip orientation, delete chapter
    And в light и dark темах все элементы читаемы

  Scenario: Inline-edit имени главы
    When owner кликает по `analysis-header-title`
    Then появляется `analysis-header-title-input` с текущим именем
    When он вводит «Новое имя» и нажимает Enter
    Then PATCH `/api/studies/<S.slug>/chapters/<ch.id>` обновляет name
    And `analysis-header-title` показывает «Новое имя»
    And breadcrumb обновлён

  Scenario: Делать ход → запись в дерево + auto-save
    When owner drag'ает белую пешку e2→e4
    Then на доске обновлена позиция (FEN после e4)
    And в `analysis-sidebar` появился узел «e4»
    And через 1100 мс выполняется PATCH `/api/studies/<S.slug>/chapters/<ch.id>` с pgn содержащим `e4`
    And после reload страницы дерево восстанавливается с `e4`

  Scenario: NAG-аннотация на выбранном узле
    Given owner сделал ход 1.e4
    When он выбирает узел «e4» и открывает NagPalette
    And выбирает `!` ($1)
    Then в `analysis-sidebar` рядом с «e4» отрисован символ `!`
    And в auto-save'е pgn содержит `e4 $1`

  Scenario: Стрелки и кружки на доске
    Given owner на узле «e4»
    When он правым-кликом-drag на доске рисует стрелку d2→d4
    Then на доске отрендерена зелёная стрелка d2→d4
    When ctrl+правый-клик на клетке e5
    Then клетка e5 подсвечена жёлтым кружком
    And в pgn-комменте узла содержится `[%cal Gd2d4]` и `[%csl Ye5]`

  Scenario: Flip orientation
    Given chapter.orientation = «white» (a1 слева внизу)
    When owner нажимает Flip
    Then доска перевёрнута (a1 справа сверху)
    And PATCH `/api/studies/<S.slug>/chapters/<ch.id>` сохраняет orientation='black'

  Scenario: Delete chapter из editor (KS-2904)
    When owner нажимает кнопку delete в `analysis-header`
    And подтверждает confirm
    Then DELETE `/api/studies/<S.slug>/chapters/<ch.id>` возвращает 204
    And происходит redirect на `/studies/<S.slug>`
    And главы в списке больше нет

  Scenario: Engine eval и eval-bar
    When owner включает engine (`stockfish-toggle`)
    Then через ≤3 сек появляется eval-bar с числовой оценкой
    And значение обновляется при изменении позиции
    When он выключает engine
    Then eval-bar исчезает

Feature: Studies — Editor mobile (regression KS-2906)

  Background:
    Given owner авторизован
    And студия <S> с главой <ch>
    And viewport 414×896 (iPhone 14 Pro)
    And `pointer: coarse`

  Scenario: Mobile editor показывает breadcrumb + название + actions
    When owner открывает `/studies/<S.slug>/<ch.id>`
    Then виден `analysis-header-breadcrumbs` (может быть компактным)
    And виден `analysis-header-title` либо иконка-таб для его раскрытия
    And `analysis-header-shortcut` (Flip / Mode / Delete) доступен
        в шапке либо в гамбургер-меню — но НЕ скрыт полностью
    And доска занимает основную область
    And `analysis-sidebar` либо ниже доски, либо в swipe-tray
    # KS-2906: mobile editor не должен показывать только доску.

  Scenario: Mobile drag-фигуры через touch
    When owner делает touch-drag e2→e4
    Then ход применён, узел появился в sidebar (после раскрытия)
    And auto-save отрабатывает

  Scenario: Mobile delete chapter доступен
    When owner раскрывает actions (через кнопку «...» в header'е)
    Then в выпадающем меню есть пункт «Delete chapter»

Feature: Studies — Public read-only (/studies/c/:chapterId)

  Background:
    Given студия <S> публичная с главой <ch>
    And viewer не авторизован

  Scenario: Anonymous открывает public-главу
    When он открывает `/studies/c/<ch.id>`
    Then рендерится AnalysisPage в read-only режиме
    And доска отображает позицию из chapter.pgn
    And `analysis-sidebar` рендерит дерево
    And попытка drag фигуры — НЕ создаёт ход (drag disabled)
    And `analysis-board-container` не показывает promotion-overlay
    And NAG-палитра отсутствует или disabled
    And Mode-switcher НЕ виден или disabled

  Scenario: Private глава недоступна anonymous (404)
    Given студия <S> приватная
    When anonymous открывает `/studies/c/<ch.id>`
    Then ответ 404, рендерится error-state, без раскрытия названия

  Scenario: Owner-only ссылка «Открыть в редакторе» на public-page
    Given студия <S> публичная
    And owner авторизован
    When owner открывает `/studies/c/<ch.id>` (public-readonly URL)
    Then в header'е виден линк «Open in editor» → `/studies/<S.slug>/<ch.id>`
    When viewer (другой авторизованный пользователь) открывает тот же URL
    Then ссылки «Open in editor» нет

Feature: Studies — Режим analysis (default)

  Scenario: Дефолтный режим — свободное редактирование
    Given owner создал главу
    Then `chapter.mode` = `analysis`
    And `analysis-study-mode-select` value = `analysis`
    When owner делает ход → ветка добавляется в дерево
    And `analysis-sidebar` показывает варианты с promote/delete-меню

Feature: Studies — Режим practice (FM2)

  Background:
    Given owner создал главу с main-line 1.e4 e5 2.Nf3
    And switch'нул mode на `practice`

  Scenario: Правильный main-line ход → продолжение
    Given текущая позиция перед ходом белых
    When owner-как-player делает e2-e4
    Then ход применён
    And opponent (mainline) автоматически отвечает e7-e5 (если есть child)
    And NO toast «ошибка»
    And счётчик ошибок = 0

  Scenario: Неправильный ход → откат + hint + счётчик
    Given на позиции после 1.e4 e5 ожидается 2.Nf3
    When player делает 2.Ba6 (не в дереве)
    Then ход откатывается, позиция возвращается перед 2-м ходом
    And появляется toast/feedback «Попробуйте другой ход» (либо текст из comment узла)
    And счётчик ошибок инкрементируется (виден в UI или header'е)
    And eval-bar не виден (engine отключён в practice)

  Scenario: Auto-save выключен в practice
    Given owner в режиме practice
    When он делает ходы (правильные и неправильные)
    Then PATCH `/api/studies/.../chapters/...` НЕ отправляется
    And в БД pgn главы не меняется

Feature: Studies — Режим conceal (FM3)

  Background:
    Given главу `<ch>` mode=`conceal`, concealPly=2
    And main-line 1.e4 e5 2.Nf3 Nc6 3.Bb5

  Scenario: Viewer видит ??? после concealPly
    Given viewer (не owner) на read-only странице
    Then в `analysis-sidebar` ходы 1.e4 e5 видны
    And ходы 2.Nf3, Nc6, 3.Bb5 рендерятся как `???` (или скрыты)
    And клик по `???` не делает goto

  Scenario: Правильный ход раскрывает следующий узел
    Given viewer на позиции после 1...e5, ожидается 2.Nf3
    When он делает 2.Nf3 (главой mode='conceal' в practice-подобном flow)
    Then в sidebar Nf3 раскрыт, последующие Nc6/Bb5 остаются `???`
    When он делает 2...Nc6
    Then Nc6 раскрыт, Bb5 остаётся `???`

  Scenario: Navigation назад не сбрасывает revealedPly
    Given revealedPly стал 5 после раскрытий
    When viewer нажимает «◀» назад
    Then позиция меняется
    And ранее раскрытые узлы остаются раскрытыми (revealedPly не уменьшается)

  Scenario: Editor (owner) видит без сокрытия
    Given owner на `/studies/<S.slug>/<ch.id>` в режиме editor
    Then все узлы видны (без `???`), даже за пределами concealPly
    # Conceal применяется только при viewer'е и в practice-подобном UI.

Feature: Studies — Gamebook editor (FM4)

  Background:
    Given owner создал главу mode=`gamebook` с main-line 1.e4 e5

  Scenario: Поля hint/success/failure на узле
    When owner выбирает узел «e4»
    Then в `analysis-gamebook-editor` поля:
      | analysis-gamebook-hint-input    |
      | analysis-gamebook-success-input |
      | analysis-gamebook-failure-input |
    When он вводит «Сделайте классический ход в центр» в hint
    And «Правильно!» в success
    And blur'ит
    Then PATCH `/api/studies/<S.slug>/chapters/<ch.id>/gamebook` отправлен
        с `byUci.e2e4 = {hint, success}`
    When он переключается на узел «e5»
    Then поля перезаполняются payload'ом узла «e5» (могут быть пустыми)

  Scenario: Intro редактируется отдельной кнопкой
    When owner нажимает `analysis-gamebook-intro-toggle`
    Then видим `analysis-gamebook-intro-input`
    When он вводит intro-текст и сохраняет
    Then `chapter.gamebook.intro` обновлено

  Scenario: Лимит 200 узлов
    Given в gamebook уже 200 узлов с непустым byUci
    When owner пытается заполнить 201-й узел
    Then UI показывает `analysis-gamebook-limit-msg`
    And поля заблокированы

  Scenario: Лимит 500 символов на текст
    When owner вводит 501 символ в success-input
    Then на blur UI обрезает либо показывает валидационную ошибку
    And PATCH не уходит с превышением

Feature: Studies — Gamebook reader (/studies/:slug/:chapterId/play)

  Background:
    Given главу <ch> mode=`gamebook` с intro «Найдите лучший ход»
    And byUci содержит для `e2e4`: {success: «Отлично!»}
    And byUci содержит для `d2d4`: {failure: «d4 не главное продолжение»}

  Scenario: Pre-game intro phase
    When player открывает `/studies/<S.slug>/<ch.id>/play`
    Then виден `gamebook-reader-page`
    And `gamebook-reader-intro` показывает «Найдите лучший ход»
    And `gamebook-reader-start` кнопка видна
    When он нажимает Start
    Then intro скрывается, доска становится интерактивной

  Scenario: Правильный ход → success
    When player делает e2-e4
    Then `gamebook-reader-feedback` показывает «Отлично!»
    And opponent отвечает (если есть main-line move)

  Scenario: Неверный ход → failure + откат
    When player делает d2-d4
    Then `gamebook-reader-feedback` показывает «d4 не главное продолжение»
    And ход откатывается, позиция остаётся стартовой

  Scenario: Finished когда mainline закончилась
    Given player прошёл всю main-line успешно
    Then `gamebook-reader-finished` виден с поздравлением
    And предложен переход на следующую главу или каталог

  Scenario: Owner может играть gamebook на private/unlisted студии (regression KS-2907)
    Given студия <S> приватная, mode=`gamebook`
    And owner авторизован
    When owner открывает `/studies/<S.slug>/<ch.id>/play`
    Then страница рендерится корректно (НЕ 404)
    And весь gamebook-flow работает

  Scenario: Owner может играть gamebook на unlisted студии
    Given студия <S> unlisted
    And owner авторизован
    When owner открывает `/studies/<S.slug>/<ch.id>/play`
    Then 200 OK, gamebook играется
    # KS-2907: до фикса owner получал 404 на private/unlisted — должно
    # быть исправлено доступом через slug+chapterId (как в editor).

  Scenario: Anonymous НЕ может играть gamebook на private
    Given студия <S> приватная
    When anonymous пытается открыть `/play` URL
    Then 404 или редирект на login

Feature: Studies — Visibility (private / unlisted / public)

  Scenario: Private — anonymous получает 404 на StudyPage
    Given студия <S> visibility=private
    When anonymous открывает `/studies/<S.slug>`
    Then ответ 404
    And не раскрывается существование студии

  Scenario: Unlisted — 200 по UUID, не попадает в каталог
    Given студия <S> visibility=unlisted
    When anonymous открывает `/studies/<S.slug>` (прямая ссылка)
    Then 200 OK, видна страница
    When anonymous открывает `/studies` (каталог)
    Then в `studies-grid` студии <S> нет

  Scenario: Public — везде доступна и в каталоге
    Given студия <S> visibility=public
    When anonymous открывает `/studies` → таб `studies-tab-public`
    Then `studies-card-<S.slug>` присутствует

  Scenario: Owner меняет visibility через share-action
    Given студия <S> visibility=private
    When owner нажимает `study-action-share`
    Then открывается share-меню с 3-мя радио (private/unlisted/public)
    When он выбирает «public» и подтверждает
    Then PATCH `/api/studies/<S.slug>` обновляет visibility
    And `study-page-badge` меняется на «Public»

Feature: Studies — Members (contributor)

  Background:
    Given owner авторизован, студия <S> приватная

  Scenario: Owner приглашает contributor через username
    When owner нажимает `study-action-members`
    Then открывается `study-members-dialog`
    When он вводит username существующего пользователя <U>
    And нажимает «Пригласить»
    Then POST `/api/studies/<S.slug>/members` создаёт запись
    And <U> появляется в списке members с ролью «contributor»

  Scenario: Contributor может PATCH'ить главу
    Given <U> добавлен как contributor в <S>
    When <U> логинится и открывает `/studies/<S.slug>/<ch.id>`
    Then редактор рендерится в editor-режиме (не readonly)
    And <U> может делать ходы, добавлять NAG, сохранять (auto-save)

  Scenario: Owner удаляет contributor
    Given <U> contributor в <S>
    When owner нажимает «Убрать» рядом с <U> в `study-members-dialog`
    Then DELETE `/api/studies/<S.slug>/members/<U.id>` возвращает 204
    When <U> повторно открывает `/studies/<S.slug>` (приватная)
    Then 404 (доступ снят)

  Scenario: Invite-link flow
    When owner в `study-members-dialog` нажимает «Создать ссылку»
    Then POST `/api/studies/<S.slug>/invite-link` возвращает `{token, url, expiresAt}`
    And url копируется в буфер
    When <U> открывает `/studies/invites/<token>` (auth)
    Then рендерится preview-страница с именем студии
    When <U> нажимает «Принять»
    Then POST `/api/studies/invites/<token>/accept` делает <U> contributor'ом
    And редирект на `/studies/<S.slug>`

  Scenario: Истёкший invite-token
    Given token с `expiresAt` в прошлом
    When <U> открывает `/studies/invites/<token>`
    Then показывается ошибка «Срок действия приглашения истёк»
    And accept-кнопка disabled или отсутствует

Feature: Studies — Import PGN

  Background:
    Given owner на `/studies/<S.slug>` с 0 главами

  Scenario: Multi-PGN импорт создаёт N глав
    When owner нажимает `study-action-import-pgn`
    Then открывается `import-pgn-dialog`
    When он вставляет PGN с 3 партиями в `import-pgn-dialog-textarea`
    Then `import-pgn-dialog-count` показывает «3 партии»
    When он нажимает `import-pgn-dialog-submit`
    Then POST `/api/studies/<S.slug>/import-pgn` создаёт 3 chapters
    And диалог закрывается
    And `study-chapter-list` отображает 3 новые главы

  Scenario: Превышение лимита 64 главы
    Given студия уже имеет 63 главы
    When owner пытается импортнуть 5-партийный PGN
    Then POST возвращает 400 «Превышен лимит 64 главы»
    And UI показывает `import-pgn-dialog-error` с понятным текстом
    And ни одна глава не создаётся (атомарно)

  Scenario: Невалидный PGN
    When owner вставляет «не PGN текст» в textarea
    Then `import-pgn-dialog-count` показывает «0 партий»
    And submit-кнопка disabled либо после клика — `import-pgn-dialog-error`

  Scenario: Drag-n-drop файла .pgn
    When owner перетаскивает .pgn файл на dropzone (или загружает через `import-pgn-dialog-file`)
    Then содержимое файла подставляется в textarea
    And count обновляется

Feature: Studies — Chapter reorder (DnD)

  Background:
    Given owner на `/studies/<S.slug>` с 3 главами [A, B, C]

  Scenario: Drag главы переставляет порядок
    When owner drag'ает `study-chapter-handle-<A.id>` на позицию после C
    Then list оптимистично перерисовывается [B, C, A]
    And PATCH `/api/studies/<S.slug>/chapters/<A.id>/order` с `{after: C.id}` отправлен
    And после reload порядок сохранён

  Scenario: Rollback при ошибке сети
    Given сеть отвечает 500 на reorder PATCH
    When owner drag'ает A после C
    Then оптимистично UI меняется
    And через ≤2 сек откатывается обратно [A, B, C]
    And появляется toast «Не удалось переставить»

  Scenario: Mobile touch-DnD
    Given viewport mobile (414×896)
    When owner touch-drag'ает handle
    Then переупорядочивание срабатывает аналогично desktop

Feature: Studies — Breadcrumb (regression KS-2905)

  Scenario: Breadcrumb на editor study-главы — корректный
    Given owner открыл `/studies/<S.slug>/<ch.id>`
    Then `analysis-header-breadcrumbs` содержит ровно цепочку:
      «Студии → <S.name> → <ch.name>»
    And section НЕ равна «Workshop»
    And section НЕ равна «Analysis»
    # KS-2905: было — breadcrumb показывал «Workshop / ...» из-за того,
    # что AnalysisPage по умолчанию рендерит workshop-breadcrumb.

  Scenario: Breadcrumb-link на «Студии» ведёт на /studies
    When owner кликает первое звено breadcrumb («Студии»)
    Then переход на `/studies`

  Scenario: Breadcrumb-link на имя студии ведёт на StudyPage
    When owner кликает «<S.name>»
    Then переход на `/studies/<S.slug>`

Feature: Studies — Auto-save поведение

  Scenario: Debounce 1000ms на изменения дерева
    Given owner в editor
    When он делает 3 хода подряд за 500ms
    Then только 1 PATCH отправляется (1000ms после последнего хода)
    When он делает 4-й ход через 1500ms
    Then отправляется второй PATCH

  Scenario: Auto-save на blur и navigate-away
    Given неотправленные изменения в дереве
    When owner делает navigate на другую страницу
    Then перед navigate отправляется final PATCH
    And данные сохраняются

  Scenario: Auto-save не работает на public-readonly
    Given anonymous на `/studies/c/<ch.id>`
    When он навигирует по дереву через `←`/`→`
    Then PATCH `/api/studies/...` НЕ отправляется (нет токена + readOnly)

Feature: Studies — Кросс-платформа визуальный smoke

  # Этот блок проверяется тестером вручную / через Playwright snapshot.

  Scenario Outline: <page> читаемо в light и dark
    Given пользователь на <page>
    Then в `theme=light` все тексты имеют контраст ≥ WCAG AA
    And фоны не «чёрный на чёрном» / «белый на белом»
    And в `theme=dark` то же самое
    And focus-rings видны при keyboard-навигации

    Examples:
      | page                                |
      | /studies                            |
      | /studies/<slug>                     |
      | /studies/<slug>/<chId>              |
      | /studies/c/<chId>                   |
      | /studies/<slug>/<chId>/play         |

  Scenario Outline: <page> работоспособна на mobile (414×896)
    Given viewport 414×896
    When пользователь на <page>
    Then header / actions / основной контент доступны (не overflow off-screen)
    And тапы по интерактивным элементам размером ≥44×44px
    And горизонтального скролла нет

    Examples:
      | page                                |
      | /studies                            |
      | /studies/<slug>                     |
      | /studies/<slug>/<chId>              |
      | /studies/c/<chId>                   |
      | /studies/<slug>/<chId>/play         |

# ─────────────────────────────────────────────────────────────────────
# Карта сценариев → известные баги (для пошагового регресс-чек-листа)
#
#  • KS-2904 delete chapter / textarea light / ad-hoc PGN leak:
#      - Feature «StudyPage» — «Удаление главы из списка»
#      - Feature «Editor desktop» — «Delete chapter из editor»
#      - Feature «CreateStudyDialog» — «Textarea описания читаемо»
#      - Feature «Создание главы» — «после ранее открытого ad-hoc анализа»
#  • KS-2905 breadcrumb «Workshop» на study editor:
#      - Feature «Breadcrumb (regression KS-2905)» — все 3 сценария
#      - Feature «Создание главы» — «breadcrumb section равен Студии»
#  • KS-2906 mobile editor без header'а:
#      - Feature «Editor mobile (regression KS-2906)» — все сценарии
#  • KS-2907 gamebook reader 404 для owner на private/unlisted:
#      - Feature «Gamebook reader» — «Owner может играть gamebook на private/unlisted»
#
# Документ — единственный источник acceptance для QA-прогона Wave A.
# Любое расширение функционала — добавлять scenario сюда ДО мерджа.
