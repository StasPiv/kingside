-- KS-4311: пользовательский флаг отображения отладочной панели
-- шахматного движка. Хранится в users рядом с остальными UI-настройками
-- (locale/board_theme/piece_set/sound_enabled). По умолчанию false.
ALTER TABLE "users"
  ADD COLUMN "show_bot_engine_debug_panel" BOOLEAN NOT NULL DEFAULT false;
