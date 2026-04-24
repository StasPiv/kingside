/// <reference types="vite/client" />


interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_ARCHIVE_URL: string;
  readonly VITE_BROADCAST_URL: string;
  readonly VITE_GAME_URL?: string;
  readonly VITE_TELEGRAM_BOT_USERNAME: string;
  readonly VITE_TELEGRAM_BOT_ID: string;
  readonly VITE_DEV_BYPASS_SECRET?: string;
  readonly VITE_TEST_MODE?: string;
  readonly VITE_AI_CHAT_ENABLED?: string;
  readonly VITE_GA4_ID?: string;
  /**
   * Email-whitelist для доступа к `/lessons/editor` (L-27, KS-1805).
   * Разделитель — запятая. Нечувствителен к регистру. Если не задан —
   * никто кроме специально авторизованных не попадёт на страницу.
   */
  readonly VITE_LESSON_EDITOR_EMAILS?: string;
  /**
   * Feature-flag на раздел «Уроки» (KS-1820). Строка `'true'` —
   * раздел виден; любое другое значение (включая `undefined`) —
   * пункт «Уроки» убирается из навигации, маршруты `/lessons/*`
   * редиректят на `/`. На dev по умолчанию считаем флаг включённым,
   * если переменная не задана (разработка раздела продолжается).
   */
  readonly VITE_FEATURE_LESSONS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
