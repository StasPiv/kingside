import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { PRESETS } from '../hooks/useTimeControl';

interface CreateTournamentModalProps {
  onClose: () => void;
  onCreated: () => void;
}

type TournamentType = 'arena' | 'swiss' | 'round_robin';
type TcCategory = 'bullet' | 'blitz' | 'rapid' | 'custom';

const TYPE_ICONS: Record<TournamentType, string> = { arena: '⚔️', swiss: '🏆', round_robin: '🔄' };
const TC_CATEGORIES: TcCategory[] = ['bullet', 'blitz', 'rapid', 'custom'];

// Filter out classical and ultra-bullet for tournaments
const TOURNAMENT_PRESETS = PRESETS.filter((p) =>
  ['bullet', 'blitz', 'rapid'].includes(p.category) && p.minutes >= 1,
);

export function CreateTournamentModal({ onClose, onCreated }: CreateTournamentModalProps) {
  const { t } = useTranslation();
  const [type, setType] = useState<TournamentType>('arena');
  const [name, setName] = useState('');
  const [tcCategory, setTcCategory] = useState<TcCategory>('blitz');
  const [timeInitial, setTimeInitial] = useState(180);
  const [timeIncrement, setTimeIncrement] = useState(0);
  const [customMinutes, setCustomMinutes] = useState(7);
  const [customIncrement, setCustomIncrement] = useState(3);
  const [durationMin, setDurationMin] = useState(30);
  const [totalRounds, setTotalRounds] = useState(5);
  const [roundPauseMin, setRoundPauseMin] = useState(2);
  const [startsIn, setStartsIn] = useState(5);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveInitial = tcCategory === 'custom' ? customMinutes * 60 : timeInitial;
  const effectiveIncrement = tcCategory === 'custom' ? customIncrement : timeIncrement;

  const handleSelectPreset = (minutes: number, increment: number) => {
    setTimeInitial(minutes * 60);
    setTimeIncrement(increment);
  };

  const isPresetSelected = (minutes: number, increment: number) =>
    timeInitial === minutes * 60 && timeIncrement === increment;

  const filteredPresets = TOURNAMENT_PRESETS.filter((p) => p.category === tcCategory);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const startsAt = new Date(Date.now() + startsIn * 60 * 1000).toISOString();
      await api.post('/api/arena', {
        name: name.trim(),
        type,
        timeInitialSec: effectiveInitial,
        timeIncrementSec: effectiveIncrement,
        durationMin,
        ...(type !== 'arena' ? { totalRounds, roundPauseMin } : {}),
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
      <div className="tcm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('tournaments.createTitle', 'Create Tournament')}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="tcm-body">
          {/* Left: type cards */}
          <div className="tcm-types">
            {(['arena', 'swiss', 'round_robin'] as const).map((tp) => (
              <div
                key={tp}
                className={`tcm-type-card${type === tp ? ' tcm-type-card--active' : ''}`}
                onClick={() => setType(tp)}
              >
                <span className="tcm-type-card__icon">{TYPE_ICONS[tp]}</span>
                <span className="tcm-type-card__name">{t(`tournaments.type_${tp}`)}</span>
                <span className="tcm-type-card__desc">{t(`tournaments.typeDesc_${tp}`)}</span>
              </div>
            ))}
          </div>

          {/* Right: settings */}
          <div className="tcm-settings">
            <div className="tcm-field">
              <label>{t('tournaments.name', 'Name')}</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('tournaments.namePlaceholder', 'Arena Blitz')} />
            </div>

            {/* TC categories */}
            <div className="tcm-field">
              <label>{t('tournaments.timeControl', 'Time control')}</label>
              <div className="tcm-tc-cats">
                {TC_CATEGORIES.map((cat) => (
                  <button
                    key={cat}
                    className={`tcm-tc-cat${tcCategory === cat ? ' active' : ''}`}
                    onClick={() => setTcCategory(cat)}
                  >
                    {cat === 'custom' ? t('tournaments.custom', 'Custom') : t(`lobby.categories.${cat}`, cat)}
                  </button>
                ))}
              </div>

              {/* Presets */}
              {tcCategory !== 'custom' && (
                <div className="tcm-presets">
                  {filteredPresets.map((p) => {
                    const label = p.increment > 0 ? `${p.minutes}+${p.increment}` : `${p.minutes} min`;
                    return (
                      <button
                        key={`${p.minutes}_${p.increment}`}
                        className={`tcm-preset${isPresetSelected(p.minutes, p.increment) ? ' active' : ''}`}
                        onClick={() => handleSelectPreset(p.minutes, p.increment)}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Custom sliders */}
              {tcCategory === 'custom' && (
                <div className="tcm-custom">
                  <div className="tcm-slider-row">
                    <input type="range" min={1} max={60} value={customMinutes} onChange={(e) => setCustomMinutes(Number(e.target.value))} />
                    <span className="tcm-slider-val">{customMinutes} min</span>
                  </div>
                  <div className="tcm-slider-row">
                    <input type="range" min={0} max={30} value={customIncrement} onChange={(e) => setCustomIncrement(Number(e.target.value))} />
                    <span className="tcm-slider-val">+{customIncrement} sec</span>
                  </div>
                </div>
              )}
            </div>

            {type === 'arena' && (
              <div className="tcm-field">
                <label>{t('tournaments.duration', 'Duration (minutes)')}</label>
                <select className="ks-select" value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value))}>
                  <option value={15}>15</option>
                  <option value={30}>30</option>
                  <option value={45}>45</option>
                  <option value={60}>60</option>
                  <option value={90}>90</option>
                </select>
              </div>
            )}

            {type !== 'arena' && (
              <>
                <div className="tcm-field">
                  <label>{t('tournaments.totalRounds', 'Number of rounds')}</label>
                  <input type="number" min={2} max={15} value={totalRounds} onChange={(e) => setTotalRounds(Number(e.target.value))} />
                </div>
                <div className="tcm-field">
                  <label>{t('tournaments.roundPause', 'Pause between rounds (min)')}</label>
                  <input type="number" min={1} max={30} value={roundPauseMin} onChange={(e) => setRoundPauseMin(Number(e.target.value))} />
                </div>
              </>
            )}

            <div className="tcm-field">
              <label>{t('tournaments.startsIn', 'Starts in (minutes)')}</label>
              <select className="ks-select" value={startsIn} onChange={(e) => setStartsIn(Number(e.target.value))}>
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={5}>5</option>
                <option value={10}>10</option>
                <option value={15}>15</option>
                <option value={30}>30</option>
              </select>
            </div>

            {error && <div className="error">{error}</div>}

            <button className="tcm-submit" onClick={handleCreate} disabled={creating || !name.trim()}>
              {creating ? t('common.loading') : t('tournaments.create', 'Create Tournament')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
