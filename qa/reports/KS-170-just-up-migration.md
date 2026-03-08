# KS-170: QA Report - just up after daily_puzzles migration fix

Date: 2026-03-08

## Test Results

### 1. Clean DB (no volume) - PASS
- `docker compose down -v` to remove all volumes
- `just up` executed successfully
- All 5 migrations applied in order:
  - 20260307095936_init
  - 20260307133640_add_user_locale
  - 20260307153117_add_missing_models
  - 20260307210000_add_bot_fields_and_user_time_controls
  - 20260308140000_add_daily_puzzle

### 2. Existing DB (idempotency) - PASS
- `npx prisma migrate deploy` on already-migrated DB
- Output: "No pending migrations to apply"

### 3. Application startup - PASS
- Nest application started on port 3001
- All modules initialized without errors

### 4. daily_puzzles table structure - PASS
- Table created with correct columns: id (UUID), puzzle_id (TEXT), date (DATE), created_at (TIMESTAMP)
- PK: daily_puzzles_pkey (id)
- Unique index: daily_puzzles_date_key (date)
- FK: daily_puzzles_puzzle_id_fkey -> puzzles(id) ON DELETE RESTRICT ON UPDATE CASCADE
- FK types match: puzzle_id (TEXT) -> puzzles.id (TEXT)
