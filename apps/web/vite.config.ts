import { defineConfig, type Plugin } from 'vite';
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
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        globIgnores: ['**/stockfish/**'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^https?:\/\/.*\/api\/(?!auth\/)/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 300,
              },
            },
          },
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
