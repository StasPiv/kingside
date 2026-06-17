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
};
