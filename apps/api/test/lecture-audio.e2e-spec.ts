import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';
import { LectureAudioS3Service } from '../src/lecture-audio/lecture-audio-s3.service';
import { FfmpegConcatService } from '../src/lecture-audio/ffmpeg-concat.service';
import { LectureAudioFinalizerScheduler } from '../src/lecture-audio/lecture-audio-finalizer.scheduler';

/**
 * KS-3838 / ADR-116 §7.3. E2E полный цикл клиентской записи лекции:
 *   start → chunk-url ×N → chunk-ack ×N → end → GET /lectures/:id (audio).
 *
 * `LectureAudioS3Service` подменён моком: реальный S3/CloudFront в e2e
 * не нужен. Тест валидирует контракт REST: статусы, формат тел,
 * 403/404 для не-владельца, идемпотентность ACK, наличие audio в
 * `GET /lectures/:id`.
 *
 * Cron `LectureAudioFinalizerScheduler` отключён через override
 * (внутри тика дёрнул бы тот же мок и засорил счётчики).
 *
 * Окружение: PostgreSQL по DATABASE_URL (apps/api/.env), Redis для
 * `RedisService` (Lectures/LiveAnalysis модули его требуют для
 * подъёма AppModule).
 */

jest.setTimeout(60_000);

class S3Mock {
  presignChunkUpload = jest.fn(
    async (lectureId: string, seq: number) =>
      `https://kingside-lectures.s3.eu-central-1.amazonaws.com/audio/${lectureId}/chunks/${seq}.webm?X-Amz-Signature=MOCK${seq}`,
  );
  listChunks = jest.fn(async (lectureId: string) =>
    Array.from({ length: 3 }, (_, seq) => ({
      seq,
      key: `audio/${lectureId}/chunks/${seq}.webm`,
      etag: `e${seq}`,
      sizeBytes: 100 + seq,
    })),
  );
  downloadObject = jest.fn(async () => undefined);
  deleteChunks = jest.fn(async () => 3);
  putFinalTrack = jest.fn(async () => undefined);
  signedCloudFrontUrl = jest.fn(
    async (lectureId: string) =>
      `https://media.kingside.site/audio/${lectureId}/track.ogg?Key-Pair-Id=K22OGMBTKZ8IZR&Signature=SIG&Expires=1`,
  );
}

class FfmpegMock {
  runWithOutput = jest.fn(
    async <T>(
      _paths: string[],
      cb: (o: { localPath: string; durationMs: number }) => Promise<T>,
    ) => cb({ localPath: '/tmp/out.ogg', durationMs: 12_345 }),
  );
}

class FinalizerSchedulerMock {
  async handleTick(): Promise<void> {
    /* отключено в e2e */
  }
  async runOnce() {
    return { scanned: 0, finalized: 0, skippedNoChunks: 0, failed: 0 };
  }
}

describe('Lecture audio e2e (KS-3838)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let s3: S3Mock;
  let ffmpeg: FfmpegMock;

  let owner: { id: string; token: string };
  let stranger: { id: string; token: string };
  const createdLectureIds: string[] = [];
  const createdUserIds: string[] = [];

  async function registerUser(prefix: string) {
    const suffix = randomUUID().slice(0, 8);
    const username = `${prefix}_${suffix}`;
    const email = `${username}@e2e.local`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ username, email, password: 'Test1234!' })
      .expect(201);
    const token = res.body.accessToken as string;
    const [, payloadB64] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
    return { id: payload.sub as string, token };
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LectureAudioS3Service)
      .useClass(S3Mock)
      .overrideProvider(FfmpegConcatService)
      .useClass(FfmpegMock)
      .overrideProvider(LectureAudioFinalizerScheduler)
      .useClass(FinalizerSchedulerMock)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    s3 = app.get(LectureAudioS3Service) as unknown as S3Mock;
    ffmpeg = app.get(FfmpegConcatService) as unknown as FfmpegMock;

    owner = await registerUser('audio_o');
    stranger = await registerUser('audio_s');
    createdUserIds.push(owner.id, stranger.id);
  });

  afterAll(async () => {
    if (createdLectureIds.length > 0) {
      await prisma.lectureAudioChunk
        .deleteMany({ where: { lectureId: { in: createdLectureIds } } })
        .catch(() => {});
      await prisma.lectureAudio
        .deleteMany({ where: { lectureId: { in: createdLectureIds } } })
        .catch(() => {});
      await prisma.lecture
        .deleteMany({ where: { id: { in: createdLectureIds } } })
        .catch(() => {});
    }
    if (createdUserIds.length > 0) {
      await prisma.user
        .deleteMany({ where: { id: { in: createdUserIds } } })
        .catch(() => {});
    }
    await app.close();
  });

  it('полный цикл: start → chunk-url ×3 → chunk-ack ×3 → end → GET audio', async () => {
    // 1. Создаём лекцию (immediate live, без scheduledAt — статус live).
    const createRes = await request(app.getHttpServer())
      .post('/lectures')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'E2E audio lecture', visibility: 'public' })
      .expect(201);
    const lectureId = createRes.body.lecture.id as string;
    createdLectureIds.push(lectureId);

    // 2. Три раунда chunk-url + chunk-ack. Содержимое мокнуто, важно
    // только что REST-цикл проходит.
    for (let seq = 0; seq < 3; seq++) {
      const urlRes = await request(app.getHttpServer())
        .post(`/lectures/${lectureId}/audio/chunk-url`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ seq, sizeBytes: 1024 + seq })
        .expect(200);
      expect(urlRes.body.uploadUrl).toContain('X-Amz-Signature=');
      expect(urlRes.body.chunkKey).toBe(`audio/${lectureId}/chunks/${seq}.webm`);
      await request(app.getHttpServer())
        .post(`/lectures/${lectureId}/audio/chunk-ack`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({
          seq,
          etag: `etag-${seq}`,
          sizeBytes: 1024 + seq,
          clientCreatedAt: new Date(Date.now() + seq * 1000).toISOString(),
        })
        .expect(200)
        .expect((res) => expect(res.body).toEqual({ ok: true }));
    }

    // 3. Idempotent ACK: повторный вызов того же seq не плодит дубль.
    await request(app.getHttpServer())
      .post(`/lectures/${lectureId}/audio/chunk-ack`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        seq: 0,
        etag: 'etag-0-after-retry',
        sizeBytes: 1024,
        clientCreatedAt: new Date().toISOString(),
      })
      .expect(200);
    const chunkRows = await prisma.lectureAudioChunk.count({
      where: { lectureId },
    });
    expect(chunkRows).toBe(3);

    // 4. Не-владелец не может ни выдать URL, ни ack'ать.
    await request(app.getHttpServer())
      .post(`/lectures/${lectureId}/audio/chunk-url`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .send({ seq: 99, sizeBytes: 1 })
      .expect(403);

    // 5. end → финалайзер: ffmpeg + putFinal + UPSERT LectureAudio +
    // deleteChunks. Все вызваны (через моки).
    const endRes = await request(app.getHttpServer())
      .post(`/lectures/${lectureId}/end`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        offsetMs: 500,
        chunkCount: 3,
        recorderStartedAtClient: new Date().toISOString(),
        recorderEndedAtClient: new Date(Date.now() + 12_000).toISOString(),
      })
      .expect(200);
    expect(endRes.body.audio.lectureId).toBe(lectureId);
    expect(endRes.body.audio.durationMs).toBe(12_345);
    expect(endRes.body.audio.offsetMs).toBe(500);
    expect(ffmpeg.runWithOutput).toHaveBeenCalled();
    expect(s3.putFinalTrack).toHaveBeenCalledWith(lectureId, '/tmp/out.ogg');
    expect(s3.deleteChunks).toHaveBeenCalledWith(lectureId);

    // 6. Idempotent end: повторный вызов не запускает ffmpeg.
    (ffmpeg.runWithOutput as jest.Mock).mockClear();
    await request(app.getHttpServer())
      .post(`/lectures/${lectureId}/end`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({})
      .expect(200);
    expect(ffmpeg.runWithOutput).not.toHaveBeenCalled();

    // 7. GET /lectures/:id — audio есть, url подписан.
    const getRes = await request(app.getHttpServer())
      .get(`/lectures/${lectureId}`)
      .expect(200);
    expect(getRes.body.audio).toBeDefined();
    expect(getRes.body.audio.url).toContain('/audio/');
    expect(getRes.body.audio.url).toContain('Signature=');
    expect(getRes.body.audio.durationMs).toBe(12_345);
    expect(getRes.body.audio.offsetMs).toBe(500);
    expect(getRes.body.audio.codec).toBe('opus');
    expect(getRes.body.audio.container).toBe('ogg');
  });

  it('end без чанков → 422 no-chunks', async () => {
    // Лекция без единого ACK + S3-мок переключаем на пустой listChunks.
    (s3.listChunks as jest.Mock).mockResolvedValueOnce([]);

    const createRes = await request(app.getHttpServer())
      .post('/lectures')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'E2E empty audio', visibility: 'public' })
      .expect(201);
    const lectureId = createRes.body.lecture.id as string;
    createdLectureIds.push(lectureId);

    const endRes = await request(app.getHttpServer())
      .post(`/lectures/${lectureId}/end`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({})
      .expect(422);
    // AllExceptionsFilter перепаковывает тело: `code` теряется,
    // остаются `statusCode`, `message`, `path`. Проверяем
    // содержательное сообщение.
    expect(endRes.body.statusCode).toBe(422);
    expect(String(endRes.body.message)).toMatch(/No chunks in S3/i);
  });

  it('chunk-url не-владельцу → 403', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/lectures')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: 'E2E forbidden', visibility: 'public' })
      .expect(201);
    const lectureId = createRes.body.lecture.id as string;
    createdLectureIds.push(lectureId);

    await request(app.getHttpServer())
      .post(`/lectures/${lectureId}/audio/chunk-url`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .send({ seq: 0, sizeBytes: 1000 })
      .expect(403);
  });
});
