# ADR-140: Блог Kingside — просмотры, лайки, комментарии

Связанные тикеты: KS-4466 (этот ADR).
Связанные ADR: 137 (концепт блога, БД-хранилище), 138 (медиа S3).
Источник запроса: Telegram @StasPiv, 2026-06-20.

## 1. Контекст

ADR-137 (rev2) ввёл блог в БД с таблицами `blog_authors`, `blog_posts` и
публичными маршрутами `GET /blog/posts`, `GET /blog/posts/:slug`,
`GET /blog/authors/:handle`. Прямо в §6 «Открытые вопросы» оставлены
пункты 4 (аналитика просмотров) и 5 (комментарии) — здесь они
закрываются.

Что нужно добавить под публикациями:

1. **Счётчик просмотров** — видимый числовой показатель.
2. **Лайки** — счётчик + действие «поставить/снять».
3. **Комментарии** — список + действие «добавить/изменить/удалить» + счётчик.

Уже работает и пригодится:

* `OptionalJwtGuard` (`apps/api/src/auth/optional-jwt.guard.ts`) — даёт
  `req.user` если есть валидный JWT, иначе пропускает запрос анонимно.
  Используется в `puzzle.controller.ts`, `lectures-public.controller.spec.ts`.
* `JwtAuthGuard` — обязательная авторизация (для действий, не для чтения).
* `RedisRateLimitGuard` + декоратор `@RateLimit(max, windowSec)`
  (`apps/api/src/common/redis-rate-limit.guard.ts`) — ключ строится
  по `IP + method:route`, счётчик в Redis с TTL. Используется в
  `lectures-public`, `screenshot-token`. Подходит для гостевых
  эндпоинтов; для авторизованных лучше комбинировать с per-user
  лимитом (`checkRateLimit/incrementRateLimit` поверх `RedisService`,
  как в `review-comment.service.ts`).
* CloudFront отдаёт prerender-снапшоты публичных страниц блога —
  GET `/blog/<slug>` *не доходит до бэка* при попадании в кэш. Это
  значит: считать просмотры на бэке через GET статьи **нельзя**, нужен
  отдельный POST с фронта.
* CSR-страница `BlogPostPage` уже стянет полный `BlogPostDetail` через
  `GET /blog/posts/:slug` (выдача API минует CloudFront в этом
  случае — это API-домен, у него своя политика). Просмотры
  инкрементируются отдельным запросом, чтобы не плодить мутацию
  внутри GET и не путать кэш.

## 2. Решение

### 2.1. Модель данных

Изменения в `packages/db/prisma/schema.prisma`.

**Денормализованные счётчики в `BlogPost`** (быстрая отдача без JOIN
при листинге и чтении):

```prisma
model BlogPost {
  // ... существующие поля
  viewsCount    Int  @default(0) @map("views_count")
  likesCount    Int  @default(0) @map("likes_count")
  commentsCount Int  @default(0) @map("comments_count")
  // ...
}
```

Денормализация обоснована: лента и страница статьи показывают
числа постоянно, без агрегатов это два дополнительных запроса с
GROUP BY на каждое чтение. Источник правды — детальные таблицы
(см. ниже), счётчики синхронизируются в той же транзакции что и
запись детали (для лайков и комментариев) либо инкрементом `UPDATE
... SET views_count = views_count + 1` (для просмотров).

**Лайки** — отдельная таблица:

```prisma
/// KS-446x / ADR-140. Лайк статьи блога. Один пользователь — один
/// лайк на одну статью (по post_id). Лайки независимы между
/// локалями: post_id указывает на конкретную BlogPost-запись (RU
/// или EN). Это сохраняет симметрию со счётчиками просмотров и
/// комментариев — все три привязаны к (slug, locale).
model BlogPostLike {
  postId    String   @map("post_id") @db.Uuid
  userId    String   @map("user_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  post BlogPost @relation(fields: [postId], references: [id], onDelete: Cascade)
  user User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([postId, userId])
  @@index([userId])
  @@map("blog_post_likes")
}
```

Решение «лайки на конкретный (slug, locale)»: если читатель прочитал
RU-статью и лайкнул — это лайк именно RU. Если перейдёт на EN —
увидит её без своего лайка. Альтернатива «лайк на slug» лишена
смысла (пользователь читает локаль, не пару), потребует отдельной
схемы и сложнее запрашивается. Минус — у RU и EN могут быть разные
числа лайков; но и контент у них формально разный (перевод — не
оригинал), это допустимо.

**Комментарии** — отдельная таблица, плоский список:

```prisma
/// KS-446x / ADR-140. Комментарий к статье блога. MVP — плоская
/// лента (без вложенных ответов). Привязка к конкретной (slug,
/// locale) — комментаторы пишут в той локали, которую читают.
/// Soft-delete: deleted_at NOT NULL → текст скрыт, запись остаётся
/// (сохраняем порядок, не сбиваем пагинацию).
model BlogPostComment {
  id        String    @id @default(uuid()) @db.Uuid
  postId    String    @map("post_id") @db.Uuid
  userId    String    @map("user_id") @db.Uuid
  body      String    @db.Text
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt DateTime  @updatedAt        @map("updated_at") @db.Timestamptz(3)
  deletedAt DateTime? @map("deleted_at") @db.Timestamptz(3)

  post BlogPost @relation(fields: [postId], references: [id], onDelete: Cascade)
  user User     @relation(fields: [userId], references: [id], onDelete: Restrict)

  @@index([postId, createdAt(sort: Desc)])
  @@index([userId])
  @@map("blog_post_comments")
}
```

`onDelete` для `user` — `Restrict` (нельзя удалить пользователя с
комментариями без явной обработки), для `post` — `Cascade` (если
статью удаляют, комментарии теряют смысл; на момент MVP `BlogPost`
удаляется только через админ-UI с подтверждением).

**Просмотры — без отдельной таблицы.** В MVP не строим логи по
каждому просмотру:

* агрегат уже хранится в `BlogPost.viewsCount`;
* дедупликация (один просмотр на сессию/IP в сутки) делается через
  Redis SET с TTL 24 ч (см. §2.2);
* запрос «топ статей за неделю» можно собрать снэпшотом
  `viewsCount` раз в сутки в отдельную таблицу `BlogPostViewSnapshot`
  *если* появится требование. Пока такого требования нет.

Если позже понадобится временной ряд (динамика, графики) — добавим
таблицу `BlogPostView(postId, viewedAt, bucketKey)` отдельной задачей,
без рефакторинга текущей схемы.

### 2.2. Просмотры — что считаем и как

**Что такое «просмотр»**: один уникальный пользователь / гость на
одну статью за окно 24 часа.

* Авторизованный — ключ дедупа `blog:view:<postId>:u:<userId>`.
* Гость — ключ дедупа `blog:view:<postId>:ip:<sha1(ip+ua)>` (IP без UA
  даёт ложные склейки за NAT; UA без IP — даёт ложные расщепления при
  смене страницы; пара — компромисс).

**Как инкрементим**:

* Отдельный эндпоинт `POST /blog/posts/:id/view` (без тела). Маршрут
  идёт мимо CloudFront (API-домен), поэтому считаем каждый реальный
  запрос фронта. Внутри:
  1. Проверка rate-limit по IP (`RedisRateLimitGuard`, `@RateLimit(30, 60)`).
  2. Формирование ключа дедупа.
  3. `SET key 1 NX EX 86400` — если ключ был → 200 OK без инкремента;
     если новый → атомарный `UPDATE blog_posts SET views_count = views_count + 1`.
  4. Ответ `{viewsCount: number}` — фронт обновляет UI без повторного GET.

* Маршрут под `OptionalJwtGuard` — авторизация нужна только для
  выбора правильного ключа дедупа; гости считаются тоже.

**Антибот и защита от накрутки**:

* `RedisRateLimitGuard` per-IP (30/мин на маршрут) — отсекает прямой
  цикл из шелла.
* Отсев заведомых ботов по `User-Agent` (Googlebot/Bingbot/curl/wget/python-requests/
  семейство headless без явного origin) — список в конфиге сервиса.
  Боты получают 200 OK без инкремента (не палим логику отказом —
  это лишь снижает шум, не безопасность).
* Проверка `Origin`/`Referer`: должен совпадать с `kingside.site`,
  `*.kingside.site` или `localhost` (dev). Иначе 400. Это блокирует
  курильщиков из консоли стороннего сайта.

* Прерванный запрос фронта (пользователь закрыл вкладку) ничего не
  ломает: либо успели вызвать и Redis-SET выставил ключ, либо нет —
  следующее открытие просто посчитается.

**Когда вызывать с фронта**: `BlogPostPage`, после успешной
загрузки `BlogPostDetail`, с задержкой 5 сек (требование «реально
прочитал, а не пролистал»). Дополнительная защита от двойного
запроса в одной вкладке — `sessionStorage` ключ `blog-viewed:<slug>:<locale>`
на сутки.

**Prerender и CloudFront**: первый показ статьи может прийти со
снапшота — это нормально, `POST /view` всё равно полетит из
загруженного JS-бандла. Если CloudFront когда-нибудь начнёт раздавать
свежесгенерированный HTML без JS (что не наш случай), счёт прекратится;
но это и хорошо — мы считаем реальное взаимодействие, а не машинный
обход CDN.

### 2.3. Лайки

**Кто может лайкать**: только авторизованные. Аргумент: для гостей
пришлось бы вводить fingerprint (отпечаток браузера) с известными
False-Positive в один контейнер у NAT-пользователей и False-Negative
у читателей с приватным режимом. Стоимость поддержки выше пользы;
лайки — не критичный механизм охвата, на них завязан только
вторичный сигнал.

**API**:

```
POST   /blog/posts/:id/like      → 201 { likesCount, likedByMe: true }
DELETE /blog/posts/:id/like      → 200 { likesCount, likedByMe: false }
```

Обе операции идемпотентны:

* `POST` при существующем лайке — 200 без инкремента (`INSERT ... ON
  CONFLICT (post_id, user_id) DO NOTHING`).
* `DELETE` при отсутствии лайка — 200 без декремента.

Счётчик `likesCount` поддерживается в одной транзакции с записью в
`blog_post_likes`. Альтернатива (триггер БД) не используется —
сервис уже владеет всеми изменениями, триггер только усложнит
отладку.

**В выдаче API**: каждая запись `BlogPostListItem` и
`BlogPostDetail` отдаёт:

```ts
likesCount: number;       // total
likedByMe: boolean;       // true если req.user поставил лайк
```

`likedByMe` для гостей всегда `false`. На листинге считается одним
`leftJoin` с `blog_post_likes WHERE user_id = $req.user.id`.

**Rate-limit лайка**: per-user `checkRateLimit('blog:like', userId, 30/min)`.
Чрезмерные дёргания (накрутка через свой аккаунт) бессмысленны
(один лайк = одна запись), но защита от циклов «лайк-анлайк» нужна.

### 2.4. Комментарии

**Кто может комментировать**: только авторизованные.

**Структура — плоский список** (без `parent_id` и веток). Аргумент:

* Блог Kingside — длинноформатный контент, поток комментариев
  низкий, не Reddit. Ветки увеличивают сложность пагинации (надо
  отдавать дерево, не страницу) и UI (отступы, свернуть/развернуть)
  непропорционально пользе.
* Эту опцию проще ввести позже добавлением `parent_id String?` и
  отдельного эндпоинта, чем отрезать.

**Модерация**: на старте — только автор и админ могут удалять,
автор может редактировать свой комментарий **не позднее 15 минут с
момента создания** (после — только soft-delete). Жалоб, банов, очереди
модерации в MVP нет. Если появится — отдельный ADR.

**Защита от спама**:

* `body.length` в `[2, 2000]` символов.
* Plain-text. HTML вырезается на бэке (никакого `dangerouslySetInnerHTML`),
  на фронте `\n` → `<br/>`, ссылки автолинкуются на фронте отдельной
  утилитой (с rel="noopener nofollow" target=_blank).
* Не более 2 URL в теле (regex-счёт). 3+ → 400.
* Per-user rate-limit: `checkRateLimit('blog:comment', userId, 1/30sec)` и
  `30/час`.

**API**:

```
GET    /blog/posts/:id/comments?cursor=<base64>&limit=20
         → 200 { items: BlogComment[], nextCursor: string | null }
         — публичный, OptionalJwtGuard (нужен для проставления
           canEdit/canDelete на собственные комментарии).
         — cursor-based пагинация по (createdAt DESC, id DESC).
           Соответствует индексу @@index([postId, createdAt(Desc)]).
         — deletedAt != null комментарии возвращаются с body=null
           и флагом deleted: true, чтобы UI показал плашку
           «комментарий удалён» и не сбивалась нумерация.

POST   /blog/posts/:id/comments      → 201 BlogComment
         body: { body: string }
         JwtAuthGuard + per-user rate-limit.
         В транзакции: INSERT в blog_post_comments, UPDATE
         blog_posts.comments_count = comments_count + 1.

PATCH  /blog/comments/:id            → 200 BlogComment
         body: { body: string }
         JwtAuthGuard. Только автор. 403 если
         comment.userId !== req.user.id или Date.now() - createdAt
         > 15 минут.

DELETE /blog/comments/:id            → 204
         JwtAuthGuard. Автор или админ (`KS_ADMIN_USERS`-whitelist
         как в blog-admin.controller.ts). Soft-delete: SET
         deleted_at=NOW(), сохраняем body для возможного
         восстановления админом. Декремент
         blog_posts.comments_count.
```

**Денормализация `commentsCount`**: считает только активные (`deleted_at IS NULL`)
комментарии. При soft-delete декрементируется. При hard-delete
автора-пользователя (а это `Restrict`-связь, в MVP запрещено) — не
вопрос текущего скоупа.

**Что не входит в MVP**: лайки на комментарии, упоминания
`@username`, аватары непрочитанных, e-mail уведомления автору статьи,
сортировка «по популярности», поиск по комментариям. Это отдельные
этапы.

### 2.5. Контракты типов

Файл `packages/shared/src/types/blog.ts` (создан в ADR-137 rev2)
дополняется:

```ts
export interface BlogPostListItem {
  // ... существующие поля
  viewsCount: number;
  likesCount: number;
  commentsCount: number;
  /** true если в запросе был валидный JWT и пользователь
   *  поставил лайк этой статье. Для гостей и для статьи без
   *  своего лайка — false. */
  likedByMe: boolean;
}

export interface BlogPostDetail extends BlogPostListItem {
  // ... существующие поля
}

export interface BlogComment {
  id: string;
  postId: string;
  author: {
    id: string;
    username: string;
    avatarUrl: string | null;
  };
  /** null если комментарий удалён (soft). */
  body: string | null;
  createdAt: string;   // ISO
  updatedAt: string;   // ISO
  deleted: boolean;
  /** true если req.user — автор и ещё в окне 15 минут с createdAt. */
  canEdit: boolean;
  /** true если req.user — автор или админ. */
  canDelete: boolean;
}

export interface BlogCommentsPage {
  items: BlogComment[];
  /** base64(JSON.stringify({createdAt, id})) — передаётся в
   *  следующий запрос через ?cursor=. null когда дошли до конца. */
  nextCursor: string | null;
}

export interface BlogViewResponse {
  viewsCount: number;
}

export interface BlogLikeResponse {
  likesCount: number;
  likedByMe: boolean;
}
```

Эти типы импортируются в backend (DTO/маппер) и frontend (хуки,
компоненты) — единый источник правды.

### 2.6. Влияние на существующие маршруты

* `GET /blog/posts` и `GET /blog/posts/:slug` — подключают
  `OptionalJwtGuard`, чтобы из ответа было видно `likedByMe`. Без
  токена → `false` без обращения к `blog_post_likes`.
* `blog.service.ts` — расширить методы `listPosts` и `getPost`:
  селект включает три счётчика, плюс per-request join с лайками
  если `req.user`. Сейчас в выдаче этих полей нет — это
  ломающее изменение контракта, но и фронт переключается одной
  задачей (см. T8).

### 2.7. Frontend (только маршруты и места правок)

Без кода — детали реализации остаются исполнителю. Чтобы тикеты
получились ровными:

* `BlogPostPage.tsx` — в `useEffect` после успешной загрузки
  деталки и таймаута 5 сек — `POST /blog/posts/:id/view`.
  Идемпотентность на фронте через `sessionStorage.getItem('blog-viewed:<slug>:<locale>')`.
* `BlogPostPage.tsx` — кнопка лайка (`LikeButton`) + счётчик; для
  гостя — открыть модалку логина при клике (паттерн уже есть на
  странице puzzle).
* `BlogPostPage.tsx` + новый компонент `BlogCommentsSection` —
  лента + форма + edit/delete. Реализуется поверх
  `react-query` с курсорной пагинацией и оптимистичным
  обновлением `commentsCount` в кеше деталки.
* `BlogFeedPage.tsx` — карточка показывает три числа
  (views/likes/comments) иконками. Чисто визуально.

### 2.8. Влияние на CloudFront и prerender

* `POST /blog/posts/:id/view`, `POST /blog/posts/:id/like` и т.д. —
  не кешируются (явная политика `Cache-Control: no-store` в ответе
  достаточна).
* Prerender-снапшот `blog/<slug>` — продолжает рисовать статичные
  значения счётчиков, какие были на момент сборки. Это допустимо:
  после гидрации фронт сделает повторный `GET /blog/posts/:slug`
  и заменит числа на актуальные (react-query). Если расхождение
  визуально заметно — внести инвалидацию prerender-кеша при росте
  `viewsCount` нельзя (это ddos самих себя). Допустимо.

## 3. Что НЕ делаем

* Лайки от гостей с fingerprint — отказались (см. §2.3).
* Вложенные комментарии (ветки) — не в MVP (см. §2.4).
* Лайки комментариев, реакции, эмодзи — не в MVP.
* Аналитика просмотров с временным рядом (графики, «за неделю») —
  не в MVP. Только агрегатный счётчик.
* Уведомления автору о комментариях — не в MVP.
* WebSocket-обновление счётчиков в реальном времени — не в MVP.
  Числа подтягиваются обычным `GET` при перезагрузке страницы.

## 4. Последствия

**Плюсы.**

* Все три счётчика отдаются одним select из `BlogPost`, без агрегатов.
* Лайк и комментарий — обычные REST, без WebSocket-зависимостей.
* Дедуп просмотров через Redis SET — горизонтально, без таблицы.
* Контракт типов в shared — фронт и бэк не разъедутся.

**Минусы / риски.**

* Денормализованные счётчики могут разойтись с детальными таблицами
  при сбое транзакции. Митигация — серверный cron (раз в сутки)
  пересчитывает `likesCount` и `commentsCount` из COUNT(*) и
  выправляет рассинхрон. `viewsCount` не имеет источника правды —
  если потерялся инкремент, его не восстановить (это допустимо
  для счётчика просмотров).
* Накрутка просмотров: дедуп по `IP+UA` обходится сменой одного из
  двух. Реалистичная защита от целенаправленной накрутки требует
  reCAPTCHA или Cloudflare Turnstile, что несоразмерно стоимости
  для показателя «сколько раз открыли». В MVP считаем приемлемым.
* Цензура HTML в комментариях — простая (вырезаем теги), но XSS-риск
  именно в комментариях гораздо ниже, чем в Markdown статей (ADR-137 §2.3).
  Тем не менее plain-text-only — обязательное требование.
* «Лайк на (slug, locale)» означает: один читатель, читающий RU и
  EN, потенциально может поставить два лайка. Это не злоупотребление,
  это норма (он реально лайкнул и одну, и другую публикацию). Объяснение
  для маркетинга — при расчёте «лайков статьи» суммируем по slug.

## 5. Открытые вопросы

1. **Снэпшоты viewsCount во времени** — будет ли продакту нужна
   «динамика за месяц». Решается добавлением `BlogPostViewSnapshot`
   с daily-cron, без миграции основной схемы.
2. **Уведомления о новых комментариях**. Источник запроса не
   обозначен; не делаем сейчас.
3. **Премодерация комментариев** — если поток окажется выше
   ожидаемого. Сейчас нет.
4. **Антиспам через каптчу** — пока не нужен (только авторизованные,
   per-user rate-limit). Триггер «нужно» — массовая регистрация
   ботов; пока не зафиксирована.

## 6. Декомпозиция задач

Одна задача = один агент = одно законченное действие, без
смешения слоёв.

| T | Кому | Что |
|---|------|-----|
| T1 | backend  | Prisma-миграция: добавить `views_count`, `likes_count`, `comments_count` в `blog_posts`; создать `blog_post_likes` и `blog_post_comments` со связями и индексами по §2.1. Обновить `prisma:generate`. |
| T2 | backend  | Расширить типы в `packages/shared/src/types/blog.ts` по §2.5 (`BlogPostListItem` с тремя счётчиками + `likedByMe`; `BlogComment`, `BlogCommentsPage`, `BlogViewResponse`, `BlogLikeResponse`). Без логики, только типы. |
| T3 | backend  | `POST /blog/posts/:id/view` с дедупом через Redis SET (TTL 24h), `OptionalJwtGuard`, `RedisRateLimitGuard @RateLimit(30, 60)`, отсев ботов по UA, проверка `Origin/Referer`. Атомарный `UPDATE views_count`. Ответ `BlogViewResponse`. |
| T4 | backend  | `POST/DELETE /blog/posts/:id/like` под `JwtAuthGuard` + per-user rate-limit. Идемпотентность через `INSERT ... ON CONFLICT DO NOTHING` / `DELETE ... IF EXISTS`. Поддержка `likes_count` в одной транзакции. Ответ `BlogLikeResponse`. |
| T5 | backend  | Маршруты комментариев: `GET /blog/posts/:id/comments` (cursor-пагинация, OptionalJwtGuard, поле `canEdit/canDelete`), `POST /blog/posts/:id/comments`, `PATCH /blog/comments/:id` (15-мин окно), `DELETE /blog/comments/:id` (soft, автор или админ). Per-user rate-limit. Поддержка `comments_count`. |
| T6 | backend  | Расширить `blog.service.ts` методы `listPosts` и `getPost`: подключить `OptionalJwtGuard` к публичным контроллерам, в выдаче — три счётчика и `likedByMe` (через left-join с `blog_post_likes` если `req.user`). Юнит-тесты на новые поля. |
| T7 | backend  | Cron-сервис (`@Cron('0 3 * * *')`) для ежесуточного пересчёта `likes_count` и `comments_count` из COUNT(\*) — выправляет рассинхрон после сбоев. `views_count` не трогает. |
| T8 | frontend | `BlogPostPage` — после загрузки деталки + `setTimeout(5000)` шлёт `POST /blog/posts/:id/view`. Идемпотентность через `sessionStorage('blog-viewed:<slug>:<locale>')`. UI: показать `viewsCount` иконкой. |
| T9 | frontend | `BlogPostPage` — `LikeButton` (count + toggle). Для гостя клик → модалка логина (переиспользовать существующий паттерн с puzzle). Хук `useTogglePostLike` поверх react-query c оптимистичным апдейтом. |
| T10 | frontend | `BlogCommentsSection` под статьёй: курсорная пагинация (`useInfiniteQuery`), форма «добавить» (только авторизованным; гостям — кнопка «Войдите, чтобы комментировать»), inline-редактирование (видно 15 мин), кнопка «удалить» (своё или админ), плашка «комментарий удалён». |
| T11 | frontend | `BlogFeedPage` — карточка показывает три счётчика (views/likes/comments) маленькими иконками + числом. Без действий. |
| T12 | qa       | Ручная проверка по сценариям: гость открывает статью → +1 просмотр; повторное открытие за сутки — без инкремента; авторизованный лайк/анлайк; добавление/правка/удаление комментария; превышение rate-limit → 429; ботский UA → 200 без инкремента; деленный комментарий показывает плашку; счётчики растут синхронно. Заводит баги при расхождениях. |

### Порядок

T1 → T2 → (T3 ∥ T4 ∥ T5) → T6 → T7 (cron — после того как
счётчики живые) → (T8 ∥ T9 ∥ T10 ∥ T11) → T12.

Параллельно после T2: frontend может заглушить ответ моками и
начать T8/T9/T10 на стабах, но финальная интеграция — после T6.

### Откат

* До T6 — контракт API не менялся, фронт работает по старому.
* После T6 (расширены публичные эндпоинты), но до T8/T9/T10 —
  фронт игнорирует новые поля (TS-совместимо, поля опциональны на
  фронте можно не выводить).
* После T8/T9/T10 — точка невозврата: фронт ждёт счётчики.
  Откат потребует возврата к версии без них.
