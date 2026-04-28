import { useTranslation } from 'react-i18next';

/**
 * KS-2066 (F0): заглушка лобби архива партий.
 *
 * Полное наполнение — F1 (KS-2067): hero, поиск игроков/событий, недавние
 * мастер-партии, CTA «искать по позиции» и «загрузить свои PGN».
 *
 * Маршрут: `/archive`. Layout — общий `MainLayout` (роут вложен в него
 * в `App.tsx`).
 */
export function ArchiveLobbyPage() {
  const { t } = useTranslation('archive');
  return (
    <div className="archive-page archive-lobby-page" data-testid="archive-lobby-page">
      <h1>{t('lobby.title', 'Game Archive')}</h1>
      <p>{t('lobby.placeholder', 'TODO: F1 — archive lobby (search, recent games)')}</p>
    </div>
  );
}
