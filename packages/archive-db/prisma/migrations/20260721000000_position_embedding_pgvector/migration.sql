-- ADR-169 §2.2 / KS-4993: векторный индекс похожести позиций.
-- Второй индекс над корпусом позиций (первый — точный по FEN,
-- archive_game_positions). Эмбеддинг из глубокого слоя трансформерной сети
-- Lc0 (ADR-168 §9), d_model=256, метрика — косинус.

-- pgvector включён devops (KS-4992); IF NOT EXISTS — идемпотентная страховка.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "position_embedding" (
    "id" UUID NOT NULL,
    "position_key" BYTEA NOT NULL,
    "fen" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'master',
    "game_ref" TEXT,
    "ply" SMALLINT,
    "side_to_move" CHAR(1) NOT NULL,
    "embedding" vector(256) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "position_embedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "position_embedding_position_key_idx" ON "position_embedding"("position_key");
CREATE INDEX "position_embedding_source_idx" ON "position_embedding"("source");

-- ANN-индекс приближённых соседей по косинусу (pgvector HNSW).
-- HNSW: без обучения (в отличие от IVFFlat), стабильный recall на растущем
-- корпусе 50–200k (ADR-169 §2.1/§3). m/ef_construction — дефолты pgvector.
-- Запрос: ORDER BY embedding <=> $query LIMIT 5 (оператор косинуса <=>).
CREATE INDEX "position_embedding_embedding_cosine_idx"
    ON "position_embedding" USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
