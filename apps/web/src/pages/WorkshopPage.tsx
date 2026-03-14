import { useTranslation } from 'react-i18next';
import { WorkshopNewGame } from '../components/workshop/WorkshopNewGame';
import { WorkshopMyGames } from '../components/workshop/WorkshopMyGames';
import { WorkshopTournaments } from '../components/workshop/WorkshopTournaments';
import { WorkshopPgnUpload } from '../components/workshop/WorkshopPgnUpload';
import { WorkshopAnalysisList } from '../components/workshop/WorkshopAnalysisList';

export function WorkshopPage() {
  const { t } = useTranslation();

  return (
    <div className="workshop-page">
      <h1 className="workshop-page__title">{t('workshop.title')}</h1>

      <div className="workshop-page__content">
        <WorkshopPgnUpload />
        <WorkshopAnalysisList />
        <WorkshopNewGame />
        <WorkshopMyGames />
        <WorkshopTournaments />
      </div>
    </div>
  );
}
