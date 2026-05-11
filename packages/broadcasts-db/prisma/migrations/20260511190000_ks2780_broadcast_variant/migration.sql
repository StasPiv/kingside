-- KS-2780. variant из PGN-header [Variant "..."] (Chess960, etc).
-- null = standard. API фильтрует non-null.
ALTER TABLE "broadcasts" ADD COLUMN "variant" TEXT;
CREATE INDEX "broadcasts_variant_idx" ON "broadcasts" ("variant");
