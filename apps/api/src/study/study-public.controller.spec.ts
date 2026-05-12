/**
 * KS-2815 / KS-2821 T6. Тесты публичного контроллера: anonymous
 * читает public-главу, на private/несуществующую — 404.
 */
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { StudyPublicController } from './study-public.controller';
import { StudyService } from './study.service';
import { StudyChaptersService } from './study-chapters.service';
import { PrismaService } from '../prisma/prisma.service';

const chapterId = '99999999-9999-4999-a999-999999999999';
const studyOwner = '11111111-1111-4111-a111-111111111111';

async function makeApp(opts: {
  chapter: any;
  studyList?: any;
  chapterDto?: any;
}): Promise<INestApplication> {
  const prisma = {
    studyChapter: {
      findUnique: jest.fn(async () => opts.chapter),
    },
  };
  const studyService = {
    list: jest.fn(async () => opts.studyList ?? { data: [] }),
  };
  const chaptersService = {
    getById: jest.fn(async () => opts.chapterDto ?? null),
  };
  const module = await Test.createTestingModule({
    controllers: [StudyPublicController],
    providers: [
      { provide: PrismaService, useValue: prisma },
      { provide: StudyService, useValue: studyService },
      { provide: StudyChaptersService, useValue: chaptersService },
    ],
  }).compile();
  const app = module.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return app;
}

describe('StudyPublicController — KS-2821 T6', () => {
  let app: INestApplication;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('GET /studies/public — anonymous каталог публичных', async () => {
    app = await makeApp({
      chapter: null,
      studyList: {
        data: [
          {
            id: 's1',
            ownerId: studyOwner,
            slug: 'a-b-c',
            name: 'Public Study',
            description: null,
            isPublic: true,
            chaptersCount: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    });
    const res = await request(app.getHttpServer())
      .get('/studies/public')
      .expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].isPublic).toBe(true);
  });

  it('GET /studies/public/c/:chapterId — public глава → 200', async () => {
    app = await makeApp({
      chapter: {
        id: chapterId,
        studyId: 's1',
        study: {
          id: 's1',
          ownerId: studyOwner,
          slug: 'a-b-c',
          name: 'Public Study',
          isPublic: true,
        },
      },
      chapterDto: {
        id: chapterId,
        studyId: 's1',
        name: 'C1',
        orderIdx: 1000,
        pgn: '1. e4 *',
        startFen: null,
        orientation: 'white',
        mode: 'analysis',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const res = await request(app.getHttpServer())
      .get(`/studies/public/c/${chapterId}`)
      .expect(200);
    expect(res.body.chapter.pgn).toBe('1. e4 *');
    expect(res.body.study).toEqual({
      id: 's1',
      slug: 'a-b-c',
      name: 'Public Study',
      ownerId: studyOwner,
    });
  });

  it('GET /studies/public/c/:chapterId — приватная глава → 404', async () => {
    app = await makeApp({
      chapter: {
        id: chapterId,
        studyId: 's1',
        study: {
          id: 's1',
          ownerId: studyOwner,
          slug: 'private',
          name: 'Private',
          isPublic: false,
        },
      },
    });
    await request(app.getHttpServer())
      .get(`/studies/public/c/${chapterId}`)
      .expect(404);
  });

  it('GET /studies/public/c/:chapterId — несуществующий → 404', async () => {
    app = await makeApp({ chapter: null });
    await request(app.getHttpServer())
      .get(`/studies/public/c/${chapterId}`)
      .expect(404);
  });

  it('некорректный UUID → 400 (ParseUUIDPipe)', async () => {
    app = await makeApp({ chapter: null });
    await request(app.getHttpServer())
      .get('/studies/public/c/not-a-uuid')
      .expect(400);
  });
});
