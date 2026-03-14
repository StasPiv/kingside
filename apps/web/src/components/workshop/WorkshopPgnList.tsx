import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

export interface PgnFile {
  id: string;
  name: string;
  gameCount: number;
  uploadedAt: string;
}

interface PgnFileGame {
  index: number;
  white: string;
  black: string;
  result: string;
  date: string | null;
  pgn: string;
}

interface WorkshopPgnListProps {
  selectedFile: PgnFile | null;
  onSelectFile: (file: PgnFile) => void;
}

export function WorkshopPgnList({ selectedFile, onSelectFile }: WorkshopPgnListProps) {
  if (selectedFile) {
    return <PgnFileGames file={selectedFile} />;
  }
  return <PgnFilesList onSelectFile={onSelectFile} />;
}

function PgnFilesList({ onSelectFile }: { onSelectFile: (file: PgnFile) => void }) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<PgnFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/workshop/pgn-files`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const raw: any[] = data.data ?? data;
      setFiles(raw.map((item) => ({
        id: item.id,
        name: item.fileName ?? item.name,
        gameCount: item.gamesCount ?? item.gameCount,
        uploadedAt: item.createdAt ?? item.uploadedAt,
      })));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setUploading(true);
    setUploadError('');
    try {
      const token = localStorage.getItem('token');
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${API_URL}/api/workshop/pgn-files`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      if (!res.ok) throw new Error();
      await loadFiles();
    } catch {
      setUploadError(t('workshop.pgnFiles.uploadError'));
    } finally {
      setUploading(false);
    }
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  return (
    <section className="workshop-section-block">
      <div className="workshop-section-block__header">
        <h2 className="workshop-section-block__title">{t('workshop.pgnFiles.title')}</h2>
        <input
          ref={inputRef}
          type="file"
          accept=".pgn"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
        <button
          className="workshop-pgn-upload__btn"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? t('workshop.pgnFiles.uploading') : t('workshop.pgnFiles.uploadButton')}
        </button>
      </div>

      {uploadError && (
        <p className="workshop-section-block__error">{uploadError}</p>
      )}

      {loading && (
        <p className="workshop-section-block__loading">{t('common.loading')}</p>
      )}

      {error && !loading && (
        <p className="workshop-section-block__error">{t('workshop.pgnFiles.error')}</p>
      )}

      {!loading && !error && files.length === 0 && (
        <p className="workshop-section-block__empty">{t('workshop.pgnFiles.empty')}</p>
      )}

      {!loading && !error && files.length > 0 && (
        <div className="workshop-pgn-files-list">
          {files.map((file) => (
            <div
              key={file.id}
              className="workshop-pgn-file-item"
              onClick={() => onSelectFile(file)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && onSelectFile(file)}
            >
              <span className="workshop-pgn-file-item__name">{file.name}</span>
              <div className="workshop-pgn-file-item__meta">
                <span className="workshop-pgn-file-item__games">
                  {t('workshop.pgnFiles.gameCount', { count: file.gameCount })}
                </span>
                <span className="workshop-pgn-file-item__date">{formatDate(file.uploadedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PgnFileGames({ file }: { file: PgnFile }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [games, setGames] = useState<PgnFileGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    const token = localStorage.getItem('token');
    fetch(`${API_URL}/api/workshop/pgn-files/${file.id}/games`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then((data) => {
        if (!cancelled) {
          setGames(data.data ?? data);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [file.id]);

  const handleOpenGame = (game: PgnFileGame) => {
    navigate('/analysis', {
      state: {
        pgn: game.pgn,
        title: `${game.white} vs ${game.black}`,
        breadcrumbSection: t('workshop.pgnFiles.title'),
        breadcrumbBackUrl: '/workshop/pgn-files',
        breadcrumbFileName: file.name,
        breadcrumbFileBackUrl: `/workshop/pgn-files/${file.id}`,
        breadcrumbFileBackState: { file },
      },
    });
  };

  return (
    <section className="workshop-section-block">
      <h2 className="workshop-section-block__title">
        {file.name}
      </h2>

      {loading && (
        <p className="workshop-section-block__loading">{t('common.loading')}</p>
      )}

      {error && !loading && (
        <p className="workshop-section-block__error">{t('workshop.pgnFiles.gamesError')}</p>
      )}

      {!loading && !error && games.length === 0 && (
        <p className="workshop-section-block__empty">{t('workshop.pgnFiles.gamesEmpty')}</p>
      )}

      {!loading && !error && games.length > 0 && (
        <div className="workshop-pgn-games-list">
          {games.map((game) => (
            <div
              key={game.index}
              className="workshop-pgn-game-item"
              onClick={() => handleOpenGame(game)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && handleOpenGame(game)}
            >
              <span className="workshop-pgn-game-item__players">
                {game.white} vs {game.black}
              </span>
              <div className="workshop-pgn-game-item__meta">
                <span className="workshop-pgn-game-item__result">{game.result}</span>
                {game.date && (
                  <span className="workshop-pgn-game-item__date">{game.date}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
