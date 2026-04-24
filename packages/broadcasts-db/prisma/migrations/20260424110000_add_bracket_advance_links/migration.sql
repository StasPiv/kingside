-- KS-1824: связи пар в playoff-сетке — победитель / проигравший идёт в пару
-- следующего раунда. Заполняется `computeAdvanceLinks(rounds)` в
-- broadcast-service при каждом sync-цикле, когда все раунды броадкаста
-- уже классифицированы.
--
-- `advance_to_pair_id` — пара следующего раунда для победителя этой пары:
--    winners_quarter → winners_semi (тот же индекс среди отсортированных
--    пар следующей стадии), winners_final → grand_final,
--    losers_final → grand_final, grand_final → grand_final_reset (если
--    reset-пара существует).
--
-- `loser_to_pair_id` — для double-elimination: проигравший winners-<stage>
--    идёт в losers-<same stage> с тем же индексом (упрощённая эвристика —
--    Lichess не отдаёт реальную топологию сетки).
--
-- Оба поля nullable: для round-robin / swiss / unknown раундов NULL;
-- для последних стадий без next-раунда — NULL.

ALTER TABLE "broadcast_games" ADD COLUMN "advance_to_pair_id" TEXT;
ALTER TABLE "broadcast_games" ADD COLUMN "loser_to_pair_id" TEXT;
