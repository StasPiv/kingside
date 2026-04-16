-- CreateIndex
CREATE INDEX "puzzle_rush_scores_time_mode_score_idx" ON "puzzle_rush_scores"("time_mode", "score");

-- CreateIndex
CREATE INDEX "puzzle_rush_scores_user_id_time_mode_idx" ON "puzzle_rush_scores"("user_id", "time_mode");
