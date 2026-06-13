#!/usr/bin/env node
// tools/video-overview/record.mjs
// ─────────────────────────────────────────────────────────────────────
// Универсальный интерпретатор `scene-actions.json` для серии видеообзоров.
// Pipeline v2 (ADR-123): аудио первично, действия привязаны к словам-якорям.
//
// Вход (по --key=KS-NNNN):
//   /tmp/KS-NNNN/scene-actions.json           — декларация сцен
//   /tmp/KS-NNNN/segments.json                — длительности (выход measure-segments.py)
//   /tmp/voiceover/KS-NNNN/segment-NNN.timings.json — character-timings ElevenLabs
//
// Выход:
//   /tmp/KS-NNNN/videos/A1/<uuid>.webm — широкий контекст A (single сцены)
//   /tmp/KS-NNNN/videos/B1/<uuid>.webm — узкий контекст B (single сцены, off-screen)
//   /tmp/KS-NNNN/videos/A2/<uuid>.webm — узкий контекст A (split сцены)
//   /tmp/KS-NNNN/videos/B2/<uuid>.webm — узкий контекст B (split сцены)
//   /tmp/KS-NNNN/placements.json — метаданные сцен (startMs, durMs, holdMs, layout)
//                                  + ссылки на видео и оффсеты записи
//
// Авторизация: POST /auth/dev-bypass (DEV_SECRET).
//
// Универсальный — общий для всей серии. Под конкретный тикет меняются ТОЛЬКО:
//   scenario, scene-actions.json, тексты сегментов в /tmp/voiceover/KS-NNNN/.
// ─────────────────────────────────────────────────────────────────────

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ── константы окружения ────────────────────────────────────────────
const API = process.env.KS_API || 'http://localhost:3001';
const WEB = process.env.KS_WEB || 'http://localhost:5173';
const DEV_SECRET = process.env.KS_DEV_SECRET || 'kingside-dev-bypass-2026';
const CHROME =
  process.env.KS_CHROME ||
  '/home/agent/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const VIEWPORT_WIDE = { width: 1920, height: 1200 };
const VIEWPORT_NARROW = { width: 1080, height: 1350 };
const BUFFER_MS = 400;
const META_DEFAULTS = { leadMs: -200, occurrence: 1, side: 'A' };

// ── CLI args ───────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { key: null, headless: true };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--key=')) out.key = a.slice('--key='.length).trim();
    else if (a === '--headed') out.headless = false;
    else if (a === '--help' || a === '-h') {
      console.log('usage: record.mjs --key=KS-NNNN [--headed]');
      process.exit(0);
    }
  }
  if (!out.key) {
    console.error('ERROR: --key=KS-NNNN обязателен');
    process.exit(2);
  }
  return out;
}
const args = parseArgs(process.argv);
const KEY = args.key;
const DIR = `/tmp/${KEY}`;
const VOICE_DIR = `/tmp/voiceover/${KEY}`;
const VIDEO_DIR = path.join(DIR, 'videos');
const LOG_DIR = path.join(DIR, 'logs');

const log = (s) =>
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${s}`);

// ── resolve playwright-core ────────────────────────────────────────
async function loadPlaywright() {
  const candidates = [
    'playwright-core',
    '/project/node_modules/playwright-core/index.mjs',
    '/tmp/node_modules/playwright-core/index.mjs',
    '/usr/local/lib/node_modules/playwright-core/index.mjs',
  ];
  let lastErr = null;
  for (const c of candidates) {
    try {
      const mod = await import(c.startsWith('/') ? pathToFileURL(c).href : c);
      log(`playwright-core: loaded from ${c}`);
      return mod;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `cannot resolve playwright-core (tried ${candidates.length} paths): ${lastErr?.message || lastErr}`,
  );
}

// ── загрузка входов ────────────────────────────────────────────────
async function loadInputs() {
  await fs.mkdir(VIDEO_DIR, { recursive: true });
  await fs.mkdir(LOG_DIR, { recursive: true });

  const scenesRaw = JSON.parse(
    await fs.readFile(path.join(DIR, 'scene-actions.json'), 'utf-8'),
  );
  // допускаем два формата: { scenes: [...] } или просто [...]
  const scenes = Array.isArray(scenesRaw) ? scenesRaw : scenesRaw.scenes;
  const defaults = (!Array.isArray(scenesRaw) && scenesRaw.defaults) || {};
  const initialAuth =
    (!Array.isArray(scenesRaw) && scenesRaw.initialAuth) || 'user';
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error(`scene-actions.json: пустой / неверный формат`);
  }

  const segments = JSON.parse(
    await fs.readFile(path.join(DIR, 'segments.json'), 'utf-8'),
  );
  // карта idx → segment-meta
  const segByIdx = new Map();
  for (const s of segments) segByIdx.set(s.idx, s);

  // загружаем timings для каждой сцены по полю segment
  const timingsByTag = new Map();
  for (const sc of scenes) {
    const idx = sc.segment;
    const segMeta = segByIdx.get(idx);
    if (!segMeta) {
      log(`WARN: scene "${sc.tag}" → segment ${idx} не найден в segments.json`);
      continue;
    }
    const fileBase = path.basename(segMeta.file, '.mp3'); // segment-001
    const timingsPath = path.join(VOICE_DIR, `${fileBase}.timings.json`);
    try {
      const t = JSON.parse(await fs.readFile(timingsPath, 'utf-8'));
      timingsByTag.set(sc.tag, t);
    } catch (e) {
      log(`WARN: timings для "${sc.tag}" не загружены (${timingsPath}): ${e.message}`);
      timingsByTag.set(sc.tag, null);
    }
  }
  return { scenes, defaults, segments, segByIdx, timingsByTag, initialAuth };
}

// ── auth dev-bypass ─────────────────────────────────────────────────
async function bypass(user) {
  const r = await fetch(`${API}/auth/dev-bypass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: DEV_SECRET, user }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`dev-bypass failed: HTTP ${r.status} ${t.slice(0, 200)}`);
  }
  return r.json();
}
function uidFromJwt(t) {
  try {
    return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).sub;
  } catch {
    return null;
  }
}

// ── anchor → ms ─────────────────────────────────────────────────────
// Поиск точной подстроки в склейке characters[].
// Поддерживает occurrence (1-based) и useLast.
// Если не найдено — возвращает null (calling code применит fallbackAtMs).
function anchorToMs(timings, anchor, opts = {}) {
  if (!timings) return null;
  const chars = timings.characters || [];
  const starts = timings.character_start_times_seconds || [];
  if (!chars.length || !starts.length) return null;
  const fullText = chars.join('');
  // первое и последующие вхождения
  const positions = [];
  let from = 0;
  while (from <= fullText.length) {
    const at = fullText.indexOf(anchor, from);
    if (at < 0) break;
    positions.push(at);
    from = at + Math.max(1, anchor.length);
  }
  if (positions.length === 0) return null;
  let pos;
  if (opts.useLast) pos = positions[positions.length - 1];
  else {
    const occ = Math.max(1, opts.occurrence || 1);
    pos = positions[Math.min(positions.length, occ) - 1];
  }
  if (pos >= starts.length) return null;
  return Math.round(starts[pos] * 1000);
}

// ── маленькие helpers Playwright ────────────────────────────────────
async function dismissOnboarding(page) {
  await page
    .evaluate(() => {
      try {
        localStorage.setItem('ks2814NavOnboardingSeen', 'true');
        document
          .querySelectorAll('[data-testid="nav-onboarding-tooltip-close"]')
          .forEach((b) => b.click?.());
      } catch {}
    })
    .catch(() => {});
}
async function waitForFonts(page) {
  await page
    .evaluate(async () => {
      try {
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
      } catch {}
    })
    .catch(() => {});
}
async function dragSquare(p, from, to) {
  const pieceLoc = p.locator(`[data-square="${from}"] [data-piece]`).first();
  let f = await pieceLoc.boundingBox().catch(() => null);
  if (!f)
    f = await p
      .locator(`[data-square="${from}"]`)
      .first()
      .boundingBox()
      .catch(() => null);
  const t = await p
    .locator(`[data-square="${to}"]`)
    .first()
    .boundingBox()
    .catch(() => null);
  if (!f || !t) {
    log(`dragSquare(${from}→${to}): boundingBox=null, skip`);
    return false;
  }
  const fx = f.x + f.width / 2;
  const fy = f.y + f.height / 2;
  const tx = t.x + t.width / 2;
  const ty = t.y + t.height / 2;
  await p.mouse.move(fx, fy);
  await p.waitForTimeout(80);
  await p.mouse.down();
  await p.waitForTimeout(40);
  await p.mouse.move(fx + 10, fy + 10, { steps: 3 });
  await p.mouse.move(tx, ty, { steps: 18 });
  await p.waitForTimeout(80);
  await p.mouse.up();
  return true;
}
async function flashElement(page, selector, durationMs) {
  await page
    .evaluate(
      ([sel, dur]) => {
        const els = Array.from(document.querySelectorAll(sel));
        if (!els.length) return;
        for (const el of els) {
          const old = el.style.outline;
          const oldBox = el.style.boxShadow;
          el.style.outline = '3px solid #ffd84d';
          el.style.boxShadow = '0 0 18px 4px rgba(255,216,77,0.85)';
          setTimeout(() => {
            el.style.outline = old || '';
            el.style.boxShadow = oldBox || '';
          }, dur);
        }
      },
      [selector, durationMs],
    )
    .catch(() => {});
}
async function detectColor(page, gameId, token, myUserId) {
  return page
    .evaluate(
      async ({ api, gameId, token, myUserId }) => {
        const r = await fetch(`${api}/games/${gameId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return null;
        const g = await r.json();
        const w = g.whiteId || g.white?.id;
        if (!w) return null;
        return w === myUserId ? 'white' : 'black';
      },
      { api: API, gameId, token, myUserId },
    )
    .catch(() => null);
}

// ── main ────────────────────────────────────────────────────────────
(async () => {
  log(`KEY=${KEY} DIR=${DIR}`);
  const { chromium } = await loadPlaywright();
  const { scenes, defaults, segByIdx, timingsByTag, initialAuth } =
    await loadInputs();
  const mergedDefaults = { ...META_DEFAULTS, ...defaults };
  log(`initialAuth=${initialAuth}`);

  // авторизация двух юзеров
  const ts = Date.now();
  const userA = `${KEY.toLowerCase()}a-${ts}`;
  const userB = `${KEY.toLowerCase()}b-${ts}`;
  log('dev-bypass…');
  const [authA, authB] = await Promise.all([bypass(userA), bypass(userB)]);
  const uidA = uidFromJwt(authA.accessToken);
  const uidB = uidFromJwt(authB.accessToken);
  log(`auth A=${userA} uid=${uidA}, B=${userB} uid=${uidB}`);

  // ── browser + 4 контекста параллельно (recordVideo синхронно) ─
  const browser = await chromium.launch({
    headless: args.headless,
    executablePath: CHROME,
  });

  const dirA1 = path.join(VIDEO_DIR, 'A1');
  const dirB1 = path.join(VIDEO_DIR, 'B1');
  const dirA2 = path.join(VIDEO_DIR, 'A2');
  const dirB2 = path.join(VIDEO_DIR, 'B2');
  for (const d of [dirA1, dirB1, dirA2, dirB2])
    await fs.mkdir(d, { recursive: true });

  const ctxCreateTimes = {};
  async function mkContext(auth, dir, viewport, name, withAuth = true) {
    const before = Date.now();
    const ctx = await browser.newContext({
      viewport,
      recordVideo: { dir, size: viewport },
    });
    const after = Date.now();
    ctxCreateTimes[name] = { before, after };
    if (withAuth) {
      await ctx.addInitScript(
        ([t, r]) => {
          localStorage.setItem('token', t);
          localStorage.setItem('refreshToken', r);
          localStorage.setItem('locale', 'ru');
          localStorage.setItem('theme', 'dark');
          localStorage.setItem('ks2814NavOnboardingSeen', 'true');
        },
        [auth.accessToken, auth.refreshToken],
      );
    } else {
      // guest-режим: токены не кладём, только UI-настройки.
      await ctx.addInitScript(() => {
        localStorage.setItem('locale', 'ru');
        localStorage.setItem('theme', 'dark');
        localStorage.setItem('ks2814NavOnboardingSeen', 'true');
      });
    }
    return ctx;
  }

  // initialAuth='guest' влияет ТОЛЬКО на A1 (broad single-сцены). B1/A2/B2
  // нужны для split-сцен с шахматной партией — там всегда требуется auth.
  const a1WithAuth = initialAuth !== 'guest';
  log('creating 4 contexts in parallel…');
  const [ctxA1, ctxB1, ctxA2, ctxB2] = await Promise.all([
    mkContext(authA, dirA1, VIEWPORT_WIDE, 'A1', a1WithAuth),
    mkContext(authB, dirB1, VIEWPORT_NARROW, 'B1'),
    mkContext(authA, dirA2, VIEWPORT_NARROW, 'A2'),
    mkContext(authB, dirB2, VIEWPORT_NARROW, 'B2'),
  ]);
  const [pa1, pb1, pa2, pb2] = await Promise.all([
    ctxA1.newPage(),
    ctxB1.newPage(),
    ctxA2.newPage(),
    ctxB2.newPage(),
  ]);
  for (const [p, tag] of [
    [pa1, 'A1'],
    [pb1, 'B1'],
    [pa2, 'A2'],
    [pb2, 'B2'],
  ])
    p.on('pageerror', (e) =>
      log(`${tag} PAGE-EXC: ` + String(e).slice(0, 160)),
    );
  log(`ctx times: ${JSON.stringify(ctxCreateTimes)}`);

  // активные ссылки на pageA/pageB (меняются при переходе single→split)
  let pageA = pa1;
  let pageB = pb1;

  // ── pre-roll: открываем стартовую страницу A wide ──────────────
  // Стартовый URL берём из первой scene metaAction goto, если есть; иначе ${WEB}/play
  const firstScene = scenes[0] || {};
  const firstGoto = (firstScene.metaActions || []).find(
    (m) => m.type === 'goto' && (m.side || 'A') === 'A',
  );
  const startUrl = (firstGoto?.url || `${WEB}/play`).replace('${WEB}', WEB);
  await pageA.goto(startUrl, { waitUntil: 'domcontentloaded' });
  await pageA.waitForTimeout(1500);
  await waitForFonts(pageA);
  await dismissOnboarding(pageA);

  // ── VIDEO START ─────────────────────────────────────────────────
  const recordStartedAt = Date.now();
  log('VIDEO START');

  // дополнительные оффсеты записи (для пост-обрезки видео в build-track)
  const videoOffsets = {
    A1: recordStartedAt - ctxCreateTimes.A1.after,
    B1: recordStartedAt - ctxCreateTimes.B1.after,
    A2: recordStartedAt - ctxCreateTimes.A2.after,
    B2: recordStartedAt - ctxCreateTimes.B2.after,
  };
  log(`video offsets: ${JSON.stringify(videoOffsets)}`);

  // состояние для шахматных meta-actions
  const gameState = {
    gameId: null,
    colorA: null,
    colorB: null,
    switchedToNarrow: false,
  };

  // ── action dispatcher ─────────────────────────────────────────
  async function dispatchAction(action, ctx) {
    const side = action.side || mergedDefaults.side;
    const page = side === 'B' ? pageB : pageA;
    const sel = action.selector;
    const useLast = action.useLast === true;
    const target = sel
      ? useLast
        ? page.locator(sel).last()
        : page.locator(sel).first()
      : null;
    try {
      switch (action.type) {
        case 'hover':
          if (target)
            await target.hover({ timeout: 1200 }).catch(() => {});
          break;
        case 'click':
          if (target)
            await target.click({ timeout: 2000 }).catch(() => {});
          break;
        case 'type':
          if (target) {
            await target.click({ timeout: 1500 }).catch(() => {});
            await target.fill(action.text || '').catch(() => {});
          }
          break;
        case 'drag': {
          const mover = action.moverColor;
          const pickPage =
            mover === gameState.colorA
              ? pageA
              : mover === gameState.colorB
              ? pageB
              : page;
          await dragSquare(pickPage, action.from, action.to);
          break;
        }
        case 'flash':
          if (sel)
            await flashElement(page, sel, action.durationMs || 1200);
          break;
        case 'selectOption': {
          // Для нативных <select>. action.value — значение опции,
          // action.label — текст. Достаточно одного.
          if (!target) break;
          const arg =
            action.value != null
              ? { value: String(action.value) }
              : action.label
              ? { label: String(action.label) }
              : null;
          if (!arg) {
            log(`WARN: selectOption без value/label — skip`);
            break;
          }
          await target
            .selectOption(arg, { timeout: 2000 })
            .catch(() => {});
          break;
        }
        case 'scroll': {
          // selector → element.scrollIntoView; top → window.scrollTo
          await page
            .evaluate(
              ({ s, top, block }) => {
                if (s) {
                  const el = document.querySelector(s);
                  if (el)
                    el.scrollIntoView({
                      behavior: 'smooth',
                      block: block || 'start',
                    });
                } else if (top != null) {
                  window.scrollTo({ top, behavior: 'smooth' });
                }
              },
              {
                s: action.selector || null,
                top: action.top ?? null,
                block: action.block || null,
              },
            )
            .catch(() => {});
          break;
        }
        default:
          log(`WARN: unknown action type "${action.type}" — skip`);
      }
    } catch (e) {
      log(`action ${action.type} ${sel || ''} failed: ${String(e).slice(0, 120)}`);
    }
  }

  // ── meta-action dispatcher ────────────────────────────────────
  async function runMetaActions(scene) {
    const metas = scene.metaActions || [];
    for (const m of metas) {
      const side = m.side || 'A';
      const page = side === 'B' ? pageB : pageA;
      try {
        switch (m.type) {
          case 'goto': {
            const url = (m.url || '').replace('${WEB}', WEB);
            if (!url) {
              log(`WARN: goto без url, skip`);
              break;
            }
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            if (m.waitForUrl) {
              await page
                .waitForURL(new RegExp(m.waitForUrl), {
                  timeout: m.waitForUrlTimeoutMs || 12000,
                })
                .catch(() => {});
            }
            await page.waitForTimeout(m.waitMsAfter ?? 800);
            break;
          }
          case 'waitForSelector': {
            const sides = m.sides || [side];
            const timeout = m.timeoutMs || 6000;
            await Promise.all(
              sides.map((sd) => {
                const p = sd === 'B' ? pageB : pageA;
                return p
                  .waitForSelector(m.selector, { timeout })
                  .catch(() => {});
              }),
            );
            break;
          }
          case 'dismissOnboarding': {
            const sides = m.sides || [side];
            for (const sd of sides) {
              const p = sd === 'B' ? pageB : pageA;
              await dismissOnboarding(p);
            }
            break;
          }
          case 'startContextB': {
            const url = (m.url || `${WEB}/play`).replace('${WEB}', WEB);
            await pageB.goto(url, { waitUntil: 'domcontentloaded' });
            await pageB.waitForTimeout(500);
            await dismissOnboarding(pageB);
            break;
          }
          case 'contextBJoinQueue': {
            await pageB
              .locator(`button:has-text("${m.category || 'Блиц'}")`)
              .first()
              .click({ timeout: 1500 })
              .catch(() => {});
            await pageB
              .locator(`button:has-text("${m.preset || '3 мин'}")`)
              .first()
              .click({ timeout: 1500 })
              .catch(() => {});
            await pageB
              .locator('.play-btn--big')
              .first()
              .click({ timeout: 2500 })
              .catch(() => {});
            log('B clicked Играть');
            break;
          }
          case 'contextBSelectPresets': {
            // Подготовка контекста B без нажатия «Играть».
            // Используется, когда B должен «дождаться» голос и нажать
            // «Играть» уже в actions сцены, синхронно с A.
            if (m.category) {
              await pageB
                .locator(`button:has-text("${m.category}")`)
                .first()
                .click({ timeout: 1500 })
                .catch(() => {});
            }
            if (m.preset) {
              await pageB
                .locator(`button:has-text("${m.preset}")`)
                .first()
                .click({ timeout: 1500 })
                .catch(() => {});
            }
            log(`B selected presets ${m.category || ''}/${m.preset || ''}`);
            break;
          }
          case 'contextAJoinQueue': {
            // Симметрично contextBJoinQueue, но для pageA. Используется в queue-сцене,
            // чтобы A встал в очередь параллельно с B — без блокировки на anchor.
            if (m.category) {
              await pageA
                .locator(`button:has-text("${m.category}")`)
                .first()
                .click({ timeout: 1500 })
                .catch(() => {});
            }
            if (m.preset) {
              await pageA
                .locator(`button:has-text("${m.preset}")`)
                .first()
                .click({ timeout: 1500 })
                .catch(() => {});
            }
            await pageA
              .locator('.play-btn--big')
              .first()
              .click({ timeout: 2500 })
              .catch(() => {});
            log('A clicked Играть');
            break;
          }
          case 'waitForBothNavigate': {
            const pat = new RegExp(m.urlPattern || '/game/[a-f0-9-]+');
            const timeout = m.timeoutMs || 20000;
            try {
              await Promise.all([
                pageA.waitForURL(pat, { timeout }).catch(() => {}),
                pageB.waitForURL(pat, { timeout }).catch(() => {}),
              ]);
            } catch {}
            const mA = pageA.url().match(/\/game\/([a-f0-9-]+)/);
            if (mA) gameState.gameId = mA[1];
            log(`navigated to /game/${gameState.gameId}`);
            break;
          }
          case 'detectColors': {
            if (!gameState.gameId) break;
            for (let i = 0; i < 5; i++) {
              if (!gameState.colorA)
                gameState.colorA = await detectColor(
                  pageA,
                  gameState.gameId,
                  authA.accessToken,
                  uidA,
                );
              if (!gameState.colorB)
                gameState.colorB = await detectColor(
                  pageB,
                  gameState.gameId,
                  authB.accessToken,
                  uidB,
                );
              if (gameState.colorA && gameState.colorB) break;
              await pageA.waitForTimeout(400);
            }
            log(
              `colorA=${gameState.colorA} colorB=${gameState.colorB}`,
            );
            break;
          }
          default:
            log(`WARN: unknown metaAction type "${m.type}" — skip`);
        }
      } catch (e) {
        log(`meta ${m.type} failed: ${String(e).slice(0, 120)}`);
      }
    }
  }

  // ── переход на узкие контексты (перед первой split-сценой) ────
  async function switchToNarrowContexts() {
    if (gameState.switchedToNarrow) return;
    // если gameId ещё не зафиксирован (waitForBothNavigate не использовался),
    // подождём навигации на /game/:uuid в pageA до 8 секунд.
    if (!gameState.gameId) {
      try {
        await pageA.waitForURL(/\/game\/[a-f0-9-]+/, { timeout: 8000 });
        const m = pageA.url().match(/\/game\/([a-f0-9-]+)/);
        if (m) {
          gameState.gameId = m[1];
          log(`gameId captured before switch: ${gameState.gameId}`);
        }
      } catch {
        log('WARN: pageA не дошёл до /game/:uuid за 8с');
      }
    }
    log('switching to narrow A2/B2…');
    try {
      await Promise.all([ctxA1.close(), ctxB1.close()]);
    } catch (e) {
      log('close wide ctx failed: ' + String(e).slice(0, 120));
    }
    if (gameState.gameId) {
      await Promise.all([
        pa2.goto(`${WEB}/game/${gameState.gameId}`, {
          waitUntil: 'domcontentloaded',
        }),
        pb2.goto(`${WEB}/game/${gameState.gameId}`, {
          waitUntil: 'domcontentloaded',
        }),
      ]);
    } else {
      log('WARN: gameId не определён, narrow контексты не получат /game/:id');
    }
    pageA = pa2;
    pageB = pb2;
    await Promise.all([
      pa2
        .locator('[data-square="e2"]')
        .first()
        .waitFor({ timeout: 10000 })
        .catch(() => {}),
      pb2
        .locator('[data-square="e2"]')
        .first()
        .waitFor({ timeout: 10000 })
        .catch(() => {}),
    ]);
    await Promise.all([
      waitForFonts(pa2),
      waitForFonts(pb2),
      dismissOnboarding(pa2),
      dismissOnboarding(pb2),
    ]);
    gameState.switchedToNarrow = true;
  }

  // ── основной цикл по сценам ───────────────────────────────────
  const placements = [];
  let prevAtMs = 0;
  for (const scene of scenes) {
    const segMeta = segByIdx.get(scene.segment);
    if (!segMeta) {
      log(`WARN: scene "${scene.tag}" — segment ${scene.segment} нет, skip`);
      continue;
    }
    const durMs = segMeta.durMs;
    const layoutExplicit = scene.layout || (scene.split ? 'split' : null);
    // авто-детект layout:
    // 1) явный scene.layout > всё остальное
    // 2) уже переключились в narrow → split (sticky)
    // 3) в metaActions detectColors / waitForSelector sides=[A,B] → split
    const autoSplitByMeta = (scene.metaActions || []).some(
      (m) =>
        m.type === 'detectColors' ||
        (m.type === 'waitForSelector' &&
          Array.isArray(m.sides) &&
          m.sides.includes('B')),
    );
    const effectiveLayout =
      layoutExplicit ||
      (gameState.switchedToNarrow || autoSplitByMeta ? 'split' : 'single');

    if (effectiveLayout === 'split' && !gameState.switchedToNarrow) {
      await switchToNarrowContexts();
    }

    // meta-actions выполняются ДО фиксации sceneStartMs,
    // чтобы actions/voice стартовали в одной точке времени.
    await runMetaActions(scene);
    const sceneStartMs = Date.now() - recordStartedAt;
    log(
      `SCENE ${scene.tag} start=${sceneStartMs}ms dur=${durMs}ms layout=${effectiveLayout}`,
    );

    // resolve anchor times и сортируем
    const timings = timingsByTag.get(scene.tag);
    const acts = scene.actions || [];
    const scheduled = [];
    let cumulativeFromPrev = 0;
    for (const a of acts) {
      const occurrence = a.occurrence ?? mergedDefaults.occurrence;
      const useLast = a.useLast === true;
      const leadMs = a.leadMs ?? mergedDefaults.leadMs;
      let atMs = null;
      if (a.delayFromPrevMs != null) {
        atMs = cumulativeFromPrev + a.delayFromPrevMs;
      } else if (a.anchor) {
        const ms = anchorToMs(timings, a.anchor, { occurrence, useLast });
        if (ms != null) {
          atMs = ms + leadMs;
        } else if (a.fallbackAtMs != null) {
          atMs =
            a.fallbackAtMs < 0 ? durMs + a.fallbackAtMs : a.fallbackAtMs;
          log(
            `  anchor "${a.anchor}" not found, fallback atMs=${atMs}`,
          );
        } else {
          log(`  anchor "${a.anchor}" not found, no fallback — skip`);
          continue;
        }
      } else if (a.fallbackAtMs != null) {
        atMs = a.fallbackAtMs < 0 ? durMs + a.fallbackAtMs : a.fallbackAtMs;
      } else {
        log(`  action without anchor/delayFromPrevMs — skip`);
        continue;
      }
      cumulativeFromPrev = atMs;
      scheduled.push({ ...a, atMs });
    }
    // delayFromPrevMs сохраняет порядок объявления, anchor — сортируем по времени
    const anchorActs = scheduled.filter((a) => a.anchor && a.delayFromPrevMs == null);
    const seqActs = scheduled.filter((a) => a.delayFromPrevMs != null);
    anchorActs.sort((x, y) => x.atMs - y.atMs);
    // итог: anchor-actions сначала сортированы, после них — seq в порядке объявления
    const finalSchedule = [...anchorActs, ...seqActs].sort(
      (x, y) => x.atMs - y.atMs,
    );

    // диспатч
    let cursorMs = 0;
    const refPage = pageA;
    for (const a of finalSchedule) {
      const wait = Math.max(0, a.atMs - cursorMs);
      if (wait > 0) await refPage.waitForTimeout(wait);
      await dispatchAction(a);
      // курсор должен учитывать фактическое время dispatchAction,
      // иначе последующие actions суммарно отстают
      cursorMs = Date.now() - recordStartedAt - sceneStartMs;
    }

    // удержание сцены до durMs + BUFFER
    const spent = Date.now() - recordStartedAt - sceneStartMs;
    const need = durMs + BUFFER_MS;
    if (spent < need) await refPage.waitForTimeout(need - spent);
    const holdMs = Date.now() - recordStartedAt - sceneStartMs;

    placements.push({
      tag: scene.tag,
      segment: scene.segment,
      startMs: sceneStartMs,
      durMs,
      holdMs,
      layout: effectiveLayout,
    });
    log(`  scene "${scene.tag}" done: hold=${holdMs}ms (need ${need}ms)`);
    prevAtMs = sceneStartMs + holdMs;
  }

  // финал
  const totalMs = Date.now() - recordStartedAt;
  const videoEndAt = Date.now();
  log(`VIDEO END · total=${totalMs}ms`);

  // закрываем оставшиеся открытые контексты
  for (const c of [ctxA1, ctxB1, ctxA2, ctxB2]) {
    try {
      await c.close();
    } catch {}
  }
  await browser.close();

  // ищем фактические пути webm после close (Playwright их именует uuid'ом)
  async function findVideoFile(dir) {
    try {
      const items = await fs.readdir(dir);
      const webm = items
        .filter((f) => f.endsWith('.webm'))
        .map((f) => path.join(dir, f));
      // если несколько — берём самый свежий
      let pick = null;
      let pickMtime = 0;
      for (const p of webm) {
        const st = await fs.stat(p);
        if (st.mtimeMs > pickMtime) {
          pickMtime = st.mtimeMs;
          pick = p;
        }
      }
      return pick;
    } catch {
      return null;
    }
  }
  const videos = {
    A1: await findVideoFile(dirA1),
    B1: await findVideoFile(dirB1),
    A2: await findVideoFile(dirA2),
    B2: await findVideoFile(dirB2),
  };

  const out = {
    key: KEY,
    totalMs,
    recordStartedAt,
    videoEndAt,
    bufferMs: BUFFER_MS,
    viewports: { wide: VIEWPORT_WIDE, narrow: VIEWPORT_NARROW },
    videos,
    videoOffsets,
    ctxCreateTimes,
    gameId: gameState.gameId,
    colorA: gameState.colorA,
    colorB: gameState.colorB,
    scenes: placements,
  };
  await fs.writeFile(
    path.join(DIR, 'placements.json'),
    JSON.stringify(out, null, 2),
  );
  await fs.writeFile(path.join(DIR, 'video-total-ms.txt'), String(totalMs));
  log(`placements → ${path.join(DIR, 'placements.json')}`);
  log('done.');
})().catch((e) => {
  console.error('FATAL:', e.stack || e);
  process.exit(1);
});
