export type Locale = 'en' | 'ru';

export type User = {
  id: string;
  username: string;
  email: string;
  ratingBullet: number;
  ratingBlitz: number;
  ratingRapid: number;
  ratingClassical: number;
  ratingPuzzle?: number;
  createdAt: string;
  locale?: Locale;
  boardTheme?: 'default' | 'green' | 'blue' | 'brown';
  pieceSet?: 'standard' | 'neo' | 'alpha' | 'cburnett';
  soundEnabled?: boolean;
  /** KS-4311. Отображать ли отладочную панель шахматного движка. */
  showBotEngineDebugPanel?: boolean;
  /**
   * KS-4724 / ADR-147 §6.2. Согласие пользователя на трекинг analytics-
   * событий. Default false (миграция KS-4695). Возвращается из
   * `GET /auth/me` и `PATCH /me/consent`. Используется на фронте
   * для гейта cookie-banner и `EventsBootstrap.isConsented()`.
   */
  analyticsConsent?: boolean;
};
