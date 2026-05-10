-- KS-2698: проверка acceptance — сколько в archive_games partией удовлетворяют
-- условиям puzzle-generator (classical, оба игрока Elo>=2400).
SELECT
  COUNT(*) FILTER (WHERE white_elo >= 2400 AND black_elo >= 2400 AND time_control_category = 'classical') AS strong_classical,
  COUNT(*) FILTER (WHERE white_elo >= 2400 AND black_elo >= 2400) AS strong_any,
  COUNT(*) FILTER (WHERE time_control_category = 'classical') AS classical_total,
  COUNT(*) AS total
FROM archive_games;
