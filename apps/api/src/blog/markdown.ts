/**
 * KS-4409 / KS-4410 / ADR-137 rev2. Преобразование Markdown в HTML
 * + sanitize. Вызывается из админ-CRUD на каждый save поста —
 * результат кэшируется в `blog_posts.body_html`. На публичных
 * эндпоинтах рендер не делается, отдаётся готовый HTML из БД.
 *
 * Стек:
 *   unified → remark-parse → remark-rehype → rehype-sanitize →
 *   rehype-stringify.
 *
 * rehype-sanitize по умолчанию (`defaultSchema`) разрешает только
 * безопасные теги/атрибуты по схеме GitHub HTML — это закрывает
 * `<script>`, inline event-handlers, `javascript:` URL, `<iframe>`
 * и прочие XSS-векторы. Расширение списка тегов (если потребуется
 * embedding YouTube / chess-доски) — отдельной задачей, через
 * передачу `merge(defaultSchema, {...})` в плагин.
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

async function getProcessor(): Promise<UnifiedProcessor> {
  if (processorPromise) return processorPromise;
  processorPromise = (async () => {
    const [
      { unified },
      { default: remarkParse },
      { default: remarkRehype },
      { default: rehypeSanitize },
      { default: rehypeStringify },
    ] = await Promise.all([
      import('unified'),
      import('remark-parse'),
      import('remark-rehype'),
      import('rehype-sanitize'),
      import('rehype-stringify'),
    ]);
    return unified()
      .use(remarkParse)
      .use(remarkRehype, { allowDangerousHtml: false })
      .use(rehypeSanitize)
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
