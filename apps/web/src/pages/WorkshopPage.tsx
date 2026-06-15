import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { WorkshopAnalysisList } from '../components/workshop/WorkshopAnalysisList';
import { WorkshopPgnList } from '../components/workshop/WorkshopPgnList';
import type { PgnFile } from '../components/workshop/WorkshopPgnList';
import { HelpButton } from '../components/HelpButton';
import { useAuth } from '../context/AuthContext';
import { guestWorkshopStore } from '../utils/guestWorkshopStore';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

type Section = 'myAnalyses' | 'pgnFiles';

export function WorkshopPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const params = useParams<{ fileId?: string }>();
  const location = useLocation();
  const { user } = useAuth();
  const isGuest = !user;

  const isPgnFilesSection = location.pathname.startsWith('/workshop/pgn-files');
  const section: Section = isPgnFilesSection ? 'pgnFiles' : 'myAnalyses';
  const fileId = params.fileId;

  const stateFile = (location.state as { file?: PgnFile } | null)?.file ?? null;
  const [resolvedFile, setResolvedFile] = useState<PgnFile | null>(stateFile);
  const [fileLoading, setFileLoading] = useState(Boolean(fileId && !stateFile));

  useEffect(() => {
    setResolvedFile(stateFile);
    if (fileId && !stateFile) {
      setFileLoading(true);

      // KS-4166: гостю серверный список не дёргаем — ищем файл в
      // локальном `guestWorkshopStore`.
      if (isGuest) {
        const found = guestWorkshopStore.listFiles().find((f) => f.id === fileId);
        if (found) {
          setResolvedFile(found);
        } else {
          navigate('/workshop/pgn-files', { replace: true });
        }
        setFileLoading(false);
        return;
      }

      const token = localStorage.getItem('token');
      fetch(`${API_URL}/workshop/pgn-files`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
        .then((res) => {
          if (!res.ok) throw new Error();
          return res.json();
        })
        .then((data) => {
          const raw: any[] = data.data ?? data;
          const files: PgnFile[] = raw.map((item) => ({
            id: item.id,
            name: item.fileName ?? item.name,
            gameCount: item.gamesCount ?? item.gameCount,
            uploadedAt: item.createdAt ?? item.uploadedAt,
          }));
          const found = files.find((f) => f.id === fileId);
          if (found) {
            setResolvedFile(found);
          } else {
            navigate('/workshop/pgn-files', { replace: true });
          }
        })
        .catch(() => navigate('/workshop/pgn-files', { replace: true }))
        .finally(() => setFileLoading(false));
    } else if (!fileId) {
      setResolvedFile(null);
      setFileLoading(false);
    }
  }, [fileId, stateFile, navigate, isGuest]);

  const handleSectionChange = useCallback(
    (newSection: Section) => {
      if (newSection === 'myAnalyses') {
        navigate('/workshop');
      } else {
        navigate('/workshop/pgn-files');
      }
    },
    [navigate],
  );

  const handleSelectFile = useCallback(
    (file: PgnFile) => {
      navigate(`/workshop/pgn-files/${file.id}`, { state: { file } });
    },
    [navigate],
  );

  const handleBackToFiles = useCallback(() => {
    navigate('/workshop/pgn-files');
  }, [navigate]);

  const handleBackToWorkshop = useCallback(() => {
    navigate('/workshop');
  }, [navigate]);

  return (
    <div className="workshop-page">
      <nav className="workshop-breadcrumbs">
        <button
          className="workshop-breadcrumbs__link"
          onClick={handleBackToWorkshop}
        >
          {t('workshop.title')}
        </button>
        <HelpButton section="workshop" />
        <span className="workshop-breadcrumbs__sep"> / </span>
        {section === 'myAnalyses' ? (
          <span className="workshop-breadcrumbs__current">
            {t('workshop.myAnalyses.title')}
          </span>
        ) : resolvedFile ? (
          <>
            <button
              className="workshop-breadcrumbs__link"
              onClick={handleBackToFiles}
            >
              {t('workshop.pgnFiles.title')}
            </button>
            <span className="workshop-breadcrumbs__sep"> / </span>
            <span className="workshop-breadcrumbs__current">{resolvedFile.name}</span>
          </>
        ) : (
          <span className="workshop-breadcrumbs__current">
            {t('workshop.pgnFiles.title')}
          </span>
        )}
      </nav>

      <div className="workshop-section-tabs">
        <button
          className={`workshop-section-tab${section === 'myAnalyses' ? ' active' : ''}`}
          onClick={() => handleSectionChange('myAnalyses')}
        >
          {t('workshop.myAnalyses.title')}
        </button>
        <button
          className={`workshop-section-tab${section === 'pgnFiles' ? ' active' : ''}`}
          onClick={() => handleSectionChange('pgnFiles')}
        >
          {t('workshop.pgnFiles.title')}
        </button>
      </div>

      <div className="workshop-page__content">
        {section === 'myAnalyses' && (
          <WorkshopAnalysisList />
        )}
        {section === 'pgnFiles' && (
          fileLoading ? (
            <p className="workshop-section-block__loading">{t('common.loading')}</p>
          ) : (
            <WorkshopPgnList
              selectedFile={resolvedFile}
              onSelectFile={handleSelectFile}
            />
          )
        )}
      </div>
    </div>
  );
}
