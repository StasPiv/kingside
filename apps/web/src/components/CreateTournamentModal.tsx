import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';

interface CreateTournamentModalProps {
  onClose: () => void;
  onCreated: () => void;
}

export function CreateTournamentModal({ onClose, onCreated }: CreateTournamentModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [timeInitial, setTimeInitial] = useState(180);
  const [timeIncrement, setTimeIncrement] = useState(0);
  const [durationMin, setDurationMin] = useState(30);
  const [startsIn, setStartsIn] = useState(5);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const startsAt = new Date(Date.now() + startsIn * 60 * 1000).toISOString();
      await api.post('/api/arena', {
        name: name.trim(),
        timeInitialSec: timeInitial,
        timeIncrementSec: timeIncrement,
        durationMin,
        startsAt,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className="modal-header">
          <h2>{t('tournaments.createTitle', 'Create Tournament')}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="tournament-create-form">
          <div className="import-field">
            <label>{t('tournaments.name', 'Name')}</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('tournaments.namePlaceholder', 'Arena Blitz')} />
          </div>

          <div className="import-field">
            <label>{t('tournaments.timeControl', 'Time control (seconds + increment)')}</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select value={timeInitial} onChange={(e) => setTimeInitial(Number(e.target.value))}>
                <option value={60}>1 min</option>
                <option value={120}>2 min</option>
                <option value={180}>3 min</option>
                <option value={300}>5 min</option>
                <option value={600}>10 min</option>
              </select>
              <select value={timeIncrement} onChange={(e) => setTimeIncrement(Number(e.target.value))}>
                <option value={0}>+0</option>
                <option value={1}>+1</option>
                <option value={2}>+2</option>
                <option value={3}>+3</option>
                <option value={5}>+5</option>
              </select>
            </div>
          </div>

          <div className="import-field">
            <label>{t('tournaments.duration', 'Duration (minutes)')}</label>
            <select value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value))}>
              <option value={15}>15</option>
              <option value={30}>30</option>
              <option value={45}>45</option>
              <option value={60}>60</option>
              <option value={90}>90</option>
            </select>
          </div>

          <div className="import-field">
            <label>{t('tournaments.startsIn', 'Starts in (minutes)')}</label>
            <select value={startsIn} onChange={(e) => setStartsIn(Number(e.target.value))}>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={15}>15</option>
              <option value={30}>30</option>
            </select>
          </div>

          {error && <div className="error">{error}</div>}

          <button className="import-btn" onClick={handleCreate} disabled={creating || !name.trim()} style={{ marginTop: 12 }}>
            {creating ? t('common.loading') : t('tournaments.create', 'Create Tournament')}
          </button>
        </div>
      </div>
    </div>
  );
}
