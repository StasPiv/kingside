/**
 * KS-4325 (текст из KS-4320). SEO-блок для публичного лендинга
 * `/puzzles-from-your-games` — длинный контентный текст (1500–2000
 * слов). Источник: `/tmp/seo-texts/02-puzzles-mistakes.md`.
 *
 * История: текст изначально жил на `/puzzles/mistakes`, но тот
 * маршрут под `<ProtectedRoute>` и для бота недоступен. Маркетолог в
 * KS-4324 перенёс на отдельный гостевой URL под long-tail-запрос
 * «puzzles from your own games». CTA внутри ведёт на `/puzzles/
 * mistakes` — оттуда пользователь при необходимости пройдёт логин
 * и попадёт в свой рабочий раздел тематических ошибок.
 */
import { useTranslation } from 'react-i18next';

export function PuzzlesFromYourGamesSeoSection() {
  const { i18n } = useTranslation();
  const isRu = (i18n.language || '').toLowerCase().startsWith('ru');
  return isRu ? <Ru /> : <En />;
}

function Ru() {
  return (
    <section className="seo-long" aria-label="Описание раздела">
      <h1>Задачи из своих партий: тренируйся на своих ошибках</h1>
      <p>
        Большинство шахматных тренажёров дают тебе чужие задачи — на которые
        ты не похож, в позициях, в которые ты не попадаешь. Kingside делает
        наоборот: смотрит на твои партии, находит конкретные моменты, где ты
        ошибся, и превращает их в задачи.
      </p>
      <p>
        Это уникальная фича. Ни chess.com, ни lichess не дают тренировку на
        твоих собственных партиях в формате задач. У chess.com есть «Insights»,
        у lichess есть «Learn from your mistakes» — это статистика и подсказки
        в анализе, но не настоящие задачи с подсчётом рейтинга и серии.
      </p>

      <h2>Как это работает</h2>
      <ol>
        <li>
          <strong>Сыграй партию или загрузи PGN.</strong> Принимаем экспорт
          chess.com, lichess, ChessBase, PGN-файлы, ручной ввод.
        </li>
        <li>
          <strong>Kingside разбирает партию.</strong> Stockfish 18 находит
          ошибки — каждый ход, который меняет оценку позиции на 1.5+ пешки,
          помечается как кандидат.
        </li>
        <li>
          <strong>Фильтр на «обучаемое».</strong> Не каждая ошибка становится
          задачей: позиции, где правильный ход — длинная теоретическая линия
          или эндшпильный приём, который ты ещё не знаешь, отбрасываются.
          Остаются тактические задачи с чётким решением.
        </li>
        <li>
          <strong>Серия для тренировки.</strong> Задачи собираются в серию. Ты
          решаешь её как обычный пазл — с подсветкой подсказок, проверкой
          решения, разбором ошибки.
        </li>
      </ol>

      <h2>Что внутри</h2>
      <p>
        <strong>Связь с разбором партии.</strong> Каждая задача ссылается на
        исходную партию. Решил — можешь сразу открыть позицию в анализаторе и
        посмотреть AI-комментарий: почему этот ход был сильнее, что ты упустил.
      </p>
      <p>
        <strong>Spaced repetition.</strong> Если решил неверно — задача
        вернётся через несколько дней. Если решил быстро и правильно —
        следующее повторение через неделю, потом месяц. Алгоритм похож на Anki.
      </p>
      <p>
        <strong>Лидерборд по серии.</strong> Сколько задач из своих партий ты
        решил подряд правильно — это отдельный счётчик. Можно соревноваться с
        друзьями.
      </p>

      <h2>Когда это работает лучше всего</h2>
      <ul>
        <li>
          <strong>После турнира.</strong> Загрузил все партии — получил серию
          задач именно на тех моментах, где проиграл. За вечер прорабатываешь
          весь турнир.
        </li>
        <li>
          <strong>Тематически.</strong> Если знаешь, что у тебя слабые
          эндшпиля — отфильтруй задачи по фазе партии. Получишь серию из
          эндшпильных моментов, где ты ошибался.
        </li>
        <li>
          <strong>После длительного перерыва.</strong> Сыграл 5–10 партий,
          загрузил, получил картину «что я разучился делать». Не теория из
          книги, а твои конкретные дыры.
        </li>
      </ul>

      <h2>Частые вопросы</h2>
      <dl className="seo-long__faq">
        <dt>Партии остаются приватными?</dt>
        <dd>
          Партии видны только тебе. На сервер отправляются для разбора
          Stockfish и генерации задач, не публикуются.
        </dd>
        <dt>Какой формат PGN принимается?</dt>
        <dd>
          Любой стандартный PGN: chess.com (через Settings → Account →
          Download Games), lichess (через Profile → Export), ChessBase,
          ручной ввод. Несколько партий в одном файле — поддерживается.
        </dd>
        <dt>Сколько задач генерируется из одной партии?</dt>
        <dd>
          В среднем 1–3. Зависит от количества ошибок и того, какие из них
          прошли фильтр «обучаемое».
        </dd>
        <dt>Что делать с задачами после решения?</dt>
        <dd>
          Они уходят в режим интервального повторения. Через несколько дней
          система вернёт ту, что ты решил с трудом или неправильно.
        </dd>
        <dt>Подходит для начинающих?</dt>
        <dd>
          Да. Особенно для начинающих — на твоём уровне у тебя много простых
          тактических ошибок, и Kingside делает из них именно простые
          тактические задачи. Не нужно решать чужие задачи на 2200, когда ты
          играешь на 1300.
        </dd>
      </dl>

      <p className="seo-long__cta">
        Открой{' '}
        <a href="/puzzles/mistakes">тренажёр задач из своих партий</a> и
        загрузи первую партию.
      </p>
    </section>
  );
}

function En() {
  return (
    <section className="seo-long" aria-label="Section description">
      <h1>Chess puzzles from your own games</h1>
      <p>
        Most chess trainers give you someone else&apos;s puzzles — in positions
        you don&apos;t reach, by players who don&apos;t play like you.
        Kingside flips that: it looks at your games, finds the exact moments
        where you went wrong, and turns them into puzzles.
      </p>
      <p>
        This is a unique feature. Neither chess.com nor lichess offers training
        on your own games as actual puzzles. Chess.com has
        &ldquo;Insights,&rdquo; lichess has &ldquo;Learn from your
        mistakes&rdquo; — those are stats and inline hints in analysis, not
        real puzzles with rating and streak tracking.
      </p>

      <h2>How it works</h2>
      <ol>
        <li>
          <strong>Play a game or upload a PGN.</strong> We accept exports from
          chess.com, lichess, ChessBase, PGN files, or manual input.
        </li>
        <li>
          <strong>Kingside reviews the game.</strong> Stockfish 18 finds your
          mistakes — every move that swings the eval by 1.5+ pawns is flagged.
        </li>
        <li>
          <strong>Trainability filter.</strong> Not every mistake becomes a
          puzzle: positions where the right answer is a long theoretical line
          or an endgame technique you don&apos;t know yet are dropped.
          What&apos;s left are tactical puzzles with a clear solution.
        </li>
        <li>
          <strong>Training streak.</strong> Puzzles get bundled into a session.
          You solve them like regular puzzles — with hints, solution check,
          and a mistake review.
        </li>
      </ol>

      <h2>What&apos;s inside</h2>
      <p>
        <strong>Link back to the original game.</strong> Each puzzle links to
        the source game. Solved it — open the position in the analyzer and
        read the AI commentary: why that move was stronger, what you missed.
      </p>
      <p>
        <strong>Spaced repetition.</strong> Got it wrong? It comes back in a
        few days. Got it fast and right? Next review in a week, then a month.
        Anki-style algorithm.
      </p>
      <p>
        <strong>Streak leaderboard.</strong> How many of your own-mistake
        puzzles you&apos;ve solved in a row — a separate counter. Compete with
        friends.
      </p>

      <h2>Best uses</h2>
      <ul>
        <li>
          <strong>After a tournament.</strong> Upload all games — get a session
          of puzzles from the exact moments you lost. An evening to work
          through the whole event.
        </li>
        <li>
          <strong>By theme.</strong> If endgames are your weak spot — filter by
          phase. You&apos;ll get a session of endgame moments where you erred.
        </li>
        <li>
          <strong>After a break.</strong> Play 5–10 games, upload them, and
          see what you&apos;ve forgotten. Not theory from a book — your actual
          gaps.
        </li>
      </ul>

      <h2>FAQ</h2>
      <dl className="seo-long__faq">
        <dt>Are my games private?</dt>
        <dd>
          Visible only to you. We send them to the server to run Stockfish and
          generate puzzles; we don&apos;t publish them.
        </dd>
        <dt>What PGN formats are supported?</dt>
        <dd>
          Any standard PGN: chess.com (Settings → Account → Download Games),
          lichess (Profile → Export), ChessBase, manual input. Multiple games
          per file — supported.
        </dd>
        <dt>How many puzzles per game?</dt>
        <dd>
          1–3 on average. Depends on how many mistakes and how many pass the
          trainability filter.
        </dd>
        <dt>What happens after I solve them?</dt>
        <dd>
          They go into spaced repetition. A few days later, the system brings
          back the ones you struggled with.
        </dd>
        <dt>Good for beginners?</dt>
        <dd>
          Especially good for beginners. At your level you make many simple
          tactical mistakes, and Kingside turns them into matching simple
          puzzles. You don&apos;t need to grind 2200-rated puzzles when you
          play at 1300.
        </dd>
      </dl>

      <p className="seo-long__cta">
        Open <a href="/puzzles/mistakes">puzzles from your own games</a> and
        upload your first PGN.
      </p>
    </section>
  );
}
