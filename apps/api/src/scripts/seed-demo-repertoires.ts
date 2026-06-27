#!/usr/bin/env node
/**
 * KS-4674 / ADR-146 §2.3. Один-разовый bootstrap: переносит PGN-файлы
 * из `apps/api/src/opening-trainer/seeds/demo-repertoires/*.pgn` в
 * `opening_repertoires` как `is_demo=true` + создаёт по одному
 * `OpeningRepertoireSource` (sourceKind='legacy-import').
 *
 * После KS-4674 источник истины — БД. Этот скрипт — для:
 *   - первого переноса исторического файл-набора в БД на проде;
 *   - локальной разработки на чистом снапшоте: `npm run seed:demo-repertoires`.
 *
 * Идемпотентен: upsert по `(is_demo=true, slug=<file-name>)` — повторный
 * запуск перезапишет tree/PGN, не создаст дубликат.
 *
 * Запуск:
 *   cd apps/api
 *   node dist/scripts/seed-demo-repertoires.js
 *
 * (или ts-node для разработки)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaClient } from '@kingside/db';
import { RepertoireBuilderService } from '../opening-trainer/repertoire-builder.service';

const SEED_DIR = path.resolve(
  __dirname,
  '..',
  'opening-trainer',
  'seeds',
  'demo-repertoires',
);
const SLUG_RE = /^[a-z0-9-]+$/;

interface MetaFile {
  side?: 'white' | 'black';
  description?: string;
}

function readMeta(slug: string): MetaFile {
  const metaPath = path.join(SEED_DIR, `${slug}.meta.json`);
  if (!fs.existsSync(metaPath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const r = raw as Record<string, unknown>;
    return {
      side: r.side === 'black' ? 'black' : r.side === 'white' ? 'white' : undefined,
      description: typeof r.description === 'string' ? r.description : undefined,
    };
  } catch {
    return {};
  }
}

function extractTagFromPgn(pgn: string, tag: string): string | null {
  const re = new RegExp(`^\\[${tag}\\s+"([^"]*)"\\]`, 'm');
  const m = re.exec(pgn);
  if (!m) return null;
  const v = m[1].trim();
  if (v.length === 0 || v === '?') return null;
  return v;
}

function slugToTitle(slug: string): string {
  return slug
    .split('-')
    .filter((p) => p.length > 0)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(' ');
}

async function main(): Promise<void> {
  if (!fs.existsSync(SEED_DIR)) {
    console.error(`[seed-demo-repertoires] directory not found: ${SEED_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(SEED_DIR).filter((f) => f.toLowerCase().endsWith('.pgn'));
  if (files.length === 0) {
    console.log(`[seed-demo-repertoires] no .pgn files in ${SEED_DIR} — nothing to import`);
    return;
  }

  const prisma = new PrismaClient();
  const builder = new RepertoireBuilderService();
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  try {
    for (const file of files) {
      const slug = file.slice(0, -'.pgn'.length).toLowerCase();
      if (!SLUG_RE.test(slug)) {
        console.warn(`[seed-demo-repertoires] skip "${file}": slug "${slug}" does not match [a-z0-9-]+`);
        skipped += 1;
        continue;
      }
      const pgn = fs.readFileSync(path.join(SEED_DIR, file), 'utf8').replace(/^﻿/, '');
      const meta = readMeta(slug);
      let tree;
      try {
        tree = builder.buildTree(pgn);
      } catch (e) {
        console.warn(`[seed-demo-repertoires] skip "${file}": builder rejected (${(e as Error).message})`);
        skipped += 1;
        continue;
      }
      const title = extractTagFromPgn(pgn, 'Event') ?? slugToTitle(slug);
      const description =
        meta.description ?? extractTagFromPgn(pgn, 'Annotator') ?? null;
      const side: 'white' | 'black' = meta.side ?? 'white';

      const existing = await prisma.openingRepertoire.findFirst({
        where: { isDemo: true, slug },
        select: { id: true, sources: { orderBy: { createdAt: 'asc' }, take: 1 } },
      });
      if (existing) {
        await prisma.openingRepertoire.update({
          where: { id: existing.id },
          data: {
            title,
            description,
            side,
            pgn,
            tree: tree as object,
            nodeCount: tree.meta.nodeCount,
            edgeCount: tree.meta.edgeCount,
            maxDepth: tree.meta.maxDepth,
            isPublished: true,
            ...(existing.sources[0]
              ? {
                  sources: {
                    update: {
                      where: { id: existing.sources[0].id },
                      data: { pgn, name: title },
                    },
                  },
                }
              : {
                  sources: {
                    create: {
                      name: title,
                      pgn,
                      sourceKind: 'legacy-import',
                    },
                  },
                }),
          },
        });
        updated += 1;
        console.log(`[seed-demo-repertoires] updated slug=${slug}`);
      } else {
        await prisma.openingRepertoire.create({
          data: {
            userId: null,
            isDemo: true,
            isPublished: true,
            slug,
            title,
            description,
            side,
            pgn,
            tree: tree as object,
            nodeCount: tree.meta.nodeCount,
            edgeCount: tree.meta.edgeCount,
            maxDepth: tree.meta.maxDepth,
            sources: {
              create: {
                name: title,
                pgn,
                sourceKind: 'legacy-import',
              },
            },
          },
        });
        imported += 1;
        console.log(`[seed-demo-repertoires] imported slug=${slug}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
  console.log(
    `[seed-demo-repertoires] done: imported=${imported} updated=${updated} skipped=${skipped} files=${files.length}`,
  );
}

main().catch((e) => {
  console.error(`[seed-demo-repertoires] fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
