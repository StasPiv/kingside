/**
 * KS-4628 / ADR-142 §2.6. REST-клиент `POST /live-analyses/:slug/switch-analysis`
 * для UI тренера. Используется компонентом `LectureAnalysisSwitcher`
 * для смены активного окна анализа в идущей лекции.
 *
 * Контракт типов — `SwitchAnalysisRequest` / `SwitchAnalysisResponse`
 * из `@kingside/shared`. Гарды на стороне backend проверяют:
 *   - что текущий пользователь — owner трансляции;
 *   - что `analysisId` принадлежит тому же пользователю;
 *   - размер `tree` ≤ 256 KB.
 *
 * Ошибки:
 *   - 401 — токен истёк; пробрасываем как `LiveAnalysisApiError` с
 *     кодом 'unauthorized', родитель решает что показать.
 *   - 403 — `forbidden_analysis` / `forbidden_slug`.
 *   - 400 — `tree_too_large` / `invalid_payload`.
 *   - 404 — slug не найден / трансляция уже закрыта.
 *   - 5xx — серверная ошибка; код 'server_error'.
 *
 * Все эти случаи отдаются единым `LiveAnalysisApiError`, чтобы UI
 * мог в одном месте показать toast с локализованным сообщением.
 */
import type {
  SwitchAnalysisRequest,
  SwitchAnalysisResponse,
} from '@kingside/shared';

export class LiveAnalysisApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number, message?: string) {
    super(message ?? code);
    this.name = 'LiveAnalysisApiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * KS-4635: тот же fallback, что в общем `apps/web/src/api.ts`
 * (`http://localhost:3001` — порт NestJS dev-сервера). Раньше fallback
 * был `window.location.origin`, и на локальном dev запрос уходил на
 * `http://localhost:5173/...` — vite отвечал 404 пустым телом. На
 * проде разницы не было (same-origin), поэтому отловилось только сейчас.
 */
function getApiUrl(): string {
  return import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
}

function getAuthToken(): string | null {
  try {
    return window.localStorage.getItem('token');
  } catch {
    return null;
  }
}

/**
 * Переключить активное окно анализа во время лекции.
 *
 * @param slug   slug трансляции (`liveSession.slug`).
 * @param body   `analysisId` обязателен; tree/startingFen/orientation/title/
 *               currentGlobalIndex — опциональны (см. ADR-142 §2.6: если
 *               клиент опустил поля, backend возьмёт их из `Analysis`).
 * @returns      актуальный `LiveAnalysisSyncSnapshot` (то же, что улетит
 *               broadcast'ом всем зрителям).
 *
 * Бросает `LiveAnalysisApiError` для всех известных кодов; сетевые/
 * парсинг-ошибки тоже заворачиваются в этот тип.
 */
export async function switchLiveAnalysis(
  slug: string,
  body: SwitchAnalysisRequest,
): Promise<SwitchAnalysisResponse> {
  const API_URL = getApiUrl();
  const token = getAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(
      `${API_URL}/live-analyses/${encodeURIComponent(slug)}/switch-analysis`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      },
    );
  } catch (e) {
    throw new LiveAnalysisApiError(
      'network_error',
      0,
      e instanceof Error ? e.message : String(e),
    );
  }

  if (res.status >= 200 && res.status < 300) {
    try {
      return (await res.json()) as SwitchAnalysisResponse;
    } catch {
      throw new LiveAnalysisApiError('invalid_response', res.status);
    }
  }

  // Пытаемся вытащить `{ code: '...' }` из тела ошибки (NestJS-формат).
  let code = 'server_error';
  try {
    const data = (await res.json()) as { code?: string; message?: string };
    if (typeof data?.code === 'string') {
      code = data.code;
    } else if (res.status === 401) {
      code = 'unauthorized';
    } else if (res.status === 403) {
      code = 'forbidden';
    } else if (res.status === 404) {
      code = 'not_found';
    } else if (res.status === 400) {
      code = 'bad_request';
    }
  } catch {
    /* тело не JSON — оставляем generic-код */
  }
  throw new LiveAnalysisApiError(code, res.status);
}
