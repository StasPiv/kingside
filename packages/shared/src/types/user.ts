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
};
