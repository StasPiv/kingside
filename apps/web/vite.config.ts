import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import { execSync } from 'child_process';
import fs from 'fs';

function getVersion(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const since = `${y}-${m}-${d}T00:00:00`;
  let n = 1;
  try {
    const out = execSync(`git log --oneline --since='${since}'`, { encoding: 'utf-8' });
    n = out.trim().split('\n').filter(Boolean).length || 1;
  } catch { /* fallback */ }
  return `${y}.${m}.${d}.${n}`;
}

function versionPlugin(): Plugin {
  return {
    name: 'version-json',
    buildStart() {
      const dest = path.resolve(__dirname, 'public/version.json');
      fs.writeFileSync(dest, JSON.stringify({ version: getVersion() }));
    },
    configureServer(server) {
      server.middlewares.use('/version.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ version: getVersion() }));
      });
    },
  };
}

// Load per-app env files (apps/web/.env.local, .env.development.local, .env)
// in addition to the shared monorepo envDir below. Per-app overrides are useful
// when the root .env is managed by devops и ещё не содержит новую переменную —
// разработчик/агент добавляет VITE_* в apps/web/.env.local без правки корня.
// KS-1699: VITE_BROADCAST_URL добавляется именно так до того, как devops
// пропишет её в /project/.env хоста.
const APP_ENV_MODE = process.env.NODE_ENV ?? 'development';
const perAppEnv = loadEnv(APP_ENV_MODE, __dirname, '');
for (const key of Object.keys(perAppEnv)) {
  if (key.startsWith('VITE_') && process.env[key] === undefined) {
    process.env[key] = perAppEnv[key];
  }
}

export default defineConfig({
  plugins: [
    versionPlugin(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      devOptions: {
        enabled: false,
      },
      manifest: {
        name: 'Kingside — Online Chess',
        short_name: 'Kingside',
        description: 'Play chess online with friends',
        theme_color: '#1a1a2e',
        background_color: '#1a1a2e',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        // Only precache static assets (icons, fonts). JS/CSS have content-hash
        // in filenames and are handled via NetworkFirst to avoid stale chunks.
        globPatterns: ['**/*.{svg,png,woff2}'],
        globIgnores: ['**/stockfish/**'],
        // navigateFallback removed: index.html is not in precache (globPatterns),
        // so referencing it as fallback causes PWA to hang on splash screen.
        // Navigation is handled by runtimeCaching NetworkFirst below.
        runtimeCaching: [
          {
            // JS and CSS: network first, fall back to cache
            urlPattern: /\.(?:js|css)$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'assets-cache',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 86400,
              },
            },
          },
          {
            // index.html: always fetch fresh
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'html-cache',
              expiration: {
                maxEntries: 5,
                maxAgeSeconds: 3600,
              },
            },
          },
          // KS-2402: блок NetworkFirst для `/api/(?!auth/)` удалён.
          // Причина — баг «одна и та же позиция»: на медленной сети
          // workbox отдавал из api-cache ответ от другого URL (например,
          // /analyses/UUID-A в ответ на /analyses/UUID-B), потому что
          // NetworkFirst при таймауте fallback'ит на cache. Кеш API на
          // SW-уровне не нужен — ETag/Cache-Control из бэкенда (KS-2376
          // и общие настройки) работают на уровне браузера, а SW-слой
          // ломал per-resource invalidation.
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // KS-2079 / L1: dev-proxy для archive-сервиса. Прод archive-сервис
    // отдаёт CORS только для своих доменов (archive.kingside.site,
    // kingside.site), запросы с http://localhost:5173 он режет.
    // Решение: в dev фронт ходит на относительный `/__archive/...`,
    // vite сам проксирует на `https://archive.kingside.site` с
    // `changeOrigin: true` — браузер видит same-origin, CORS не
    // применяется. В prod-сборке `VITE_ARCHIVE_URL` инжектируется
    // нормальным абсолютным URL'ом (`https://archive.kingside.site`)
    // через scripts/deploy-aws.sh, так что proxy задействован только
    // в dev.
    proxy: {
      '/__archive': {
        target: 'https://archive.kingside.site',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/__archive/, ''),
      },
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client', 'react-router-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    force: false,
  },
  envDir: path.resolve(__dirname, '../..'),
  resolve: {
    alias: {
      '@kingside/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
});
