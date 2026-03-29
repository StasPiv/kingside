import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { ImportExternalModal } from './ImportExternalModal';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface PgnFile {
  id: string;
  name: string;
  gameCount: number;
  uploadedAt: string;
}

interface PgnFileGame {
  id: string;
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [importSource, setImportSource] = useState<'chesscom' | 'lichess' | null>(null);
  const [externalAccounts, setExternalAccounts] = useState<{ chesscomUsername?: string; lichessUsername?: string }>({});

  useEffect(() => {
    api.get<{ chesscomUsername?: string; lichessUsername?: string }>('/api/users/me/settings')
      .then(setExternalAccounts)
      .catch(() => {});
  }, []);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`${API_URL}/api/workshop/pgn-files`, { headers: authHeaders() });
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

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploading(true);
    setUploadError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${API_URL}/api/workshop/pgn-files`, {
        method: 'POST',
        headers: authHeaders(),
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

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(t('workshop.pgnFiles.confirmDelete', 'Delete this PGN file?'))) return;
    try {
      await fetch(`${API_URL}/api/workshop/pgn-files/${id}`, { method: 'DELETE', headers: authHeaders() });
      setFiles((prev) => prev.filter((f) => f.id !== id));
    } catch { /* ignore */ }
  };

  const startRename = (file: PgnFile, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(file.id);
    setEditName(file.name);
  };

  const handleRename = async (id: string) => {
    if (!editName.trim()) { setEditingId(null); return; }
    try {
      await fetch(`${API_URL}/api/workshop/pgn-files/${id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: editName.trim() }),
      });
      setFiles((prev) => prev.map((f) => f.id === id ? { ...f, name: editName.trim() } : f));
    } catch { /* ignore */ }
    setEditingId(null);
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  return (
    <section className="workshop-section-block">
      <div className="workshop-section-block__header">
        <input ref={inputRef} type="file" accept=".pgn" style={{ display: 'none' }} onChange={handleFileChange} />
        <button className="workshop-pgn-upload__btn" onClick={() => inputRef.current?.click()} disabled={uploading}>
          {uploading ? t('workshop.pgnFiles.uploading') : t('workshop.pgnFiles.uploadButton')}
        </button>
        {externalAccounts.chesscomUsername && (
          <button className="workshop-import-btn" onClick={() => setImportSource('chesscom')}>
            {t('workshop.import.fromChesscom', 'Import chess.com')}
          </button>
        )}
        {externalAccounts.lichessUsername && (
          <button className="workshop-import-btn" onClick={() => setImportSource('lichess')}>
            {t('workshop.import.fromLichess', 'Import lichess')}
          </button>
        )}
      </div>

      {uploadError && <p className="workshop-section-block__error">{uploadError}</p>}
      {loading && <p className="workshop-section-block__loading">{t('common.loading')}</p>}
      {error && !loading && <p className="workshop-section-block__error">{t('workshop.pgnFiles.error')}</p>}
      {!loading && !error && files.length === 0 && <p className="workshop-section-block__empty">{t('workshop.pgnFiles.empty')}</p>}

      {!loading && !error && files.length > 0 && (
        <div className="workshop-pgn-files-list">
          {files.map((file) => (
            <div
              key={file.id}
              className="workshop-pgn-file-item"
              onClick={() => editingId !== file.id && onSelectFile(file)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && editingId !== file.id && onSelectFile(file)}
            >
              {editingId === file.id ? (
                <input
                  className="workshop-pgn-file-item__edit"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRename(file.id);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  onBlur={() => handleRename(file.id)}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="workshop-pgn-file-item__name">{file.name}</span>
              )}
              <div className="workshop-pgn-file-item__meta">
                <span className="workshop-pgn-file-item__games">
                  {t('workshop.pgnFiles.gameCount', { count: file.gameCount })}
                </span>
                <span className="workshop-pgn-file-item__date">{formatDate(file.uploadedAt)}</span>
                <button className="workshop-pgn-file-item__action" onClick={(e) => startRename(file, e)} title="Rename">✎</button>
                <button className="workshop-pgn-file-item__action workshop-pgn-file-item__action--delete" onClick={(e) => handleDelete(file.id, e)} title="Delete">×</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {importSource && (
        <ImportExternalModal
          source={importSource}
          onClose={() => setImportSource(null)}
          onImported={() => { loadFiles(); }}
        />
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
  const [editingName, setEditingName] = useState(false);
  const [fileName, setFileName] = useState(file.name);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    fetch(`${API_URL}/api/workshop/pgn-files/${file.id}/games`, { headers: authHeaders() })
      .then((res) => { if (!res.ok) throw new Error(); return res.json(); })
      .then((data) => { if (!cancelled) setGames(data.data ?? data); })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [file.id]);

  const handleOpenGame = (game: PgnFileGame) => {
    navigate('/analysis', {
      state: {
        pgn: game.pgn,
        title: `${game.white} vs ${game.black}`,
        breadcrumbSection: t('workshop.pgnFiles.title'),
        breadcrumbBackUrl: '/workshop/pgn-files',
        breadcrumbFileName: fileName,
        breadcrumbFileBackUrl: `/workshop/pgn-files/${file.id}`,
        breadcrumbFileBackState: { file: { ...file, name: fileName } },
      },
    });
  };

  const handleDeleteFile = async () => {
    if (!confirm(t('workshop.pgnFiles.confirmDelete', 'Delete this PGN file?'))) return;
    try {
      await fetch(`${API_URL}/api/workshop/pgn-files/${file.id}`, { method: 'DELETE', headers: authHeaders() });
      navigate('/workshop/pgn-files');
    } catch { /* ignore */ }
  };

  const handleRenameFile = async () => {
    if (!fileName.trim()) { setEditingName(false); return; }
    try {
      await fetch(`${API_URL}/api/workshop/pgn-files/${file.id}`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: fileName.trim() }),
      });
    } catch { /* ignore */ }
    setEditingName(false);
  };

  const handleDeleteGame = async (gameId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(t('workshop.pgnFiles.confirmDeleteGame', 'Delete this game?'))) return;
    try {
      await fetch(`${API_URL}/api/workshop/pgn-files/${file.id}/games/${gameId}`, { method: 'DELETE', headers: authHeaders() });
      setGames((prev) => prev.filter((g) => g.id !== gameId));
    } catch { /* ignore */ }
  };

  return (
    <section className="workshop-section-block">
      <div className="workshop-pgn-games-header">
        {editingName ? (
          <input
            className="workshop-pgn-file-item__edit"
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameFile();
              if (e.key === 'Escape') { setFileName(file.name); setEditingName(false); }
            }}
            onBlur={handleRenameFile}
            autoFocus
          />
        ) : (
          <h2 className="workshop-section-block__title">
            {fileName}
            <button className="workshop-pgn-file-item__action" onClick={() => setEditingName(true)} title="Rename">✎</button>
          </h2>
        )}
        <button className="puzzle-delete-all-btn" onClick={handleDeleteFile}>
          {t('workshop.pgnFiles.deleteFile', 'Delete file')}
        </button>
      </div>

      {loading && <p className="workshop-section-block__loading">{t('common.loading')}</p>}
      {error && !loading && <p className="workshop-section-block__error">{t('workshop.pgnFiles.gamesError')}</p>}
      {!loading && !error && games.length === 0 && <p className="workshop-section-block__empty">{t('workshop.pgnFiles.gamesEmpty')}</p>}

      {!loading && !error && games.length > 0 && (
        <div className="workshop-pgn-games-list">
          {games.map((game) => (
            <div
              key={game.id ?? game.index}
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
                {game.date && <span className="workshop-pgn-game-item__date">{game.date}</span>}
                <button
                  className="workshop-pgn-file-item__action workshop-pgn-file-item__action--delete"
                  onClick={(e) => handleDeleteGame(game.id, e)}
                  title="Delete"
                >×</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
