-- KS-2214: invalidate stale broadcast_standings cache.
-- broadcast_standings is a pure cache table (rebuilt on next /crosstable request).
-- Truncating forces fresh rebuild, fixing matrix cells overwritten by placeholders.
TRUNCATE TABLE "broadcast_standings";
