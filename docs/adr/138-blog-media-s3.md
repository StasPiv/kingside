# ADR-138: Загрузка OG-обложек блога в S3 одним вызовом админ-API

Связанные тикеты: KS-4437.
Связанные ADR: 137 (rev2, БД-хранилище блога), 116 (S3 для аудио лекций), 040 (board-recognition upload).

## 1. Контекст

По ADR-137 rev2 статьи блога живут в БД, редактируются через `/admin/blog/posts*`. Сейчас обложки кладутся вручную в `apps/web/public/og/*.png` и попадают на сайт деплоем фронта. Это:

* двух-трёх шаговый ручной процесс (положить файл → коммит → деплой);
* раздувает репозиторий — бинарные файлы в git;
* несовместимо с философией «публикация без деплоя» (rev2);
* агент/админ не может загрузить обложку программно за один вызов.

Цель — **один админ-вызов**: создание/обновление статьи вместе с обложкой. Файл уходит в S3, путь возвращается в `coverUrl` записи.

В проекте уже работают S3-паттерны:

* `LectureAudioS3Service` (ADR-116) — основной образец: lazy-init `S3Client`, секреты через AWS Secrets Manager, отдельный CloudFront-distribution для media (`media.kingside.site`), bucket `kingside-lectures` в `eu-central-1`;
* `SitemapService` — пишет JSON в `kingside-prerender-store` через тот же SDK;
* `BoardRecognitionController` — `FileInterceptor('image')` + `Express.Multer.File`, лимит 8 MB (`BOARD_RECOGNITION_MAX_BYTES`);
* `WorkshopController` — `FileInterceptor('file')` для PGN-импорта.

NestJS-инфраструктура для multipart-загрузки уже стандартизирована.

## 2. Решение

### 2.1. Контракт: multipart/form-data

`POST /admin/blog/posts` принимает `multipart/form-data` со следующими полями:

| Поле | Тип | Обязательно | Назначение |
|---|---|---|---|
| `slug` | text | да | Slug статьи |
| `locale` | text | да | `'ru' \| 'en'` |
| `title` | text | да | Заголовок |
| `description` | text | да | Meta-description |
| `bodyMd` | text | да | Markdown тела |
| `tags` | text | нет | JSON-массив (`'["seo","puzzle"]'`) |
| `relatedRoute` | text | нет | Маршрут для CTA-блока |
| `status` | text | нет | `'draft'` (default) или `'published'` |
| `authorHandle` | text | да | Handle автора (из `blog_authors`) |
| `cover` | file | нет | Бинарный файл обложки |
| `coverAlt` | text | если есть `cover` | Alt-текст |

То же поведение для `PUT /admin/blog/posts/:id`. Если `cover` отсутствует — обложка не меняется (или, для PUT, можно явно передать `coverReset=true` чтобы обнулить).

`POST /admin/blog/posts/:id/cover` — отдельный маршрут для загрузки только обложки (если фронту удобнее двухшаговый сценарий: создал → загрузил). Опционально, MVP без него.

**Отвергнутая альтернатива — JSON с base64.**

| Критерий | multipart | base64 в JSON |
|---|---|---|
| Размер payload | 1:1 | +33 % (base64 raw) |
| Поддержка в `curl`/`fetch` | штатная (`-F file=@path`) | требует `base64`-кодирования вручную |
| Совместимость с NestJS | штатная (`FileInterceptor`, как в `board-recognition` и `workshop`) | нужен ручной декодер + лимиты |
| Стриминг | да | нет (буфер в памяти после декодирования) |
| Логи / Sentry | имя файла, mime, размер видны в трассе | base64-строка обрезается, отладка усложнена |

Multipart — стандарт, согласуется с уже существующими в проекте паттернами (`BoardRecognitionController:47`, `WorkshopController:35`).

**Лимиты:**

* `fileSize: 5 * 1024 * 1024` (5 MB) — для OG-картинок 1200×630 PNG/JPEG достаточно с запасом;
* `files: 1`;
* MIME-валидация через `class-validator` или явный check в контроллере: `image/png`, `image/jpeg`, `image/webp`;
* отказ — `415 Unsupported Media Type` для другого MIME, `413` если над лимитом.

**Memory storage** (default multer) — образца `BoardRecognitionController`. Файл в RAM, потом стримим в S3. На 5 MB лимита и нечастых загрузках (1–2 в месяц) проблем не будет.

### 2.2. Хранилище: S3 + CloudFront

**Бакет.** Новый: `kingside-blog-media` в `eu-central-1` (тот же регион, что у `kingside-lectures`).

Почему новый, а не переиспользование `kingside-prerender-store` или `kingside-lectures`:

* `kingside-prerender-store` — служебный, lifecycle и доступы заточены под JSON-снимки prerender; смешивание public media и служебных JSON в одном бакете — плохая практика;
* `kingside-lectures` — аудио-only, с signed-URL и lifecycle для chunks; public media к нему не клеится;
* отдельный bucket → независимые: lifecycle, политика, IAM, метрики, биллинг-секция.

**Layout:**

```
kingside-blog-media/
  blog-covers/
    <slug>-<contentHash>.<ext>      ← OG-обложки статей
  authors/
    <handle>-<contentHash>.<ext>    ← аватары авторов (на вырост)
```

`<contentHash>` — sha256 (первые 8 символов hex) от содержимого файла. Это даёт:

* при перезагрузке обложки (новый файл) — новый URL → не нужно invalidation CloudFront;
* старая обложка остаётся в бакете (можно вернуться откатом записи в БД).

`<ext>` — нормализован по MIME (`image/png` → `.png`, `image/jpeg` → `.jpg`, `image/webp` → `.webp`).

**ACL / политика.** Bucket приватный, доступ к объектам только через **CloudFront OAI (Origin Access Identity)**. Никакого public-read на bucket-уровне. Это стандарт для статики (см. `kingside-lectures` + OAI в ADR-116).

Bucket policy:

```json
{
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity ..." },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::kingside-blog-media/*"
  }]
}
```

**CORS** на bucket — не нужен (запросы идут через CloudFront-домен, не cross-origin). Можно явно `[]`.

### 2.3. CloudFront

Решение — **переиспользовать существующий media-дистрибутив `media.kingside.site`** (KS-3823 / ADR-115, домен `media.kingside.site` → `d32wakhl5f1rmz.cloudfront.net`). Добавить новый origin `kingside-blog-media` + path-pattern `/blog-covers/*` и `/authors/*`.

Альтернатива (отвергнута) — отдельный дистрибутив (`blog-media.kingside.site`). Минусы:

* лишний CloudFront ARN, новая DNS-запись, отдельный SSL;
* билинг и метрики усложняются;
* CORS-настройка дублируется.

Один media-дистрибутив на всю не-видеопроекту — стандартно.

**Cache behaviour:**

* TTL: `max-age=31536000, public, immutable` (1 год) — потому что в URL уже есть `contentHash`, файл по этому URL не меняется;
* CloudFront cache TTL ≥ 1 год;
* при перезагрузке обложки → новый contentHash → новый URL → invalidation не нужен.

**Invalidation.** Не выполняется штатно. Только если меняется *layout* (миграции, переименование префиксов) — тогда отдельная задача devops.

**Итоговый URL** обложки: `https://media.kingside.site/blog-covers/critical-moment-a1b2c3d4.png`. Это значение пишется в `blog_posts.cover_url`.

### 2.4. IAM

ECS task role api-сервиса (`kingside-api`) добавляются права:

```
s3:PutObject       на arn:aws:s3:::kingside-blog-media/blog-covers/*
                   и arn:aws:s3:::kingside-blog-media/authors/*
s3:DeleteObject    на те же префиксы (для будущей чистки оркухонными версиями)
s3:GetObject       не нужен — backend читает только URL для записи в БД
```

Принципал — только сама task role api-сервиса. У CloudFront OAI отдельный доступ через bucket policy (§2.2).

**Секреты.** Не нужны. Backend пишет в bucket через task role (IAM credentials автоматически из ECS metadata service). Никаких access-keys в коде или env.

### 2.5. Backend-модуль

`apps/api/src/blog/blog-media.service.ts`:

```ts
@Injectable()
export class BlogMediaService implements OnModuleInit {
  private s3: S3Client | null = null;
  private bucket!: string;
  private region!: string;
  private cdnBase!: string;

  onModuleInit() {
    this.bucket = this.config.getOrThrow('BLOG_MEDIA_BUCKET');
    this.region = this.config.get('BLOG_MEDIA_REGION', 'eu-central-1');
    this.cdnBase = this.config.getOrThrow('BLOG_MEDIA_CDN_BASE');
  }

  /**
   * Записывает файл в bucket и возвращает публичный CDN-URL.
   * Идемпотентно по contentHash: повторный PUT того же содержимого
   * не создаёт дубликат (PutObject overwrite это OK).
   */
  async uploadCover(slug: string, file: Express.Multer.File): Promise<string> {
    const ext = mimeToExt(file.mimetype);                  // throws 415 if unsupported
    const hash = sha256(file.buffer).slice(0, 8);
    const key = `blog-covers/${slug}-${hash}.${ext}`;
    const sdk = await import('@aws-sdk/client-s3');
    this.s3 ??= new sdk.S3Client({ region: this.region });
    await this.s3.send(new sdk.PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    return `${this.cdnBase}/${key}`;
  }
}

function mimeToExt(mime: string): 'png' | 'jpg' | 'webp' {
  switch (mime) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    default: throw new UnsupportedMediaTypeException();
  }
}
```

Lazy-init S3-SDK — образца `LectureAudioS3Service` (KS-3926).

**Расширение `BlogAdminController`** (ADR-137 §2.3):

```ts
@Post('posts')
@UseInterceptors(FileInterceptor('cover', {
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
}))
async createPost(
  @Body() dto: CreateBlogPostDto,           // multipart-text-поля
  @UploadedFile() cover?: Express.Multer.File,
): Promise<BlogPostAdmin> {
  let coverUrl: string | undefined;
  if (cover) {
    if (!dto.coverAlt) throw new BadRequestException('coverAlt required when cover is set');
    coverUrl = await this.media.uploadCover(dto.slug, cover);
  }
  return this.blogService.create({ ...dto, coverUrl, coverAlt: dto.coverAlt });
}
```

Аналогично `PUT /posts/:id`. Если `cover` отсутствует — `coverUrl` остаётся прежним. Поле `coverReset=true` в DTO явно зануляет.

**DTO `CreateBlogPostDto`** — все строковые поля multipart парсятся `class-transformer` как обычно; `tags` принимаем как строку и парсим JSON в трансформере. Это меньше боли, чем индексированные поля `tags[0]`, `tags[1]`.

### 2.6. Frontend: AdminBlogPostEditPage

* `<input type="file" accept="image/png,image/jpeg,image/webp" />` — выбор файла;
* preview через `URL.createObjectURL(file)` локально, до загрузки;
* при submit формы:
  * `const fd = new FormData(); fd.append('title', title); ... if (file) fd.append('cover', file);`
  * `fetch('/admin/blog/posts', { method: 'POST', body: fd, headers: { 'X-Admin-Api-Key': ... } })`;
* при успехе — сервер вернул `coverUrl`, фронт обновляет состояние;
* размер файла проверяется на клиенте до отправки (мгновенный фидбэк, бэкенд страхует).

### 2.7. Контракт env

| Переменная | Значение | Используется |
|---|---|---|
| `BLOG_MEDIA_BUCKET` | `kingside-blog-media` | backend |
| `BLOG_MEDIA_REGION` | `eu-central-1` | backend |
| `BLOG_MEDIA_CDN_BASE` | `https://media.kingside.site` | backend |

Дефолты для dev — отдельный bucket `kingside-blog-media-dev` или MinIO; решается на T2 (devops).

## 3. Миграция уже выложенной обложки

Сейчас `apps/web/public/og/critical-moment.png` — статика в репо, ссылка в `blog_posts.cover_url` указывает на `/og/critical-moment.png`.

**Шаги:**

1. После запуска T1–T5 (S3-инфраструктура и backend готовы) — однократный CLI-скрипт `apps/api/src/blog/migrate-static-covers.cli.ts`:
   * читает `apps/web/public/og/*.png` (через путь, переданный аргументом, или копию рядом со скриптом);
   * для каждой статьи, чей `cover_url` начинается с `/og/`, загружает соответствующий файл в S3 через `BlogMediaService.uploadCover`;
   * обновляет `cover_url` в БД на новый CDN-URL.
2. Удалить файлы из `apps/web/public/og/critical-moment.png` (и `default.png` — если он только под блог; если используется ещё где-то — оставить).
3. Проверить sitemap, prerender — никаких ссылок не должно быть на старый путь.

**Переходный режим.** Пока миграция не выполнена, новые статьи идут через S3, старые `/og/...` продолжают работать (фронт отдаёт абсолютные URL как есть). Это снимает блокировку «надо мигрировать прежде чем релизить новые».

## 4. План задач-наследников

### Шаг 1. Инфраструктура

| T | Кому | Задача |
|---|---|---|
| T1 | devops | Создать S3 bucket `kingside-blog-media` в `eu-central-1`. Bucket-policy с CloudFront OAI. Без public-read. Lifecycle — не нужен в MVP |
| T2 | devops | Расширить CloudFront-distribution `media.kingside.site` (KS-3823): новый origin `kingside-blog-media`, behaviour `/blog-covers/*` + `/authors/*`, cache TTL 1 год |
| T3 | devops | IAM-policy для ECS task role `kingside-api`: `s3:PutObject`, `s3:DeleteObject` на `kingside-blog-media/blog-covers/*` и `/authors/*` |
| T4 | devops | ENV-переменные в task-definition api-сервиса: `BLOG_MEDIA_BUCKET`, `BLOG_MEDIA_REGION`, `BLOG_MEDIA_CDN_BASE`. Dev-bucket `kingside-blog-media-dev` (или альтернатива) |

### Шаг 2. Backend

| T | Кому | Задача |
|---|---|---|
| T5 | backend | `apps/api/src/blog/blog-media.service.ts` — lazy-init S3Client, метод `uploadCover(slug, file) → cdnUrl` (sha256-имя, ContentType, CacheControl). MIME-валидация (`image/png\|jpeg\|webp`). 415 на других |
| T6 | backend | Расширить `BlogAdminController` (см. ADR-137 §2.3): `POST /admin/blog/posts` и `PUT /admin/blog/posts/:id` через `FileInterceptor('cover')` с лимитом 5 MB. `coverAlt` обязателен при наличии файла. Поле `coverReset=true` зануляет. Логи через структуру `lecture-audio` |
| T7 | backend | DTO `CreateBlogPostDto`/`UpdateBlogPostDto` для multipart: `tags` как JSON-строка с парсингом в трансформере. Тесты на multipart-парсинг |
| T8 | backend | (опц.) `POST /admin/blog/posts/:id/cover` — только-обложка маршрут. В MVP не обязателен |

### Шаг 3. Frontend

| T | Кому | Задача |
|---|---|---|
| T9 | frontend | `AdminBlogPostEditPage` — `<input type="file" accept="image/png,image/jpeg,image/webp">`, превью через `URL.createObjectURL`, размерный check на клиенте (5 MB), вывод ошибки 413/415 |
| T10 | frontend | Submit формы через `FormData` (не JSON). Все поля — text, `cover` — file. Обработка ответа: `coverUrl` из API → обновление состояния и preview из CDN |

### Шаг 4. Миграция

| T | Кому | Задача |
|---|---|---|
| T11 | backend | `apps/api/src/blog/migrate-static-covers.cli.ts` — однократный CLI: читает `apps/web/public/og/*.png` (путь как аргумент), для статей с `cover_url` начинающимся на `/og/` грузит в S3 через `BlogMediaService`, обновляет `cover_url`. Идемпотентно |
| T12 | backend | Запустить T11 на прод. Подтвердить новые `cover_url` в БД для всех мигрированных статей |
| T13 | frontend | Удалить `apps/web/public/og/critical-moment.png` (и других конкретно блог-обложек, если выявит T12). НЕ трогать `default.png` если он используется страницами вне блога |

### Шаг 5. Acceptance

| T | Кому | Задача |
|---|---|---|
| T14 | qa | Прогон: создать статью через `POST /admin/blog/posts` curl-командой с `-F cover=@file.png`. Проверить bucket: объект есть с CacheControl. Проверить CDN: `curl https://media.kingside.site/blog-covers/<slug>-<hash>.png` → 200 + длинный max-age. Проверить запись в БД: `cover_url` равен CDN-URL |

## 5. Порядок и точки безопасной остановки

```
T1 → T2 → T3 → T4         (devops, инфра)
       ↓
T5 → T6 → T7              (backend)
       ↓
T9 → T10                  (frontend)
       ↓
T11 → T12                 (миграция данных)
       ↓
T13                       (cleanup)
       ↓
T14                       (приёмка)
```

**Точки безопасной остановки:**

* После T4 — инфра готова, ничего не пишет;
* После T7 — backend пишет в S3, фронт ещё нет; можно протестировать через curl;
* После T10 — конечный сценарий «создал статью через админку с обложкой» работает; старые статьи остаются с `/og/...`;
* После T12 — старые мигрированы; репо ещё содержит `.png`;
* После T13 — репо чистый, точка невозврата на git-статику.

**Откат:**

* До T11 — реверт-коммитом, новые статьи не идут;
* После T11 — старые `cover_url` уже изменились в БД, откат требует обратной миграции (CDN → `/og/`) и восстановления файлов в git;
* После T13 — нужно достать файлы из bucket или git-history.

## 6. Последствия

**Плюсы.**

* Один админ-вызов вместо «положить файл → коммит → деплой».
* Репо чище, без бинарных файлов.
* Кэш CloudFront 1 год + contentHash в имени → нет invalidation, обложки моментально доступны.
* Стандартный multipart-контракт — совместим с curl, Postman, агентами без ручного base64.
* Никаких новых секретов: backend пишет через ECS task role.

**Минусы / риски.**

* Новый bucket = новый артефакт инфры на сопровождение.
* CloudFront-distribution `media.kingside.site` получает ещё один origin — изменения в путях должны быть аккуратны (не задеть `/audio/*` лекций).
* `body_html` в БД (ADR-137 rev2) содержит ссылки на CDN-URL обложек; при будущем переезде CDN-домена нужна массовая правка `body_html` или редирект на nginx/CloudFront уровне.
* MIME-валидация только по `file.mimetype` — multer берёт его из Content-Type заголовка, который клиент может подделать. Дополнительная защита — magic-bytes check (через `file-type` пакет) — добавляется при необходимости отдельной задачей; в MVP не делаем (admin-only маршрут, доверенный пользователь).

## 7. Открытые вопросы

1. **Аватары авторов** — папка `authors/` в bucket уже заложена в §2.2 layout. Поддержка `PUT /admin/blog/authors/:id/avatar` — отдельной задачей, по аналогии с обложками.
2. **WebP-конвертация на лету** — стоит ли backend перекодировать загруженный PNG/JPEG в WebP для меньшего размера. MVP — нет, кладём как есть. Решается при появлении проблем со скоростью загрузки.
3. **Sharp-валидация размеров** — проверять 1200×630 (рекомендация OG) ли загружен файл. MVP — нет; контент-инженер сам соблюдает. Можно добавить предупреждение в админке без отказа.
4. **Dev-bucket vs MinIO** — нужно ли локальное хранилище для разработки. Решается на T4 (devops).
5. **Удаление обложки при удалении статьи** — нужен ли auto-DeleteObject из bucket. MVP — нет (старые файлы остаются, дёшево); отдельная задача-сборщик мусора через год.
