/**
 * KS-4427 / ADR-137 rev2. Одноразовая публикация первой статьи блога
 * «Критический момент» (RU + EN). Тексты — финальные версии маркетинга
 * из истории KS-4389. По правилу T18 — маркетинг вычитает после
 * публикации и при необходимости пушит правки через админ-CRUD.
 *
 * Запуск:
 *   - локально:  `npm run publish:critical-moment --workspace=@kingside/api`
 *   - на проде:  ECS RunTask с переопределением command =
 *                ["node", "dist/scripts/publish-critical-moment.js"].
 *
 * Идемпотентность: upsert по UNIQUE(`slug`, `locale`). Повторный
 * прогон обновит `body_html` (если поменялся рендер) и `body_md`,
 * но не задвоит строки. `published_at` при повторном прогоне
 * сохраняется (не перезаписывается, если уже был задан).
 */
import { PrismaClient } from '@kingside/db';
import {
  estimateReadingTimeMin,
  renderMarkdownToHtml,
} from '../blog/markdown';

const SLUG = 'critical-moment';
const AUTHOR_HANDLE = 'kingside';

const TITLE_RU =
  'Критический момент: как мы отбираем позиции, в которых работает только один ход';
const DESCRIPTION_RU =
  'Технический разбор раздела «Критический момент»: Stockfish (MultiPV=10, два прохода 1M и 10M узлов, WDL), Maia ONNX 2400, формула difficulty и пороги отбора позиций.';

const BODY_RU = `# Критический момент: как мы отбираем позиции, в которых работает только один ход

*Подзаголовок: алгоритм отбора на Stockfish и Maia, формула difficulty и пороги, по которым позиция попадает в раздел.*

Мы запустили раздел \`/critical-moment\` — тренажёр на позициях с единственным сильным ходом, который не находит даже сильная нейросеть. В статье — устройство отбора: что считает Stockfish, что — Maia, какие пороги и почему позиция «живёт» как пазл только до тех пор, пока её сложность сохраняется. Текст рассчитан на шахматистов от 1500 ELO и тренеров, которые хотят понимать механику.

## Что считается «Критическим моментом»

Полупозиция, в которой одновременно:
- среди всех ходов есть ровно один ход на вершине WDL-оценки (\`|strongSet| = 1\`),
- Maia 2400 оценивает вероятность найти его человеком < 10%,
- между ним и вторым кандидатом ощутимый разрыв (\`gap ≥ 0.2\`),
- альтернативы «сыграть слабый ход и не проиграть» нет (\`lossRisk ≤ 0.5\`).

Все условия проверяются формально, без ручной разметки и категорий («комбинация», «эндшпиль», «жертва»). Пороги пройдены — позиция в выборке. Хотя бы один нет — отбраковка.

## Алгоритм отбора

Источник — современные классические партии 2600+ ELO с TWIC. Каждая позиция проходит конвейер.

**Шаг 1. Stockfish, MultiPV = 10, два прохода.** Первый — быстрый, 1 000 000 узлов: отсеиваются очевидно равные и уже проигранные позиции. Если топ-3 хода по WDL близки — кандидата на «единственный ход» нет, позиция отбрасывается. Второй — глубокий, 10 000 000 узлов, на выживших. Stockfish даёт стабильную WDL-оценку всем десяти ходам; строится \`strongSet\` — множество ходов, чья WDL отличается от лучшей не более чем на \`gap = 0.2\`. Для прохода требуется \`|strongSet| = 1\`.

**Шаг 2. Maia ONNX, ELO 2400.** На выживших позициях запускается Maia — нейросеть, имитирующая игрока заданного рейтинга. Inference через ONNX Runtime; модель возвращает \`policy\` — распределение вероятностей по ходам, как сыграл бы 2400. Сложность:

\`\`\`
difficulty = 1 − Σ policy(m), m ∈ strongSet
\`\`\`

То есть вероятность, что игрок 2400 не найдёт ни один сильный ход. При \`|strongSet| = 1\` сводится к \`1 − policy(bestMove)\`. Порог — \`difficulty > 0.9\`.

**Шаг 3. Защита от ловушек.** Считается \`lossRisk\` — суммарная вероятность, что игрок выберет ход, ведущий к проигрышу по WDL. Порог \`lossRisk ≤ 0.5\`: позиция должна быть трудной для нахождения, а не «угадайкой». Раздел про мышление, не про ставку.

## Чем отличается от классических тактических пазлов

В классических пазлах критерий — форсированная последовательность с матом или выигрышем материала; вариант можно расписать. В «Критическом моменте» критерий иной: ход просто **лучший**. Это может быть профилактика, перевод фигуры, размен, изменение пешечной структуры — всё, что Stockfish видит как единственный путь, а Maia как непосильную задачу для человека. Отсюда отсутствие градации сложности и категорий: все позиции прошли одни и те же пороги, «лёгких» по определению нет.

## Как устроен сам пазл

После хода игрока позиция меняется. Чтобы пазл продолжался, она должна снова удовлетворять критерию. Проверка идёт **в браузере** — тем же модулем, что и на сервере, переиспользованным из \`packages/shared\`: Stockfish WASM + Maia в ONNX Web Runtime.

Цикл на каждом полуходе:

1. Игрок ходит.
2. Ход не из \`strongSet\` — пазл завершён ошибкой.
3. Ход правильный — в новой позиции пересчитываются \`strongSet\`, \`difficulty\`, \`gap\`, \`lossRisk\`.
4. Все пороги пройдены — соперник отвечает, цикл повторяется.
5. Хотя бы один порог не прошёл (позиция «остыла», стала технической, дошло до мата) — пазл завершён успехом.

Длина пазла — следствие позиции, а не разметки. Бывает один полуход, бывает шесть.

## Попробовать

[\`/critical-moment\`](/critical-moment) — без регистрации для одного пазла; история и статистика — для авторизованных.
`;

const TITLE_EN =
  'Critical Moment: how we filter chess positions where only one move works';
const DESCRIPTION_EN =
  'Technical walkthrough of the Critical Moment section: Stockfish (MultiPV=10, two passes at 1M and 10M nodes, WDL), Maia ONNX 2400, the difficulty formula, and the position-selection thresholds.';

const BODY_EN = `# Critical Moment: how we filter chess positions where only one move works

*Subtitle: the Stockfish-plus-Maia selection pipeline, the difficulty formula, and the thresholds a position must pass to enter the section.*

We launched \`/critical-moment\` — a training section built around positions with one strong move that even a strong neural net misses. This article is the internals: what Stockfish computes, what Maia computes, the thresholds, and why a puzzle keeps running only as long as its difficulty holds. Audience — players 1500+ and coaches who want to see the mechanics.

## What counts as a Critical Moment

A half-position where simultaneously:
- exactly one move sits at the top of the WDL evaluation (\`|strongSet| = 1\`),
- Maia 2400 estimates the probability of a human finding it at < 10%,
- there is a meaningful WDL gap to the second candidate (\`gap ≥ 0.2\`),
- no "safe weak move" exists — playing badly costs the game (\`lossRisk ≤ 0.5\`).

All conditions are formal. No manual tagging, no categories ("combination", "endgame", "sacrifice"). Thresholds pass — the position joins the pool. Any one fails — it is dropped.

## The selection pipeline

Source — modern classical games rated 2600+ from TWIC. Every position runs through the pipeline.

**Step 1. Stockfish, MultiPV = 10, two passes.** First — fast, 1,000,000 nodes — discards obviously equal or already lost positions. If the top three WDL values are close, no "only move" candidate exists. Second — deep, 10,000,000 nodes — on the survivors. Stockfish returns a stable WDL value for all ten moves; we build \`strongSet\` — the set of moves whose WDL differs from the best by no more than \`gap = 0.2\`. To pass we require \`|strongSet| = 1\`.

**Step 2. Maia ONNX, ELO 2400.** Maia is a neural network trained to imitate human players at a fixed rating. Inference runs via ONNX Runtime; the model returns a \`policy\` distribution — what a 2400 player would play. Difficulty:

\`\`\`
difficulty = 1 − Σ policy(m), m ∈ strongSet
\`\`\`

The probability that a 2400 player fails to find any strong move. With \`|strongSet| = 1\` this reduces to \`1 − policy(bestMove)\`. Threshold — \`difficulty > 0.9\`.

**Step 3. Trap protection.** We also compute \`lossRisk\` — the total probability that the player picks a move whose WDL leads to a loss. Threshold — \`lossRisk ≤ 0.5\`: the position must be hard, not a coin flip. The section is about reasoning, not gambling.

## How this differs from classical puzzles

Classical puzzles use a simple criterion: a forced sequence wins material or mates, and you can spell out the variations. Critical Moment uses a different one — the move is simply best. It can be prophylaxis, a piece transfer, a trade, a pawn-structure change — anything Stockfish sees as the only path and Maia treats as out of reach for a human. Hence no difficulty grades and no categories: all positions pass the same thresholds, there are no "easy" puzzles by definition.

## How the puzzle itself runs

After the user's move the position changes. To keep the puzzle alive, the new position must satisfy the criterion again. The check happens **in the browser** — via the same selection module used on the server, reused from \`packages/shared\`: Stockfish WASM + Maia in ONNX Web Runtime.

Loop on every half-move:

1. Player plays a move.
2. Move outside \`strongSet\` — puzzle ends as a failure.
3. Move correct — the new position is re-evaluated: \`strongSet\`, \`difficulty\`, \`gap\`, \`lossRisk\`.
4. All thresholds pass — the engine replies and the loop continues.
5. Any threshold fails (position "cooled down", became technical, reached mate) — puzzle ends as a success.

Puzzle length is a consequence of the position, not a tag. Sometimes one half-move, sometimes six.

## Try it

Available at [\`/critical-moment\`](/critical-moment). No login required for a single run; stats and history — for signed-in users.
`;

const TAGS = ['critical-moment', 'puzzles', 'engine', 'maia'];

interface PostRecord {
  slug: string;
  locale: 'ru' | 'en';
  title: string;
  description: string;
  bodyMd: string;
  tags: string[];
}

const POSTS: PostRecord[] = [
  {
    slug: SLUG,
    locale: 'ru',
    title: TITLE_RU,
    description: DESCRIPTION_RU,
    bodyMd: BODY_RU,
    tags: TAGS,
  },
  {
    slug: SLUG,
    locale: 'en',
    title: TITLE_EN,
    description: DESCRIPTION_EN,
    bodyMd: BODY_EN,
    tags: TAGS,
  },
];

/** Тонкий контракт над `PrismaClient` для тестируемости. */
export interface PublisherPrisma {
  blogAuthor: {
    upsert: (args: unknown) => Promise<{ id: string; handle: string }>;
  };
  blogPost: {
    upsert: (args: unknown) => Promise<unknown>;
  };
  $disconnect?: () => Promise<void>;
}

export async function publishCriticalMoment(
  prisma: PublisherPrisma,
  log: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Promise<{ published: number }> {
  const author = await prisma.blogAuthor.upsert({
    where: { handle: AUTHOR_HANDLE },
    update: {},
    create: {
      handle: AUTHOR_HANDLE,
      nameRu: 'Kingside',
      nameEn: 'Kingside',
    },
  });
  log(`[critical-moment] author handle=${author.handle} id=${author.id}`);

  let published = 0;
  for (const post of POSTS) {
    const bodyHtml = await renderMarkdownToHtml(post.bodyMd);
    const readingTimeMin = estimateReadingTimeMin(post.bodyMd);
    const now = new Date();
    await prisma.blogPost.upsert({
      where: {
        slug_locale: { slug: post.slug, locale: post.locale },
      },
      create: {
        slug: post.slug,
        locale: post.locale,
        title: post.title,
        description: post.description,
        bodyMd: post.bodyMd,
        bodyHtml,
        coverUrl: null,
        coverAlt: null,
        tags: post.tags,
        relatedRoute: '/critical-moment',
        readingTimeMin,
        status: 'published',
        publishedAt: now,
        authorId: author.id,
      },
      // publishedAt НЕ перезаписываем — если статья уже была опубликована
      // (повторный прогон), оставляем оригинальную дату публикации.
      update: {
        title: post.title,
        description: post.description,
        bodyMd: post.bodyMd,
        bodyHtml,
        tags: post.tags,
        relatedRoute: '/critical-moment',
        readingTimeMin,
        status: 'published',
        authorId: author.id,
      },
    });
    log(`[critical-moment] OK ${post.locale} slug=${post.slug}`);
    published++;
  }
  log(`[critical-moment] DONE published=${published}`);
  return { published };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await publishCriticalMoment(prisma as unknown as PublisherPrisma);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    process.stderr.write(
      `✗ publish-critical-moment fatal: ${(e as Error).message}\n`,
    );
    process.exit(1);
  });
}
