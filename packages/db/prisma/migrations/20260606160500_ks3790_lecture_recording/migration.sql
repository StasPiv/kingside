-- KS-3790 / ADR-113 §2.3.3, §4 крупная задача 2. Запись лекции.
--
-- LectureRecording — упорядоченный массив событий (move/state-patch/…)
-- с временной меткой `t: number` относительно старта записи. Создаётся
-- финализатором при закрытии live-сессии (KS-3791 далее).
--
-- Связь с Lecture:
--   * FK lecture_recordings.lecture_id → lectures.id ON DELETE CASCADE
--     (основная owner-связь; одна запись на лекцию — UNIQUE).
--   * FK lectures.recording_id → lecture_recordings.id ON DELETE SET NULL
--     («текущая» запись лекции; уже nullable из KS-3783).

-- CreateTable
CREATE TABLE "lecture_recordings" (
    "id" UUID NOT NULL,
    "lecture_id" UUID NOT NULL,
    "starting_fen" TEXT,
    "orientation" TEXT,
    "events" JSONB NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "event_count" INTEGER NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lecture_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (UNIQUE по lecture_id — одна запись на лекцию)
CREATE UNIQUE INDEX "lecture_recordings_lecture_id_key"
  ON "lecture_recordings"("lecture_id");

-- AddForeignKey: lecture_recordings.lecture_id → lectures.id (CASCADE)
ALTER TABLE "lecture_recordings"
  ADD CONSTRAINT "lecture_recordings_lecture_id_fkey"
  FOREIGN KEY ("lecture_id") REFERENCES "lectures"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: lectures.recording_id → lecture_recordings.id (SET NULL)
-- Поле lectures.recording_id уже добавлено в миграции KS-3783, здесь
-- ставится только FK.
ALTER TABLE "lectures"
  ADD CONSTRAINT "lectures_recording_id_fkey"
  FOREIGN KEY ("recording_id") REFERENCES "lecture_recordings"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
