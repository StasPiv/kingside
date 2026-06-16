/**
 * KS-3273 (ADR-077 §2.8 #4) + KS-3274 (UX polish): сессия Opening
 * Trainer — доска + бот + контролы.
 *
 * KS-4277: страница — тонкая обёртка над `<OpeningTrainerPlayer>`.
 * Серверная логика (`POST /move`, `/hint`, `/undo`, `/giveup`,
 * `/finish`) инкапсулирована в `ServerSessionAdapter`. Здесь только
 * chrome: чтение `:id`/`:sid` из URL, передача initial-сессии из
 * `location.state`, навигация на `/result`.
 */
import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ServerSessionAdapter } from './adapters/ServerSessionAdapter';
import { OpeningTrainerPlayer } from './OpeningTrainerPlayer';
import type {
  OpeningTrainerSessionDto,
  StartOpeningTrainerSessionResponse,
} from '@kingside/shared';

interface LocationState {
  initialBotMove?: StartOpeningTrainerSessionResponse['initialBotMove'];
  session?: OpeningTrainerSessionDto;
}

export function OpeningTrainerSessionPage() {
  const { t } = useTranslation();
  const { id, sid } = useParams<{ id: string; sid: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const incoming = (location.state as LocationState | null) ?? null;

  const adapter = useMemo(() => {
    if (!id || !sid) return null;
    return new ServerSessionAdapter(id, sid, {
      initialSession: incoming?.session,
    });
    // KS-4277: пересоздаём адаптер при смене :id/:sid. `incoming.session`
    // зависит от location.state, который тоже привязан к URL — этого
    // достаточно как ключа для useMemo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, sid]);

  // Если сессия уже finished (например, пользователь зашёл на старую
  // ссылку), сразу редиректим на /result.
  useEffect(() => {
    if (!adapter || !id || !sid) return;
    if (incoming?.session?.status === 'finished') {
      navigate(`/opening-trainer/${id}/session/${sid}/result`, {
        replace: true,
      });
    }
  }, [adapter, id, sid, incoming?.session?.status, navigate]);

  if (!adapter) {
    return (
      <div className="error" data-testid="opening-trainer-session-error">
        {t(
          'openingTrainer.errors.invalidRoute',
          'Invalid session URL',
        )}
      </div>
    );
  }

  return (
    <OpeningTrainerPlayer
      adapter={adapter}
      rootTestId="opening-trainer-session"
      onSessionFinished={(resultRoute) =>
        navigate(resultRoute, { replace: true })
      }
    />
  );
}
