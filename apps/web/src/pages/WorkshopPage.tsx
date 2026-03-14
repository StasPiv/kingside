import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

export function WorkshopPage() {
  const { t } = useTranslation();

  return (
    <div className="workshop-page">
      <h1>{t('workshop.title')}</h1>
      <p className="workshop-page__desc">{t('workshop.comingSoon')}</p>
      <Link to="/lobby" className="lobby-widget__btn">
        {t('workshop.backToLobby')}
      </Link>
    </div>
  );
}
