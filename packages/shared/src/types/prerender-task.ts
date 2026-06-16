/**
 * KS-4194 / ADR-128 §7.3 + §10 KS-9. Контракт задачи для воркера
 * prerender (`apps/prerender-service`). Воркер вычитывает сообщения
 * SQS, мапит каждый `PrerenderTask` на URL фронта `kingside.site/...`
 * и ключ S3 `<entity>/<id>.html`, рендерит страницу через headless
 * Chromium и кладёт HTML в `kingside-prerender-store`.
 *
 * Этот файл — единственный источник истины формата сообщения. KS-10
 * добавит публичный enqueue-клиент в shared и переиспользует тип.
 *
 * Сериализация: тело сообщения SQS — `JSON.stringify(task)`. Поле
 * `kind` — дискриминант. Любое поле, не входящее в дискриминируемое
 * объединение ниже, на воркере игнорируется (forward-compat).
 */

/** Узнаваемое имя списка-страницы, на которой нет конкретного id. */
export type PrerenderListRoute =
  | '/broadcasts'
  | '/tournaments'
  | '/lectures'
  | '/players'
  | '/archive';

export type PrerenderTask =
  | { kind: 'broadcast'; tid: string; rid?: string; gid?: string }
  | { kind: 'tournament'; id: string }
  | { kind: 'coach'; username: string }
  | { kind: 'lecture'; id: string }
  | { kind: 'player'; username: string }
  | { kind: 'archive-game'; id: string }
  | { kind: 'archive-player'; slug: string }
  | { kind: 'list'; route: PrerenderListRoute };

export type PrerenderTaskKind = PrerenderTask['kind'];

/**
 * Соответствие `PrerenderTask → { url, s3Key }`. Чистая функция,
 * используется воркером и (после KS-10) клиентом-постановщиком —
 * чтобы оба знали где будет лежать готовый HTML и какую страницу
 * рендерить. `baseUrl` без trailing-slash.
 */
export interface PrerenderRouteInfo {
  /** Полный URL для Playwright.page.goto(). */
  url: string;
  /** Ключ в `kingside-prerender-store`. Без leading-slash. */
  s3Key: string;
}

export function resolvePrerenderRoute(
  task: PrerenderTask,
  baseUrl: string,
): PrerenderRouteInfo {
  const base = baseUrl.replace(/\/+$/, '');
  switch (task.kind) {
    case 'broadcast': {
      // /broadcasts/:tid[/:rid[/:gid]] — S3 ключ детализируется по
      // самому глубокому уровню, чтобы один tid с разными rid/gid не
      // перезаписывал друг друга.
      const path = ['/broadcasts', task.tid, task.rid, task.gid]
        .filter((p): p is string => Boolean(p))
        .join('/');
      const keyParts = [task.tid, task.rid, task.gid].filter(
        (p): p is string => Boolean(p),
      );
      return {
        url: `${base}${path}`,
        s3Key: `broadcasts/${keyParts.join('/')}.html`,
      };
    }
    case 'tournament':
      return {
        url: `${base}/tournaments/${task.id}`,
        s3Key: `tournaments/${task.id}.html`,
      };
    case 'coach':
      // KS-4232. Frontend canonical (`CoachProfilePage`, KS-4231)
      // использует единственное число `/coach/:username`; CloudFront
      // behavior настроен на `/coach/*` → S3-ключ `coach/<u>.html`.
      // До фикса resolver писал URL `/coaches/...` (множественное),
      // воркер рендерил несуществующий роут фронта и клал в S3 пустой
      // SPA-shell.
      return {
        url: `${base}/coach/${task.username}`,
        s3Key: `coach/${task.username}.html`,
      };
    case 'lecture':
      return {
        url: `${base}/lectures/${task.id}`,
        s3Key: `lectures/${task.id}.html`,
      };
    case 'player':
      // KS-4232. Frontend canonical (`PlayerProfilePage`) использует
      // единственное число `/player/:username`; CloudFront behavior
      // настроен на `/player/*` → S3-ключ `player/<u>.html` (KS-4225).
      // До фикса resolver писал в `players/` (множественное), и CDN
      // не находил файл — отдавался SPA-fallback.
      return {
        url: `${base}/player/${task.username}`,
        s3Key: `player/${task.username}.html`,
      };
    case 'archive-game':
      return {
        url: `${base}/archive/games/${task.id}`,
        s3Key: `archive/games/${task.id}.html`,
      };
    case 'archive-player':
      return {
        url: `${base}/archive/players/${task.slug}`,
        s3Key: `archive/players/${task.slug}.html`,
      };
    case 'list': {
      // /broadcasts → list/broadcasts.html и т.п. — в одном
      // namespace (`list/*`), чтобы не пересекаться с entity-страницами.
      const slug = task.route.replace(/^\//, '');
      return { url: `${base}${task.route}`, s3Key: `list/${slug}.html` };
    }
    default: {
      const exhaustive: never = task;
      throw new Error(
        `Unknown PrerenderTask: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Type-guard: пришедший из SQS JSON — действительно `PrerenderTask`.
 * Не валидирует значения по строгим правилам (id могут быть любыми
 * непустыми строками), но отсекает явный мусор и неподдерживаемые
 * `kind`. Используется воркером перед `resolvePrerenderRoute`.
 */
export function isPrerenderTask(value: unknown): value is PrerenderTask {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const isStr = (x: unknown): x is string =>
    typeof x === 'string' && x.length > 0;
  switch (v.kind) {
    case 'broadcast':
      return (
        isStr(v.tid) &&
        (v.rid === undefined || isStr(v.rid)) &&
        (v.gid === undefined || isStr(v.gid))
      );
    case 'tournament':
    case 'lecture':
    case 'archive-game':
      return isStr(v.id);
    case 'coach':
    case 'player':
      return isStr(v.username);
    case 'archive-player':
      return isStr(v.slug);
    case 'list':
      return (
        v.route === '/broadcasts' ||
        v.route === '/tournaments' ||
        v.route === '/lectures' ||
        v.route === '/players' ||
        v.route === '/archive'
      );
    default:
      return false;
  }
}
