/// <reference types="vite/client" />


interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_GAME_URL?: string;
  readonly VITE_TELEGRAM_BOT_USERNAME: string;
  readonly VITE_TELEGRAM_BOT_ID: string;
  readonly VITE_DEV_BYPASS_SECRET?: string;
  readonly VITE_TEST_MODE?: string;
  readonly VITE_AI_CHAT_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
