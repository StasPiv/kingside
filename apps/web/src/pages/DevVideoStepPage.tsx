import { useState } from 'react';
import type { VideoStepPayload } from '@kingside/shared';

import { VideoStep } from '../components/lessons/steps/VideoStep';

/**
 * Dev-песочница для ручной проверки `VideoStep` (KS-1796, L-34).
 *
 * Маршрут не протектед — нужен для снятия скриншотов состояний через
 * Playwright и ручной проверки responsive 16:9 / плейсхолдера на
 * невалидных URL. В живых уроках шаг подключается через StepRenderer.
 */

type Scenario = {
  key: string;
  label: string;
  payload: VideoStepPayload;
};

const SCENARIOS: Scenario[] = [
  {
    key: 'youtube-watch',
    label: 'YouTube: watch?v=…',
    payload: {
      type: 'video',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      titleI18nKey: 'lessons.stepType.video',
    },
  },
  {
    key: 'youtube-short',
    label: 'YouTube: youtu.be',
    payload: {
      type: 'video',
      url: 'https://youtu.be/dQw4w9WgXcQ',
    },
  },
  {
    key: 'vimeo-public',
    label: 'Vimeo: public',
    payload: {
      type: 'video',
      url: 'https://vimeo.com/76979871',
    },
  },
  {
    key: 'vimeo-unlisted',
    label: 'Vimeo: unlisted /ID/HASH',
    payload: {
      type: 'video',
      url: 'https://vimeo.com/76979871/abcdef1234',
    },
  },
  {
    key: 'invalid-domain',
    label: 'Invalid: другой домен',
    payload: {
      type: 'video',
      url: 'https://example.com/watch?v=dQw4w9WgXcQ',
    },
  },
];

export function DevVideoStepPage() {
  const [current, setCurrent] = useState(SCENARIOS[0]);
  const [doneCount, setDoneCount] = useState(0);

  return (
    <div className="dev-video-step-page" style={{ padding: 24, maxWidth: 720 }}>
      <h1 style={{ marginTop: 0 }}>VideoStep — dev sandbox</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        KS-1796 (L-34). Маршрут временный — для снятия скриншотов и ручной
        проверки responsive-обёртки 16:9 / плейсхолдера на невалидных URL.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {SCENARIOS.map((s) => (
          <button
            key={s.key}
            type="button"
            data-testid={`dev-video-scenario-${s.key}`}
            onClick={() => setCurrent(s)}
            disabled={current.key === s.key}
            style={{ padding: '6px 10px' }}
          >
            {s.label}
          </button>
        ))}
      </div>

      <VideoStep
        key={current.key}
        payload={current.payload}
        onStepDone={() => setDoneCount((n) => n + 1)}
      />

      <p
        data-testid="dev-video-done-count"
        style={{ marginTop: 16, color: '#666', fontSize: 13 }}
      >
        onStepDone callbacks: {doneCount}
      </p>
    </div>
  );
}
