/**
 * KS-4433 / ADR-137 rev2. Одноразовая правка тела статьи
 * «Критический момент»: убрать первую строку `# …` (дубль H1) и
 * строку `*Подзаголовок:` / `*Subtitle:` для обеих локалей. Тело
 * хранится в БД как Markdown — рендерим заново через тот же
 * `renderMarkdownToHtml`, что и сидер/публикация.
 *
 * Идемпотентно: повторный прогон — те же первые строки уже
 * вычищены, текст не меняется, body_html совпадает.
 *
 * Реализовано напрямую через Prisma (а не PATCH /admin/blog/posts
 * + JWT): прод JWT_SECRET недоступен из локального dev-окружения,
 * а внутри prod-контейнера прямой Prisma — короче и не требует
 * прод-учётки админа. Запуск — через ECS RunTask по той же схеме,
 * что KS-4415 / KS-4427.
 */
import { PrismaClient } from '@kingside/db';
import {
  estimateReadingTimeMin,
  renderMarkdownToHtml,
} from '../blog/markdown';

const SLUG = 'critical-moment';

/**
 * Удаляет первый `# H1` и одну следующую за ним строку-«подзаголовок»
 * (выделенный курсивом, `*…*`). Идемпотентно: на уже почищенном теле
 * первое условие `^# ` не сработает и функция вернёт оригинал.
 */
export function stripDuplicateH1AndSubtitle(md: string): string {
  const trimmed = md.replace(/^\s+/, '');
  const lines = trimmed.split('\n');
  const out: string[] = [];
  let removedH1 = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!removedH1 && /^#\s+\S/.test(line)) {
      // 1. Удалили H1.
      removedH1 = true;
      i++;
      // 2. Затем съедаем пустые строки (отделители).
      while (i < lines.length && lines[i].trim() === '') i++;
      // 3. Если следующая строка — *…* курсивом-подзаголовок, удаляем и её.
      if (i < lines.length && /^\*[^*]+\*\s*$/.test(lines[i].trim())) {
        i++;
      }
      // 4. Снова съедаем пустые строки, чтобы тело начиналось с
      // абзаца без лишней пустой строки сверху.
      while (i < lines.length && lines[i].trim() === '') i++;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n').replace(/^\s+/, '');
}

export interface PatchBodyPrisma {
  blogPost: {
    findMany: (args: unknown) => Promise<
      Array<{
        id: string;
        slug: string;
        locale: string;
        bodyMd: string;
      }>
    >;
    update: (args: unknown) => Promise<unknown>;
  };
  $disconnect?: () => Promise<void>;
}

export async function patchCriticalMomentBody(
  prisma: PatchBodyPrisma,
  log: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Promise<{ updated: number; skipped: number }> {
  const posts = await prisma.blogPost.findMany({
    where: { slug: SLUG },
    select: { id: true, slug: true, locale: true, bodyMd: true },
  });
  log(`[patch-critical-moment] found ${posts.length} posts for slug=${SLUG}`);

  let updated = 0;
  let skipped = 0;
  for (const post of posts) {
    const newBody = stripDuplicateH1AndSubtitle(post.bodyMd);
    if (newBody === post.bodyMd) {
      log(
        `[patch-critical-moment] SKIP ${post.locale} id=${post.id} (тело уже чистое)`,
      );
      skipped++;
      continue;
    }
    const bodyHtml = await renderMarkdownToHtml(newBody);
    const readingTimeMin = estimateReadingTimeMin(newBody);
    await prisma.blogPost.update({
      where: { id: post.id },
      data: {
        bodyMd: newBody,
        bodyHtml,
        readingTimeMin,
      },
    });
    log(`[patch-critical-moment] OK   ${post.locale} id=${post.id}`);
    updated++;
  }
  log(
    `[patch-critical-moment] DONE updated=${updated} skipped=${skipped}`,
  );
  return { updated, skipped };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await patchCriticalMomentBody(prisma as unknown as PatchBodyPrisma);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    process.stderr.write(
      `✗ patch-critical-moment-body fatal: ${(e as Error).message}\n`,
    );
    process.exit(1);
  });
}
