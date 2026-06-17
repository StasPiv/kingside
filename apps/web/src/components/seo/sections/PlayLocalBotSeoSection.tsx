/**
 * KS-4320. SEO-блок для `/play/local-bot` — длинный контентный текст
 * (1500 слов). Источник: `/tmp/seo-texts/04-play-local-bot.md`.
 *
 * Маршрут открыт гостям без auth, добавлен в `PUBLIC_ROUTES` для
 * prerender — `dist/play/local-bot/index.html` отдаёт ботам полный
 * текст без JS.
 */
import { useTranslation } from 'react-i18next';

export function PlayLocalBotSeoSection() {
  const { i18n } = useTranslation();
  const isRu = (i18n.language || '').toLowerCase().startsWith('ru');
  return isRu ? <Ru /> : <En />;
}

function Ru() {
  return (
    <section className="seo-long" aria-label="Описание игры с ботом">
      <h1>Играть в шахматы с ботом онлайн бесплатно без регистрации</h1>
      <p>
        Открой страницу — выбери силу соперника — играй. Без регистрации, без
        подписки, без рекламы. Бот Kingside крутит Stockfish 18 локально в
        твоём браузере, поэтому партия не уходит на сервер и работает офлайн
        после загрузки страницы.
      </p>

      <h2>Что внутри</h2>
      <p>
        <strong>20+ уровней силы.</strong> От «новичок, ходит наугад» до
        «гроссмейстер». Можешь начать со слабого бота и постепенно повышать
        сложность.
      </p>
      <p>
        <strong>Несколько стилей игры.</strong> Maia-3 (нейросеть, обученная
        на партиях людей разного рейтинга) — играет как живой человек, делает
        понятные ошибки. Stockfish — играет максимально сильно. Можешь
        выбрать, против кого тренироваться.
      </p>
      <p>
        <strong>Любые контроли времени.</strong> Bullet, blitz, rapid,
        classical, без часов — выбирай как удобно.
      </p>
      <p>
        <strong>Без регистрации.</strong> Партия открывается сразу. Если потом
        захочешь сохранить — зарегистрируешься в один клик.
      </p>

      <h2>Зачем играть с ботом, если есть онлайн-соперники</h2>
      <ul>
        <li>
          <strong>Тренировка конкретных позиций.</strong> Хочешь отработать
          сицилианку — выставляешь стартовую позицию через FEN, играешь с
          ботом из этой позиции.
        </li>
        <li>
          <strong>Без давления времени и рейтинга.</strong> Не страшно
          потерять очки — просто играешь и учишься.
        </li>
        <li>
          <strong>Доступно офлайн.</strong> Загрузил страницу — можешь играть
          в самолёте или в метро, бот работает локально.
        </li>
        <li>
          <strong>Тренировка против конкретного стиля.</strong> Maia-3 даёт
          ощущение живого соперника на твоём уровне.
        </li>
      </ul>

      <h2>Как начать</h2>
      <ol>
        <li>
          Открой <a href="/play/local-bot">страницу игры с ботом</a>.
        </li>
        <li>
          Выбери силу соперника (по умолчанию — твой ориентировочный рейтинг).
        </li>
        <li>Выбери контроль времени или играй без часов.</li>
        <li>Нажми «Начать» — игра пошла.</li>
      </ol>
      <p>
        После окончания партии откроется разбор: Stockfish 18 + AI-комментарии
        к каждому ходу. Можешь сразу понять, где ошибся.
      </p>

      <h2>Частые вопросы</h2>
      <dl className="seo-long__faq">
        <dt>Точно бесплатно?</dt>
        <dd>
          Да. Никакой подписки, никаких лимитов на количество партий. См.{' '}
          <a href="/credits">Открытые ассеты</a>.
        </dd>
        <dt>Без регистрации?</dt>
        <dd>
          Да. Регистрация нужна только если хочешь сохранять партии, видеть
          свой архив и тренироваться на собственных ошибках.
        </dd>
        <dt>На телефоне работает?</dt>
        <dd>
          Да, в любом мобильном браузере. Stockfish 18 WASM работает на iOS и
          Android. На слабых устройствах сильные боты могут думать медленнее
          — выбирай уровень по комфорту.
        </dd>
        <dt>Бот действительно играет как человек?</dt>
        <dd>
          Если выбран Maia-3 — да. Это нейросеть Microsoft Research, обученная
          на партиях людей. На слабых уровнях делает «человеческие» ошибки, а
          не случайные.
        </dd>
        <dt>Можно играть из произвольной позиции?</dt>
        <dd>Да. Введи FEN — бот начнёт партию с этой позиции.</dd>
      </dl>

      <p className="seo-long__cta">
        Открой <a href="/play/local-bot">игру с ботом на Kingside</a> и
        начинай.
      </p>
    </section>
  );
}

function En() {
  return (
    <section className="seo-long" aria-label="Play vs bot description">
      <h1>Play chess vs bot online free, no signup</h1>
      <p>
        Open the page — pick a level — play. No signup, no subscription, no
        ads. The Kingside bot runs Stockfish 18 locally in your browser, so
        your game never leaves the device and keeps working offline after the
        page loads.
      </p>

      <h2>What&apos;s inside</h2>
      <p>
        <strong>20+ skill levels.</strong> From &ldquo;beginner who plays at
        random&rdquo; to &ldquo;grandmaster.&rdquo; Start weak, ramp up.
      </p>
      <p>
        <strong>Multiple play styles.</strong> Maia-3 — a network trained on
        real human games at different ratings — plays like a person and makes
        plausible mistakes. Stockfish — plays as strong as it can. Pick who
        you train against.
      </p>
      <p>
        <strong>Any time control.</strong> Bullet, blitz, rapid, classical,
        or no clock.
      </p>
      <p>
        <strong>No signup.</strong> The game opens instantly. Want to save it
        later? One-click registration.
      </p>

      <h2>Why play a bot when you can play humans online</h2>
      <ul>
        <li>
          <strong>Practice specific positions.</strong> Drilling the Sicilian
          — paste a FEN, play the bot from that position.
        </li>
        <li>
          <strong>No clock pressure, no rating loss.</strong> Just play and
          learn.
        </li>
        <li>
          <strong>Works offline.</strong> Page loaded? Play on a plane or in
          the subway.
        </li>
        <li>
          <strong>Practice against a style.</strong> Maia-3 feels like a real
          opponent at your level.
        </li>
      </ul>

      <h2>How to start</h2>
      <ol>
        <li>
          Open <a href="/play/local-bot">the bot page</a>.
        </li>
        <li>Pick the bot&apos;s strength (defaults near your rating).</li>
        <li>Pick a time control or play untimed.</li>
        <li>Hit &ldquo;Start&rdquo; — go.</li>
      </ol>
      <p>
        After the game, analysis opens automatically: Stockfish 18 + AI
        commentary per move. Instantly see where you went wrong.
      </p>

      <h2>FAQ</h2>
      <dl className="seo-long__faq">
        <dt>Really free?</dt>
        <dd>
          Yes. No subscription, no per-game limits. See{' '}
          <a href="/credits">open assets</a>.
        </dd>
        <dt>No signup?</dt>
        <dd>
          Right. Signup is only for saving games, your archive, and training
          on your own mistakes.
        </dd>
        <dt>Mobile?</dt>
        <dd>
          Yes, any modern mobile browser. Stockfish 18 WASM runs on iOS and
          Android. Weak devices may need lower-strength bots to keep things
          snappy.
        </dd>
        <dt>Does the bot really play like a human?</dt>
        <dd>
          With Maia-3, yes. It&apos;s a Microsoft Research network trained on
          human games. At lower ratings it makes human-shaped mistakes, not
          random ones.
        </dd>
        <dt>Can I start from an arbitrary position?</dt>
        <dd>Yes — paste a FEN and go.</dd>
      </dl>

      <p className="seo-long__cta">
        Open <a href="/play/local-bot">play vs bot</a> and start.
      </p>
    </section>
  );
}
