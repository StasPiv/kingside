export type Locale = 'en' | 'ru';

export type User = {
  id: string;
  username: string;
  rating: number;
  createdAt: string;
  locale?: Locale;
};
