-- KS-3829 / ADR-116 §4, §7.3. Аудио лекции (клиентская запись, P2P).
--
-- LectureAudio — финальные метаданные одной аудио-дорожки лекции (один к
-- одному с Lecture). Создаётся cron-finalizer'ом (KS-A05'), который
-- склеивает чанки клиентской записи через `ffmpeg -c copy -f ogg`.
--
-- LectureAudioChunk — журнал чанков клиентской записи. Каждый чанк —
-- отдельный объект в S3 (бакет ks-lectures, префикс chunks/<lecture>/),
-- идемпотентность обеспечивается UNIQUE(lecture_id, seq) — повторное
-- подтверждение того же seq не создаёт дубля.
--
-- Связи: оба FK lecture_id → lectures.id ON DELETE CASCADE — при удалении
-- лекции уходят и метаданные, и журнал чанков.

-- CreateTable: lecture_audio
CREATE TABLE "lecture_audio" (
    "id" UUID NOT NULL,
    "lecture_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "codec" TEXT NOT NULL DEFAULT 'opus',
    "container" TEXT NOT NULL DEFAULT 'ogg',
    "bitrate_kbps" INTEGER,
    "channels" INTEGER NOT NULL DEFAULT 1,
    "duration_ms" INTEGER,
    "offset_ms" INTEGER,
    "recorder_started_at_client" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lecture_audio_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (UNIQUE — одна аудио-дорожка на лекцию)
CREATE UNIQUE INDEX "lecture_audio_lecture_id_key"
  ON "lecture_audio"("lecture_id");

-- CreateIndex (для include по lectureId; формально дублирует UNIQUE,
-- сохраняем под Gherkin/планировщик запросов)
CREATE INDEX "lecture_audio_lecture_id_idx"
  ON "lecture_audio"("lecture_id");

-- AddForeignKey: lecture_audio.lecture_id → lectures.id (CASCADE)
ALTER TABLE "lecture_audio"
  ADD CONSTRAINT "lecture_audio_lecture_id_fkey"
  FOREIGN KEY ("lecture_id") REFERENCES "lectures"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: lecture_audio_chunks
CREATE TABLE "lecture_audio_chunks" (
    "id" UUID NOT NULL,
    "lecture_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "etag" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "client_created_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lecture_audio_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (UNIQUE — идемпотентность повторных подтверждений seq)
CREATE UNIQUE INDEX "lecture_audio_chunks_lecture_id_seq_key"
  ON "lecture_audio_chunks"("lecture_id", "seq");

-- CreateIndex (выборка журнала лекции для cron-finalizer'а)
CREATE INDEX "lecture_audio_chunks_lecture_id_idx"
  ON "lecture_audio_chunks"("lecture_id");

-- AddForeignKey: lecture_audio_chunks.lecture_id → lectures.id (CASCADE)
ALTER TABLE "lecture_audio_chunks"
  ADD CONSTRAINT "lecture_audio_chunks_lecture_id_fkey"
  FOREIGN KEY ("lecture_id") REFERENCES "lectures"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
