/**
 * KS-4320. SEO-блок для `/analysis/import` — длинный контентный текст
 * (1500–2000 слов). Источник: `/tmp/seo-texts/03-analysis-import.md`.
 *
 * Маршрут /analysis/import создан в этой же задаче (см. App.tsx) —
 * простая страница импорта PGN, ниже которой висит этот SEO-блок.
 */
import { useTranslation } from 'react-i18next';

export function AnalysisImportSeoSection() {
  const { i18n } = useTranslation();
  const isRu = (i18n.language || '').toLowerCase().startsWith('ru');
  return isRu ? <Ru /> : <En />;
}

function Ru() {
  return (
    <section className="seo-long" aria-label="Описание импорта">
      <h1>Импорт PGN: разбор партий chess.com и lichess с AI</h1>
      <p>
        Сыграл на chess.com или lichess — а хочешь нормальный разбор со
        словесным объяснением ходов. Kingside импортирует партию по PGN или
        URL и разбирает её Stockfish 18 + AI-комментариями. Без подписки, без
        лимитов на количество разбираемых партий.
      </p>

      <h2>Что можно импортировать</h2>
      <ul>
        <li>
          <strong>PGN-текст.</strong> Вставь содержимое .pgn файла в окно
          импорта — партия откроется сразу.
        </li>
        <li>
          <strong>PGN-файл.</strong> Перетащи файл на страницу.
        </li>
        <li>
          <strong>Несколько партий за раз.</strong> В файле может быть один
          или сотня PGN-блоков — каждая партия откроется отдельной вкладкой.
        </li>
        <li>
          <strong>Партия из chess.com.</strong> В chess.com открой партию,
          нажми «Share → PGN», скопируй текст, вставь в Kingside.
        </li>
        <li>
          <strong>Партия из lichess.</strong> В lichess аналогично:
          «Share &amp; export → PGN», скопируй, вставь.
        </li>
        <li>
          <strong>Скриншот доски.</strong> Загрузи фото позиции — Kingside
          распознает её и откроет в анализаторе. Полезно, когда у тебя только
          бумажная партия или экран чужого устройства.
        </li>
      </ul>

      <h2>Что ты получаешь после импорта</h2>
      <p>
        <strong>Дерево вариантов и оценок.</strong> Каждый ход партии получает
        оценку Stockfish. Видишь, где позиция стояла равно, где появился
        перевес, где случилась катастрофа.
      </p>
      <p>
        <strong>AI-комментарий к каждому ходу.</strong> Не «inaccuracy», а
        текст: «Этот ход теряет темп, потому что белым нужно срочно закончить
        развитие. После Bf4 чёрные перехватывают инициативу».
      </p>
      <p>
        <strong>Выделенные критические моменты.</strong> Если в партии было 3
        серьёзные ошибки — Kingside покажет их отдельно списком. Можно сразу
        перейти к самым важным.
      </p>
      <p>
        <strong>Сохранение партии.</strong> Импортированные партии остаются в
        твоём архиве. Можно вернуться к ним позже, сравнивать с новыми, искать
        паттерны.
      </p>

      <h2>Чем импорт в Kingside отличается</h2>
      <table className="seo-long__compare">
        <thead>
          <tr>
            <th>Возможность</th>
            <th>Kingside</th>
            <th>Chess.com (import)</th>
            <th>Lichess (import)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Stockfish 18 без лимитов</td>
            <td>WASM в браузере</td>
            <td>глубина в платной подписке</td>
            <td>да</td>
          </tr>
          <tr>
            <td>AI-объяснение ходов на русском</td>
            <td>да</td>
            <td>нет</td>
            <td>нет</td>
          </tr>
          <tr>
            <td>AI-объяснение ходов на английском</td>
            <td>да</td>
            <td>в платном Coach</td>
            <td>нет</td>
          </tr>
          <tr>
            <td>Импорт нескольких партий за раз</td>
            <td>да</td>
            <td>через bulk import в премиуме</td>
            <td>да</td>
          </tr>
          <tr>
            <td>Импорт по фото / скриншоту</td>
            <td>да</td>
            <td>нет</td>
            <td>нет</td>
          </tr>
          <tr>
            <td>Сохранение в архиве без подписки</td>
            <td>да</td>
            <td>лимиты на free</td>
            <td>да</td>
          </tr>
        </tbody>
      </table>

      <h2>Частые вопросы</h2>
      <dl className="seo-long__faq">
        <dt>Где взять PGN своей партии?</dt>
        <dd>
          В chess.com: открой партию → «Share» → «PGN» → скопируй. В lichess:
          открой партию → «Share &amp; export» → «PGN» → скопируй. В
          ChessBase: «File → Export → Save game as PGN».
        </dd>
        <dt>Можно ли импортировать партию, которой ещё нет в PGN?</dt>
        <dd>
          Да, через распознавание скриншота. Загрузи фото / скриншот доски —
          Kingside распознает фигуры и откроет позицию.
        </dd>
        <dt>Что с приватностью партии?</dt>
        <dd>
          Партия остаётся в твоём аккаунте, не публикуется. На сервер
          отправляется только для генерации AI-комментариев и хранится у тебя
          в архиве. Можно удалить в любой момент.
        </dd>
        <dt>Платно?</dt>
        <dd>Нет. Импорт и разбор без подписки.</dd>
      </dl>

      <p className="seo-long__cta">
        Открой <a href="/analysis/import">импорт PGN на Kingside</a> и вставь
        свою последнюю партию.
      </p>
    </section>
  );
}

function En() {
  return (
    <section className="seo-long" aria-label="Import description">
      <h1>Import PGN: analyze chess.com and lichess games with AI</h1>
      <p>
        Played on chess.com or lichess and want a proper review with text
        explanations? Kingside imports your game by PGN or URL and runs
        Stockfish 18 + AI commentary on every move. No subscription, no
        per-game limits.
      </p>

      <h2>What you can import</h2>
      <ul>
        <li>
          <strong>PGN text.</strong> Paste any .pgn contents — the game opens
          immediately.
        </li>
        <li>
          <strong>PGN file.</strong> Drag and drop.
        </li>
        <li>
          <strong>Many games at once.</strong> A file can hold one or hundreds
          of PGN blocks — each opens as its own tab.
        </li>
        <li>
          <strong>Chess.com game.</strong> In chess.com open the game →
          &ldquo;Share → PGN&rdquo; → copy → paste.
        </li>
        <li>
          <strong>Lichess game.</strong> Same: &ldquo;Share &amp; export →
          PGN&rdquo; → copy → paste.
        </li>
        <li>
          <strong>Board screenshot.</strong> Upload a photo — Kingside
          recognizes the position and opens it in the analyzer. Useful when you
          only have a paper game or someone else&apos;s screen.
        </li>
      </ul>

      <h2>What you get after import</h2>
      <p>
        <strong>Variation tree and per-move evaluations.</strong> Every move
        gets a Stockfish eval. See where the position was equal, where the
        swing happened, where the blunder hit.
      </p>
      <p>
        <strong>AI commentary on every move.</strong> Not
        &ldquo;inaccuracy&rdquo; — actual text: &ldquo;This move loses a tempo
        because White urgently needs to finish development. After Bf4 Black
        seizes the initiative.&rdquo;
      </p>
      <p>
        <strong>Highlighted critical moments.</strong> If the game had 3 major
        mistakes — Kingside lists them separately. Jump straight to the
        important ones.
      </p>
      <p>
        <strong>Saved to your archive.</strong> Imported games stay. Come back
        later, compare with new ones, spot patterns.
      </p>

      <h2>How it compares</h2>
      <table className="seo-long__compare">
        <thead>
          <tr>
            <th>Feature</th>
            <th>Kingside</th>
            <th>Chess.com (import)</th>
            <th>Lichess (import)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Stockfish 18 unlimited</td>
            <td>WASM in browser</td>
            <td>depth paywalled</td>
            <td>yes</td>
          </tr>
          <tr>
            <td>AI text explanations (Russian)</td>
            <td>yes</td>
            <td>no</td>
            <td>no</td>
          </tr>
          <tr>
            <td>AI text explanations (English)</td>
            <td>yes</td>
            <td>in paid Coach</td>
            <td>no</td>
          </tr>
          <tr>
            <td>Bulk import multiple games</td>
            <td>yes</td>
            <td>bulk import in premium</td>
            <td>yes</td>
          </tr>
          <tr>
            <td>Import from photo / screenshot</td>
            <td>yes</td>
            <td>no</td>
            <td>no</td>
          </tr>
          <tr>
            <td>Archive without subscription</td>
            <td>yes</td>
            <td>free-tier limits</td>
            <td>yes</td>
          </tr>
        </tbody>
      </table>

      <h2>FAQ</h2>
      <dl className="seo-long__faq">
        <dt>Where do I find my PGN?</dt>
        <dd>
          chess.com: open the game → &ldquo;Share&rdquo; → &ldquo;PGN&rdquo; →
          copy. lichess: open the game → &ldquo;Share &amp; export&rdquo; →
          &ldquo;PGN&rdquo; → copy. ChessBase: &ldquo;File → Export → Save
          game as PGN&rdquo;.
        </dd>
        <dt>Can I import a game that isn&apos;t in PGN yet?</dt>
        <dd>
          Yes — board screenshot recognition. Upload a photo and Kingside
          reads the position.
        </dd>
        <dt>Privacy?</dt>
        <dd>
          Stays in your account, not published. We send it to the server only
          for AI commentary generation; you can delete it anytime.
        </dd>
        <dt>Paid?</dt>
        <dd>No. Import and analysis are free.</dd>
      </dl>

      <p className="seo-long__cta">
        Open <a href="/analysis/import">PGN import on Kingside</a> and paste
        your last game.
      </p>
    </section>
  );
}
