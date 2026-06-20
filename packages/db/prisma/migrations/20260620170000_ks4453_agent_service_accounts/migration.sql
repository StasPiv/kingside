-- KS-4453 / ADR-139. Сервисные аккаунты для machine-to-machine API:
-- автономные агенты (backend, content, qa и т. п.) аутентифицируются
-- через Bearer-токен, сверяемый с `token_hash` (sha256). Plain-токен
-- виден только при выдаче через админ-CLI (T4 ADR-139), в БД не
-- хранится. Уникальность гарантирована handle'ом; токен можно ротировать
-- без смены handle. Индекс по `token_hash` для O(log n)-lookup
-- на каждом запросе.

-- CreateTable
CREATE TABLE "agent_service_accounts" (
    "id" UUID NOT NULL,
    "handle" TEXT NOT NULL,
    "description" TEXT,
    "token_hash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "agent_service_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_service_accounts_handle_key" ON "agent_service_accounts"("handle");

-- CreateIndex
CREATE INDEX "agent_service_accounts_token_hash_idx" ON "agent_service_accounts"("token_hash");
