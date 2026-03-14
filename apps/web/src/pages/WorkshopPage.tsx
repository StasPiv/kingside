import { useTranslation } from 'react-i18next';
import { WorkshopAnalysisList } from '../components/workshop/WorkshopAnalysisList';
import { WorkshopPgnUpload } from '../components/workshop/WorkshopPgnUpload';

export function WorkshopPage() {
  const { t } = useTranslation();

  return (
    <div className="workshop-page">
      <h1 className="workshop-page__title">{t('workshop.title')}</h1>

      <div className="workshop-page__content">
        <WorkshopPgnUpload />
        <WorkshopAnalysisList />
      </div>
    </div>
  );
}
