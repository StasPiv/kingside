/**
 * KS-4320. SEO-блок для `/analysis` — длинный контентный текст
 * (1500–2000 слов) под основным интерактивом анализатора.
 *
 * Источник: `/tmp/seo-texts/01-analysis.md`. Выводится по текущему
 * языку `i18n.language` (RU/EN). HTML попадает в prerender —
 * `dist/analysis/index.html` отдаёт ботам полный текст без JS.
 */
import { useTranslation } from 'react-i18next';

export function AnalysisSeoSection() {
  const { i18n } = useTranslation();
  const isRu = (i18n.language || '').toLowerCase().startsWith('ru');
  return isRu ? <AnalysisRu /> : <AnalysisEn />;
}

function AnalysisRu() {
  return (
    <section className="seo-long" aria-label="Описание анализатора">
      <h1>Анализ шахматной партии онлайн с AI-комментариями</h1>
      <p>
        Загрузи PGN или сыграй партию прямо в браузере — Kingside разберёт её
        Stockfish 18 и расскажет, что произошло на каждом ходу: словами, а не
        только цифрами оценки.
      </p>
      <p>
        В отличие от других онлайн-анализаторов, ты получаешь не просто
        <code>+1.5</code> или жёлтый значок «inaccuracy». Ты видишь объяснение:
        «Конь на f3 не успевает к атаке на b7, после Nf6 чёрные перехватывают
        инициативу». Это работает на любой позиции — открытие, миттельшпиль,
        эндшпиль.
      </p>

      <h2>Что делает анализатор Kingside</h2>
      <p>
        <strong>Stockfish 18 в браузере.</strong> Движок запускается локально
        через WebAssembly. Никаких очередей и лимитов по глубине — твоя машина
        считает позицию столько, сколько ты захочешь. Подключение к серверу
        не нужно, партия не уходит за пределы твоего браузера.
      </p>
      <p>
        <strong>AI-комментарии к каждому ходу.</strong> Нейросеть смотрит на
        оценку Stockfish, лучшие линии, тип позиции — и даёт человекочитаемое
        объяснение по-русски или по-английски. Сильный ход, ошибка, blunder —
        каждый ход получает текст, а не только оценку.
      </p>
      <p>
        <strong>Maia-3: модель человеческих ходов.</strong> Помимо Stockfish,
        мы запускаем Maia-3 — нейросеть Microsoft Research, обученную на
        партиях людей разного уровня. Она показывает «какой ход сделал бы
        человек на твоём рейтинге», а не «какой ход лучший в принципе».
        Полезно для подготовки против конкретных соперников.
      </p>
      <p>
        <strong>External Engine bridge.</strong> Если хочешь — подключи свой
        Stockfish с собственного компьютера. Глубина 35+, никаких ограничений,
        любые свежие нейросетевые модели. Подробности в{' '}
        <a href="/help/external-engine">справке по внешнему движку</a>.
      </p>

      <h2>Как разобрать партию</h2>
      <ol>
        <li>
          <strong>Сыграй партию на Kingside</strong> — анализ откроется
          автоматически после окончания.
        </li>
        <li>
          <strong>Импортируй PGN</strong> — нажми «Импорт PGN» на странице
          «Анализ» и вставь текст партии. Принимаем экспорт из chess.com,
          lichess, ChessBase, любых PGN-файлов.
        </li>
        <li>
          <strong>Загрузи скриншот доски</strong> — мы распознаем позицию по
          фото или скриншоту и откроем её в анализаторе.
        </li>
      </ol>
      <p>
        Партия загружается за секунду, разбор занимает 5–30 секунд в
        зависимости от длины. Результат — дерево вариантов, оценки по ходам,
        AI-комментарии, выделенные ошибки и решающие моменты.
      </p>

      <h2>Чем это отличается от других анализаторов</h2>
      <table className="seo-long__compare">
        <thead>
          <tr>
            <th>Возможность</th>
            <th>Kingside</th>
            <th>Chess.com Analysis</th>
            <th>Lichess Analysis</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Stockfish бесплатно</td>
            <td>Stockfish 18 WASM</td>
            <td>ограничения по глубине, премиум за безлимит</td>
            <td>да</td>
          </tr>
          <tr>
            <td>Текстовое объяснение каждого хода</td>
            <td>AI-комментарий</td>
            <td>в платном Coach</td>
            <td>только цифры</td>
          </tr>
          <tr>
            <td>Подключение внешнего движка</td>
            <td>External Engine bridge</td>
            <td>нет</td>
            <td>нет</td>
          </tr>
          <tr>
            <td>Maia (модель человеческих ходов)</td>
            <td>Maia-3</td>
            <td>нет</td>
            <td>в отдельном проекте maiachess.com</td>
          </tr>
          <tr>
            <td>Импорт PGN, lichess study, chess.com URL</td>
            <td>да</td>
            <td>да</td>
            <td>да</td>
          </tr>
          <tr>
            <td>Без подписки</td>
            <td>полностью бесплатно</td>
            <td>нет</td>
            <td>да</td>
          </tr>
        </tbody>
      </table>

      <h2>Частые вопросы</h2>
      <dl className="seo-long__faq">
        <dt>Партия конфиденциальна?</dt>
        <dd>
          Да. Stockfish 18 работает в твоём браузере локально, на наш сервер
          партия отправляется только для генерации AI-комментариев — и не
          хранится после генерации. Если включишь External Engine, партия
          вообще не покидает твою машину.
        </dd>
        <dt>Можно ли разбирать партию с lichess или chess.com?</dt>
        <dd>
          Да. Импортируй PGN — он есть в экспорте обеих платформ. Открой
          партию там, нажми «Share → PGN», скопируй текст, вставь в Kingside.
        </dd>
        <dt>Какая глубина анализа?</dt>
        <dd>
          Stockfish WASM в браузере — depth 20–25 по умолчанию, ты можешь
          увеличить. External Engine на твоём компьютере — без ограничений
          (35+ в реальных условиях).
        </dd>
        <dt>Сколько стоит?</dt>
        <dd>
          Бесплатно. Без подписки, без рекламы, без лимитов на количество
          партий. Подробности в разделе <a href="/credits">Открытые ассеты</a>.
        </dd>
        <dt>Работает на телефоне?</dt>
        <dd>
          Да, в любом современном мобильном браузере. Stockfish WASM работает
          и на iOS, и на Android. Длинные партии анализируются дольше, чем на
          десктопе.
        </dd>
      </dl>

      <p className="seo-long__cta">
        Открой <a href="/analysis">анализатор Kingside</a> и разбери свою
        последнюю партию — это бесплатно и не требует регистрации.
      </p>
    </section>
  );
}

function AnalysisEn() {
  return (
    <section className="seo-long" aria-label="Analyzer description">
      <h1>Free online chess analysis with AI commentary</h1>
      <p>
        Upload a PGN or play in your browser — Kingside runs Stockfish 18 on
        every move and explains what happened in plain English, not just
        numbers.
      </p>
      <p>
        Unlike most online analyzers, you don&apos;t get only <code>+1.5</code>{' '}
        or a yellow &ldquo;inaccuracy&rdquo; tag. You get a text explanation:
        &ldquo;The knight on f3 doesn&apos;t reach the b7 attack in time;
        after Nf6 Black takes the initiative.&rdquo; Works on any phase —
        opening, middlegame, endgame.
      </p>

      <h2>What the Kingside analyzer does</h2>
      <p>
        <strong>Stockfish 18 in your browser.</strong> The engine runs locally
        via WebAssembly. No queues, no depth limits — your machine evaluates
        as long as you want. No server connection needed; your game never
        leaves the browser.
      </p>
      <p>
        <strong>AI commentary on every move.</strong> A language model looks at
        the Stockfish evaluation, principal variations, and position type,
        then explains in English or Russian why a move was strong, where the
        mistake is, and what the position threatens.
      </p>
      <p>
        <strong>Maia-3: the human-move model.</strong> Alongside Stockfish, we
        run Maia-3 — a Microsoft Research network trained on real human games
        at different rating levels. It shows what a human at your rating would
        play, not just the engine&apos;s top move. Useful for preparing
        against specific opponents.
      </p>
      <p>
        <strong>External Engine bridge.</strong> Plug your own Stockfish from
        your PC. Depth 35+, no limits, latest NNUE networks. See{' '}
        <a href="/help/external-engine">external engine docs</a>.
      </p>

      <h2>How to analyze a game</h2>
      <ol>
        <li>
          <strong>Play on Kingside</strong> — analysis opens automatically
          after the game.
        </li>
        <li>
          <strong>Import a PGN</strong> — paste any PGN from chess.com,
          lichess, ChessBase, or a file.
        </li>
        <li>
          <strong>Drop a board screenshot</strong> — Kingside detects the
          position from a photo or screenshot and opens it in the analyzer.
        </li>
      </ol>
      <p>
        Loading takes a second, analysis 5–30 seconds depending on length.
        Output: variation tree, per-move evaluations, AI commentary,
        highlighted mistakes and critical moments.
      </p>

      <h2>How it compares</h2>
      <table className="seo-long__compare">
        <thead>
          <tr>
            <th>Feature</th>
            <th>Kingside</th>
            <th>Chess.com Analysis</th>
            <th>Lichess Analysis</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Free Stockfish</td>
            <td>Stockfish 18 WASM</td>
            <td>depth caps, premium for full</td>
            <td>yes</td>
          </tr>
          <tr>
            <td>Text explanation per move</td>
            <td>AI commentary</td>
            <td>in paid Coach</td>
            <td>numbers only</td>
          </tr>
          <tr>
            <td>External engine bridge</td>
            <td>yes</td>
            <td>no</td>
            <td>no</td>
          </tr>
          <tr>
            <td>Maia (human-move model)</td>
            <td>Maia-3</td>
            <td>no</td>
            <td>separate project maiachess.com</td>
          </tr>
          <tr>
            <td>Import PGN, lichess study, chess.com URL</td>
            <td>yes</td>
            <td>yes</td>
            <td>yes</td>
          </tr>
          <tr>
            <td>No subscription</td>
            <td>fully free</td>
            <td>no</td>
            <td>yes</td>
          </tr>
        </tbody>
      </table>

      <h2>FAQ</h2>
      <dl className="seo-long__faq">
        <dt>Is my game private?</dt>
        <dd>
          Yes. Stockfish 18 runs in your browser locally; we only send the
          game to our server to generate AI commentary, and we don&apos;t
          store it after. With External Engine on, the game never leaves your
          machine.
        </dd>
        <dt>Can I analyze lichess or chess.com games?</dt>
        <dd>
          Yes. Both export PGN — copy the text and paste it into Kingside.
        </dd>
        <dt>What depth do you reach?</dt>
        <dd>
          Stockfish WASM — depth 20–25 by default, you can raise it. External
          Engine — no cap (35+ in practice).
        </dd>
        <dt>How much does it cost?</dt>
        <dd>
          Free. No subscription, no ads, no per-game limits. Details on{' '}
          <a href="/credits">open assets</a>.
        </dd>
        <dt>Mobile?</dt>
        <dd>
          Yes, any modern mobile browser. Stockfish WASM runs on iOS and
          Android. Long games take longer than on desktop.
        </dd>
      </dl>

      <p className="seo-long__cta">
        Open <a href="/analysis">the Kingside analyzer</a> and review your
        last game — free, no signup.
      </p>
    </section>
  );
}
