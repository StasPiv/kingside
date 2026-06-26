/**
 * KS-4409 / KS-4410 / KS-4637 / ADR-137 rev2. Преобразование Markdown
 * в HTML + sanitize. Вызывается из админ-CRUD на каждый save поста —
 * результат кэшируется в `blog_posts.body_html`. На публичных
 * эндпоинтах рендер не делается, отдаётся готовый HTML из БД.
 *
 * Стек:
 *   unified → remark-parse → remark-rehype → rehypeYoutubeEmbed →
 *   rehype-sanitize → rehype-stringify.
 *
 * `rehype-sanitize` использует `defaultSchema` (схема GitHub HTML),
 * расширенную whitelist'ом для одного безопасного варианта iframe —
 * только YouTube-embed (KS-4637). Все прочие XSS-векторы (`<script>`,
 * inline event-handlers, `javascript:` URL, произвольные iframe'ы) —
 * по-прежнему режутся.
 *
 * ─── KS-4637: YouTube-embed ───
 *
 * Marketing просил встраивать YouTube-видео в блог-пост. Riski raw-iframe
 * (можно подставить `<iframe src="evil.com">`) обходим **двумя слоями**:
 *
 *   1. `remark-rehype` оставлен с `allowDangerousHtml: false` — Markdown
 *      raw HTML не парсится в дерево, его невозможно протолкнуть.
 *   2. Единственный путь iframe в HTML — наш `rehypeYoutubeEmbed`
 *      плагин: он ищет абзацы, состоящие из одной YouTube-ссылки на
 *      собственной строке, парсит `videoId` строгим whitelist'ом и
 *      генерирует фиксированный `<iframe src="https://www.youtube-
 *      nocookie.com/embed/<id>">` с заранее заданным набором атрибутов.
 *   3. sanitize-схема пропускает iframe только если у него
 *      `src` начинается с `https://www.youtube-nocookie.com/embed/` —
 *      двойной контроль (plugin генерирует, sanitize верифицирует).
 *
 * Поддерживаемые форматы ссылок:
 *   - `https://www.youtube.com/watch?v=<id>` (и любые `m.youtube.com`)
 *   - `https://youtu.be/<id>`
 *   - `https://www.youtube.com/embed/<id>`
 *   - `https://www.youtube.com/shorts/<id>`
 *
 * Используется `youtube-nocookie.com` вместо `youtube.com` — рекомендация
 * Google для встроек, не ставит трекинг-cookie до клика по play. Минимум
 * атрибутов: `src`, `title`, `loading="lazy"`, `frameBorder="0"`,
 * `allow` (нужно для fullscreen + автоплея при пользовательском клике),
 * `allowFullScreen`. Узкий white-list — меньше поверхности атак.
 *
 * Также вычисляется `readingTimeMin` — целое число минут чтения
 * (250 слов в минуту, минимум 1). Используется в карточках списка.
 */
// unified / remark / rehype-sanitize — ESM-only пакеты. CommonJS-сборка
// api (NestJS-cli) не может использовать статический `import` — TS
// перепишет их в `require()`, который выбросит ERR_REQUIRE_ESM. Поэтому
// держим dynamic `import()` через ленивый singleton: первый вызов
// `renderMarkdownToHtml` собирает процессор, дальше он переиспользуется.
type UnifiedProcessor = { process(md: string): Promise<{ toString(): string }> };
let processorPromise: Promise<UnifiedProcessor> | null = null;

/**
 * KS-4637. URL-префикс, который генерирует наш rehype-плагин и
 * единственный, который пропускает sanitize-схема для iframe.src.
 * Зашит как константа, чтобы plugin и sanitize видели одну строку
 * — расхождение моментально вылезет в `rehypeYoutubeEmbed` тестах.
 */
const YOUTUBE_EMBED_PREFIX = 'https://www.youtube-nocookie.com/embed/';

/** KS-4637. Класс на обёртке `<div>` — крючок для CSS (responsive 16:9). */
const YOUTUBE_WRAPPER_CLASS = 'kingside-blog-youtube';

/**
 * KS-4637. Whitelist хостов YouTube. `youtube-nocookie.com` оставляем
 * — если пользователь сам вставит embed-ссылку с nocookie-домена,
 * парсер тоже её примет и преобразует в наш канонический iframe.
 */
const YOUTUBE_HOSTS = new Set([
  'www.youtube.com',
  'youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
  'youtube-nocookie.com',
]);

/**
 * KS-4637. Канонический формат `videoId`: 11 ASCII символов
 * `[A-Za-z0-9_-]`. Используем строгий regex и в URL-разборе, и в
 * проверке — чтобы id вида `../../../etc/passwd` не прошёл.
 */
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * KS-4637. Распарсить URL и вернуть `videoId`, если это валидная
 * YouTube-ссылка одного из поддержанных форматов; иначе `null`.
 *
 * Экспортируется отдельно для unit-тестов — это чистая функция без
 * ESM-зависимостей, в отличие от `renderMarkdownToHtml` (см.
 * markdown.spec.ts: jest не грузит unified/remark/rehype, ESM-only).
 */
export function extractYoutubeVideoId(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  // http:// / data:/// и пр. — отрезаем; nocookie/youtube тоже только https.
  if (url.protocol !== 'https:') return null;
  if (!YOUTUBE_HOSTS.has(url.hostname)) return null;
  // youtu.be/<id> — короткая форма.
  if (url.hostname === 'youtu.be') {
    const id = url.pathname.replace(/^\//, '');
    return YOUTUBE_VIDEO_ID_RE.test(id) ? id : null;
  }
  // /watch?v=<id>
  if (url.pathname === '/watch') {
    const id = url.searchParams.get('v') ?? '';
    return YOUTUBE_VIDEO_ID_RE.test(id) ? id : null;
  }
  // /embed/<id>, /shorts/<id>, /v/<id> — формы embed.
  const embedMatch = url.pathname.match(
    /^\/(embed|shorts|v)\/([^/?#]+)\/?$/,
  );
  if (embedMatch && YOUTUBE_VIDEO_ID_RE.test(embedMatch[2])) {
    return embedMatch[2];
  }
  return null;
}

/**
 * KS-4637. HAST-properties фиксированного безопасного `<iframe>` для
 * данного `videoId`. Чистая функция, тестируется отдельно от
 * pipeline. Поля совпадают с тем, что Google рекомендует для встроек.
 */
export function buildYoutubeIframeProperties(videoId: string): Record<string, unknown> {
  if (!YOUTUBE_VIDEO_ID_RE.test(videoId)) {
    throw new Error(`buildYoutubeIframeProperties: invalid videoId "${videoId}"`);
  }
  return {
    src: `${YOUTUBE_EMBED_PREFIX}${videoId}`,
    title: 'YouTube video player',
    frameBorder: '0',
    allow:
      'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
    allowFullScreen: true,
    loading: 'lazy',
    referrerPolicy: 'strict-origin-when-cross-origin',
    // KS-4672. Атрибут `credentialless` нужен для встроек на страницах
    // с COEP=credentialless (после KS-4671 главная отдаёт его, и
    // SPA-навигация в блог наследует заголовок). Без атрибута Chrome
    // 110+ отказывается грузить ресурс из cross-origin без CORP=cross-
    // origin (которого YouTube не отдаёт). HAST: boolean=true → пустой
    // HTML5 boolean-атрибут `credentialless` в выходе rehype-stringify.
    credentialless: true,
  };
}

/**
 * KS-4637. Из текстового узла HAST извлечь YouTube-URL, если узел
 * содержит ОДНУ ссылку и больше ничего (после trim'а). Используется
 * `rehypeYoutubeEmbed` для распознавания «голой» ссылки на отдельной
 * строке — типичный markdown-вариант auto-embed'а (как у GitHub Issues,
 * Discord, Slack).
 */
function extractSoleUrl(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (/\s/.test(trimmed)) return null;
  return trimmed;
}

// HAST-узлы используем как «непрозрачный» тип — без unist-util-visit
// (он не в зависимостях), просто рекурсивный обход с минимальной
// типизацией. Поведение покрыто тестами через extractYoutubeVideoId.
type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/**
 * KS-4637. rehype-плагин: paragraph (`<p>`) с единственным потомком —
 * Markdown-ссылкой/auto-link'ом/текстовым узлом-URL'ом, парсящимся как
 * YouTube — заменяется на безопасный `<iframe>` в обёртке `<div>`.
 *
 * Не-paragraph'ы и paragraph'ы со сторонним содержимым (текст до/после
 * ссылки, несколько ссылок, форматирование) — НЕ трогаются: ссылка
 * остаётся обычным `<a href="https://youtube.com/...">`, как и раньше.
 */
function rehypeYoutubeEmbed() {
  return function transformer(tree: HastNode): void {
    function walk(node: HastNode): void {
      if (node.children && node.children.length > 0) {
        for (let i = 0; i < node.children.length; i++) {
          const child = node.children[i];
          // Если paragraph — попробовать заменить.
          if (child.type === 'element' && child.tagName === 'p') {
            const replaced = tryEmbedYoutubeParagraph(child);
            if (replaced) {
              node.children[i] = replaced;
              continue;
            }
          }
          walk(child);
        }
      }
    }
    walk(tree);
  };
}

/**
 * KS-4637. Попытаться превратить `<p>` в YouTube-embed. Возвращает
 * заменяющий HAST-узел (`<div class="kingside-blog-youtube"><iframe …/></div>`),
 * либо `null` — тогда вызывающий обходит paragraph как обычно.
 */
function tryEmbedYoutubeParagraph(paragraph: HastNode): HastNode | null {
  const children = paragraph.children ?? [];
  // Игнорируем пустые text-узлы (whitespace между блоками).
  const significant = children.filter((c) => {
    if (c.type === 'text') return (c.value ?? '').trim().length > 0;
    return true;
  });
  if (significant.length !== 1) return null;
  const only = significant[0];

  let videoId: string | null = null;
  if (only.type === 'text' && typeof only.value === 'string') {
    const url = extractSoleUrl(only.value);
    if (url) videoId = extractYoutubeVideoId(url);
  } else if (
    only.type === 'element' &&
    only.tagName === 'a' &&
    typeof only.properties?.href === 'string'
  ) {
    videoId = extractYoutubeVideoId(only.properties.href as string);
  }
  if (!videoId) return null;

  return {
    type: 'element',
    tagName: 'div',
    properties: { className: [YOUTUBE_WRAPPER_CLASS] },
    children: [
      {
        type: 'element',
        tagName: 'iframe',
        properties: buildYoutubeIframeProperties(videoId),
        children: [],
      },
    ],
  };
}

async function getProcessor(): Promise<UnifiedProcessor> {
  if (processorPromise) return processorPromise;
  processorPromise = (async () => {
    const [
      { unified },
      { default: remarkParse },
      { default: remarkRehype },
      { default: rehypeSanitize, defaultSchema },
      { default: rehypeStringify },
    ] = await Promise.all([
      import('unified'),
      import('remark-parse'),
      import('remark-rehype'),
      import('rehype-sanitize'),
      import('rehype-stringify'),
    ]);
    // KS-4637. Расширяем defaultSchema: разрешаем iframe ТОЛЬКО с
    // src, начинающимся на `YOUTUBE_EMBED_PREFIX`, и div с нашим
    // wrapper-классом. Все остальные iframe'ы по-прежнему режутся.
    // `rehype-sanitize` принимает атрибут в форме
    // `[name, ...allowedValues]`, где `allowedValues` могут быть
    // строкой (точное равенство) или регуляркой; `[name, /regex/]`.
    // Мы используем regex для src — закрепляем хост и embed-путь.
    const youtubeSrcMatcher = new RegExp(
      `^https://www\\.youtube-nocookie\\.com/embed/[A-Za-z0-9_-]{11}$`,
    );
    const schema = {
      ...defaultSchema,
      tagNames: [...(defaultSchema.tagNames ?? []), 'iframe'],
      attributes: {
        ...(defaultSchema.attributes ?? {}),
        iframe: [
          ['src', youtubeSrcMatcher],
          'title',
          ['frameBorder', '0'],
          ['allow',
            // Точная фраза, которую генерирует buildYoutubeIframeProperties.
            // Любое отклонение → атрибут вырежется sanitize'ом.
            'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
          ],
          ['allowFullScreen', true],
          ['loading', 'lazy'],
          ['referrerPolicy', 'strict-origin-when-cross-origin'],
          // KS-4672. Допускаем boolean=true (HTML5 boolean-атрибут).
          // Любая строка/false вырежется — это исключает попытки
          // протолкнуть `credentialless="evil"` или другое.
          ['credentialless', true],
        ],
        div: [
          ...((defaultSchema.attributes?.div as unknown[]) ?? []),
          ['className', YOUTUBE_WRAPPER_CLASS],
        ],
      },
      // protocols: defaultSchema уже whitelist'ит http/https/mailto и
      // т.п., нам не нужно расширять — src iframe проверяется явным
      // regex выше, протоколы для остальных тегов не трогаем.
    };
    return unified()
      .use(remarkParse)
      .use(remarkRehype, { allowDangerousHtml: false })
      .use(rehypeYoutubeEmbed)
      // `schema` собран из defaultSchema + наших расширений, точное
      // соответствие узкому Schema-типу избыточно (вложенные attribute-
      // declarations поддерживают `(string | RegExp | boolean)[]`, но
      // тип в rehype-sanitize задаёт более строгий tuple). Каст —
      // потому что плагин получает Schema через дефолтный экспорт.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .use(rehypeSanitize, schema as any)
      .use(rehypeStringify) as unknown as UnifiedProcessor;
  })();
  return processorPromise;
}

const READING_WORDS_PER_MINUTE = 250;

/**
 * Преобразовать Markdown в безопасный HTML. Промис возвращает
 * строку, готовую к записи в `blog_posts.body_html` и отдаче через
 * `dangerouslySetInnerHTML` на фронте.
 */
export async function renderMarkdownToHtml(md: string): Promise<string> {
  const processor = await getProcessor();
  const file = await processor.process(md);
  return String(file);
}

/**
 * Грубая оценка времени чтения по числу слов. 250 слов в минуту —
 * стандарт для англоязычной статьи, для русской чуть меньше, но
 * для UI-карточки округление в большую сторону приемлемо.
 *
 * Минимум 1 (даже для пустой статьи / черновика — UI всегда
 * показывает «1 мин»).
 */
export function estimateReadingTimeMin(md: string): number {
  const words = md
    .replace(/[#*_`>[\]()!-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  if (words === 0) return 1;
  return Math.max(1, Math.ceil(words / READING_WORDS_PER_MINUTE));
}
