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
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

// ── константы окружения ────────────────────────────────────────────
const API = process.env.KS_API || 'http://localhost:3001';
const WEB = process.env.KS_WEB || 'http://localhost:5173';
const DEV_SECRET = process.env.KS_DEV_SECRET || 'kingside-dev-bypass-2026';
const CHROME =
  process.env.KS_CHROME ||
  '/home/agent/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const VIEWPORT_WIDE = { width: 1920, height: 1200 };
const VIEWPORT_NARROW = { width: 1080, height: 1350 };
// KS-4066: локальный Stockfish для ведения play-vs-engine попытки точной игрой.
const STOCKFISH_BIN = process.env.KS_STOCKFISH || '/usr/games/stockfish';
const BUFFER_MS = 400;
// KS-4065: жёсткий потолок на одно действие сцены (hover/click/drag/puzzleSolve),
// чтобы случайный затык во внутреннем ожидании Playwright не раздувал holdMs.
const ACTION_CAP_MS = 8000;
const META_DEFAULTS = { leadMs: -200, occurrence: 1, side: 'A' };

// ── CLI args ───────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    key: null,
    headless: true,
    scene: null,       // v3: --scene=<sceneId> (форсит DIRTY соответствующей цепочки)
    chain: null,       // v3: --chain=<chainId> (форсит DIRTY одной цепочки)
    force: false,      // v3: --force (все цепочки DIRTY)
    planOnly: false,   // v3: --plan-only (вывести план и выйти)
    invalidate: false, // v3: --invalidate (удалить meta.json указанной цепочки/сцены, без записи)
    keepMasters: true, // v3: --keep-masters=false выключает хранение master-*.webm
  };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--key=')) out.key = a.slice('--key='.length).trim();
    else if (a === '--headed') out.headless = false;
    else if (a.startsWith('--scene=')) out.scene = a.slice('--scene='.length).trim();
    else if (a.startsWith('--chain=')) out.chain = a.slice('--chain='.length).trim();
    else if (a === '--force') out.force = true;
    else if (a === '--plan-only') out.planOnly = true;
    else if (a === '--invalidate') out.invalidate = true;
    else if (a.startsWith('--keep-masters=')) {
      const v = a.slice('--keep-masters='.length).trim();
      out.keepMasters = !(v === 'false' || v === '0' || v === 'no');
    }
    else if (a === '--help' || a === '-h') {
      console.log('usage: record.mjs --key=KS-NNNN [--headed] [--scene=<id>] [--chain=<id>] [--force] [--plan-only] [--invalidate] [--keep-masters=true|false]');
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

// ── ASSERT-режим: журнал событий и принудительная сходимость ─────
//
// Каждое действие сценария должно либо нести поле `assert`, описывающее
// проверку реального DOM реального продукта, либо явно помечаться как
// «декоративное» (`assert: 'decorative'`). Действие без любого из этих
// двух — обрывает сцену.
//
// Запись каждой проверки идёт в /tmp/KS-NNNN/events.jsonl построчно
// (по одной записи на строку — на случай обрыва). Цикл попыток сцены:
// провал любой проверки → cleanup → перезаписать ту же сцену.
// Лимит — 3 попытки. После третьего провала процесс выходит с кодом 7.
const EVENTS_PATH = path.join(DIR, 'events.jsonl');
let _eventsTruncated = false;
async function writeEvent(rec) {
  if (!_eventsTruncated) {
    await fs.mkdir(DIR, { recursive: true }).catch(() => {});
    await fs.writeFile(EVENTS_PATH, '');
    _eventsTruncated = true;
  }
  const line = JSON.stringify({
    tsMs: Date.now(),
    ...rec,
  }) + '\n';
  await fs.appendFile(EVENTS_PATH, line);
}

class SceneFailError extends Error {
  constructor(message, ctx = {}) {
    super(message);
    this.name = 'SceneFailError';
    this.ctx = ctx;
  }
}

// runAssert: ждёт селектор на нужной стороне (visible если mustExist=true,
// hidden если mustExist=false). Кидает SceneFailError на FAIL. Пишет
// событие в журнал вне зависимости от исхода.
async function runAssert({
  assertSpec,
  pageA,
  pageB,
  label,
  sceneIdx,
  sceneTag,
  attempt,
  step,
}) {
  if (assertSpec === 'decorative') {
    await writeEvent({
      type: 'assert',
      sceneIdx, sceneTag, attempt, step, label,
      result: 'DECORATIVE',
    });
    return;
  }
  if (!assertSpec || typeof assertSpec !== 'object' || !assertSpec.selector) {
    throw new SceneFailError(
      `assert config missing at ${label}: ` +
        `expected { selector, side?, mustExist?, timeoutMs? } or "decorative"`,
      { sceneIdx, step },
    );
  }
  const side = assertSpec.side || 'A';
  const page = side === 'B' ? pageB : pageA;
  const sel = assertSpec.selector;
  const mustExist = assertSpec.mustExist !== false;
  const timeout = assertSpec.timeoutMs || 3000;
  const t0 = Date.now();
  let ok = false;
  let reason = null;
  try {
    if (mustExist) {
      await page.waitForSelector(sel, { timeout, state: 'visible' });
    } else {
      await page.waitForSelector(sel, { timeout, state: 'hidden' });
    }
    ok = true;
  } catch (e) {
    ok = false;
    reason = mustExist
      ? `selector "${sel}" not visible within ${timeout}ms on side ${side}`
      : `selector "${sel}" still visible after ${timeout}ms on side ${side}`;
  }
  const observedMs = Date.now() - t0;
  await writeEvent({
    type: 'assert',
    sceneIdx, sceneTag, attempt, step, label,
    side, selector: sel, mustExist, timeoutMs: timeout,
    result: ok ? 'OK' : 'FAIL',
    observedMs,
    ...(reason ? { reason } : {}),
  });
  if (!ok) {
    throw new SceneFailError(reason, { sceneIdx, step, side, selector: sel });
  }
}

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
  // KS-4316: scenario-level флаги для сценариев с двумя независимыми
  // wide-контекстами и/или подменой микрофона.
  //   wideViewportB: true              — B1 поднимается с VIEWPORT_WIDE
  //                                      (для сцен single-viewer)
  //   sceneDrivenNarrowSwitch: true    — при переходе в narrow НЕ форсить
  //                                      goto /game/:gameId (для D1 каждый
  //                                      контекст уходит на свой URL в
  //                                      metaActions сцены)
  //   grantMicrophone: ['A','B']       — массив сторон, которым предоставить
  //                                      разрешение microphone (для
  //                                      lecture-publisher / MediaRecorder)
  //   fakeAudioFile: '/tmp/...'        — путь к WAV, который Chromium
  //                                      подсунет вместо реального микрофона
  //                                      (--use-file-for-fake-audio-capture)
  const wideViewportB =
    !Array.isArray(scenesRaw) && scenesRaw.wideViewportB === true;
  const sceneDrivenNarrowSwitch =
    !Array.isArray(scenesRaw) && scenesRaw.sceneDrivenNarrowSwitch === true;
  const grantMicrophone =
    (!Array.isArray(scenesRaw) && Array.isArray(scenesRaw.grantMicrophone))
      ? scenesRaw.grantMicrophone
      : [];
  const fakeAudioFile =
    (!Array.isArray(scenesRaw) && typeof scenesRaw.fakeAudioFile === 'string')
      ? scenesRaw.fakeAudioFile
      : null;
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
  return {
    scenes,
    defaults,
    segments,
    segByIdx,
    timingsByTag,
    initialAuth,
    wideViewportB,
    sceneDrivenNarrowSwitch,
    grantMicrophone,
    fakeAudioFile,
  };
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
  // KS-4316: явный timeout 2с на boundingBox — иначе при отсутствии
  // доски (например, page оказалась на нешахматной странице) default
  // 30с зависает в фоне и log "boundingBox=null" вылетает спустя
  // 30 секунд, ломая диагностику.
  const pieceLoc = p.locator(`[data-square="${from}"] [data-piece]`).first();
  let f = await pieceLoc.boundingBox({ timeout: 2000 }).catch(() => null);
  if (!f)
    f = await p
      .locator(`[data-square="${from}"]`)
      .first()
      .boundingBox({ timeout: 2000 })
      .catch(() => null);
  const t = await p
    .locator(`[data-square="${to}"]`)
    .first()
    .boundingBox({ timeout: 2000 })
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
// KS-4065: react-chessboard v5 в задачах регистрирует ход кликом по
// клетке-источнику и кликом по целевой клетке (синтетический mouse-drag
// НЕ срабатывает). Используется для ввода ходов в puzzleSolve*.
async function clickMove(p, from, to) {
  await p
    .locator(`[data-square="${from}"]`)
    .first()
    .click({ timeout: 2000 })
    .catch(() => {});
  await p.waitForTimeout(350);
  await p
    .locator(`[data-square="${to}"]`)
    .first()
    .click({ timeout: 2000 })
    .catch(() => {});
  return true;
}

// ── Stockfish helpers (KS-4066, play-vs-engine) ─────────────────────
// Локальный Stockfish: bestmove или FEN после серии ходов. Точная игра
// (трекинг позиции через `position fen … moves …`) исключает ошибки
// реконструкции доски из DOM.
function stockfish(cmds, { wantFen = false, depth = 16, timeoutMs = 9000 } = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(STOCKFISH_BIN);
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const done = (v) => {
      resolve(v);
      try {
        proc.kill();
      } catch {}
    };
    proc.stdout.on('data', (d) => {
      out += d.toString();
      if (wantFen) {
        const m = out.match(/Fen:\s*(\S.+)/);
        if (m) done(m[1].trim());
      } else {
        const m = out.match(/bestmove\s+(\S+)/);
        if (m) done(m[1]);
      }
    });
    proc.on('error', () => done(null));
    proc.stdin.write(`uci\n${cmds}\n${wantFen ? 'd' : `go depth ${depth}`}\n`);
    setTimeout(() => done(null), timeoutMs);
  });
}
// placement-FEN → карта клетка→data-piece ("wN" и т.п.)
function fenToOcc(fen) {
  const o = {};
  const rows = (fen || '').split(' ')[0].split('/');
  const inv = {
    P: 'wP', N: 'wN', B: 'wB', R: 'wR', Q: 'wQ', K: 'wK',
    p: 'bP', n: 'bN', b: 'bB', r: 'bR', q: 'bQ', k: 'bK',
  };
  for (let r = 0; r < 8 && r < rows.length; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) f += +ch;
      else {
        o[`${'abcdefgh'[f]}${8 - r}`] = inv[ch];
        f++;
      }
    }
  }
  return o;
}
// UCI-ход по разнице двух раскладов (from — фигура ушла, to — появилась/сменилась)
function diffMove(before, after) {
  let from = null;
  let to = null;
  for (const sq of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[sq];
    const a = after[sq];
    if (b && !a) from = sq;
    else if (a && a !== b) to = sq;
  }
  return from && to ? from + to : null;
}
// текущий расклад доски из DOM
const boardOcc = (page) =>
  page.evaluate(() => {
    const o = {};
    document.querySelectorAll('[data-square]').forEach((s) => {
      const pc = s.querySelector('[data-piece]');
      if (pc) o[s.getAttribute('data-square')] = pc.getAttribute('data-piece');
    });
    return o;
  });
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

// ── v2 main (legacy: одна Playwright-сессия на весь сценарий) ──────
// Pipeline v3 запускает эту функцию per chain (через subprocess
// с временным KEY=<KEY>__<chainId>): см. runV3() ниже.
async function runV2() {
  log(`KEY=${KEY} DIR=${DIR}`);
  const { chromium } = await loadPlaywright();
  const {
    scenes,
    defaults,
    segByIdx,
    timingsByTag,
    initialAuth,
    wideViewportB,
    sceneDrivenNarrowSwitch,
    grantMicrophone,
    fakeAudioFile,
  } = await loadInputs();
  const mergedDefaults = { ...META_DEFAULTS, ...defaults };
  log(`initialAuth=${initialAuth}`);
  if (wideViewportB) log('wideViewportB=true → B1 поднимется 1920×1200');
  if (sceneDrivenNarrowSwitch)
    log('sceneDrivenNarrowSwitch=true → narrow переключение без /game/:id');
  if (grantMicrophone.length)
    log(`grantMicrophone=[${grantMicrophone.join(',')}]`);
  if (fakeAudioFile) log(`fakeAudioFile=${fakeAudioFile}`);

  // авторизация двух юзеров
  const ts = Date.now();
  // KS-4094/KS-4066: фиксированный dev-bypass пользователь для записи через
  // env KS_RECORD_USER — нужен, когда данные засеяны заранее (seed-precision-
  // history) под конкретный аккаунт. Без override — прежнее поведение
  // (уникальный пользователь на прогон).
  const userA = process.env.KS_RECORD_USER || `${KEY.toLowerCase()}a-${ts}`;
  const userB = process.env.KS_RECORD_USER_B || `${KEY.toLowerCase()}b-${ts}`;
  log('dev-bypass…');
  const [authA, authB] = await Promise.all([bypass(userA), bypass(userB)]);
  const uidA = uidFromJwt(authA.accessToken);
  const uidB = uidFromJwt(authB.accessToken);
  log(`auth A=${userA} uid=${uidA}, B=${userB} uid=${uidB}`);

  // ── browser + 4 контекста параллельно (recordVideo синхронно) ─
  // KS-4316: если сценарий просил подменить микрофон (lecture-publisher),
  // подкидываем Chromium-флаги для fake media. Безвредны для сценариев,
  // не использующих getUserMedia (KS-4055..4066 не используют).
  const launchArgs = [];
  if (grantMicrophone.length || fakeAudioFile) {
    launchArgs.push(
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    );
    if (fakeAudioFile) {
      launchArgs.push(`--use-file-for-fake-audio-capture=${fakeAudioFile}`);
    }
  }
  const browser = await chromium.launch({
    headless: args.headless,
    executablePath: CHROME,
    ...(launchArgs.length ? { args: launchArgs } : {}),
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
  // KS-4316: B1 поднимается wide-viewport'ом для сценариев с независимым
  // wide-контекстом зрителя (single-viewer сцены в D1).
  const viewportB1 = wideViewportB ? VIEWPORT_WIDE : VIEWPORT_NARROW;
  log('creating 4 contexts in parallel…');
  const [ctxA1, ctxB1, ctxA2, ctxB2] = await Promise.all([
    mkContext(authA, dirA1, VIEWPORT_WIDE, 'A1', a1WithAuth),
    mkContext(authB, dirB1, viewportB1, 'B1'),
    mkContext(authA, dirA2, VIEWPORT_NARROW, 'A2'),
    mkContext(authB, dirB2, VIEWPORT_NARROW, 'B2'),
  ]);
  // KS-4316: разрешаем микрофон сторонам, перечисленным в grantMicrophone.
  // 'A' → ctxA1 + ctxA2, 'B' → ctxB1 + ctxB2 (в любой момент сцены сторона
  // может оказаться либо в wide, либо в narrow контексте).
  if (grantMicrophone.includes('A')) {
    await Promise.all([
      ctxA1.grantPermissions(['microphone'], { origin: WEB }),
      ctxA2.grantPermissions(['microphone'], { origin: WEB }),
    ]);
    log('granted microphone to ctxA1+ctxA2');
  }
  if (grantMicrophone.includes('B')) {
    await Promise.all([
      ctxB1.grantPermissions(['microphone'], { origin: WEB }),
      ctxB2.grantPermissions(['microphone'], { origin: WEB }),
    ]);
    log('granted microphone to ctxB1+ctxB2');
  }
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
    analysisId: null,
    // KS-4316 / ASSERT-режим: id и slug запущенной live-лекции,
    // нужны для подстановки в URL зрителя `/live/${LECTURE_SLUG}`
    // и `/lectures/${LECTURE_ID}`. Захват — metaAction
    // `captureLectureSlug` (читает /lectures/:id, берёт liveAnalysis.slug).
    lectureId: null,
    lectureSlug: null,
  };

  // Подстановка плейсхолдеров в URL (например, `${ANALYSIS_ID}`).
  function expandUrl(url) {
    if (!url) return url;
    return url
      .replace('${WEB}', WEB)
      .replace('${ANALYSIS_ID}', gameState.analysisId || '')
      .replace('${LECTURE_SLUG}', gameState.lectureSlug || '')
      .replace('${LECTURE_ID}', gameState.lectureId || '');
  }

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
          if (target) {
            await target.click({ timeout: 2000, force: action.force ?? false }).catch(() => {});
            if (action.waitForSelector) {
              await page
                .waitForSelector(action.waitForSelector, {
                  timeout: action.waitForSelectorTimeoutMs || 2500,
                })
                .catch(() => {});
            } else if (action.waitMsAfter) {
              await page.waitForTimeout(action.waitMsAfter);
            }
          }
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
        case 'puzzleSolveCorrect': {
          // На странице /puzzle/:id — берёт moves[0] и делает первый
          // правильный ход. Side берётся из FEN.
          const u = page.url();
          const mm = u.match(/\/puzzle\/([^/?]+)/);
          if (!mm) {
            log(`puzzleSolveCorrect: not on /puzzle URL=${u}`);
            break;
          }
          const pid = mm[1];
          const token = action.authToken || authA.accessToken;
          try {
            const r = await fetch(`${API}/puzzles/${pid}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!r.ok) {
              log(`puzzleSolveCorrect: GET /puzzles/${pid} → ${r.status}`);
              break;
            }
            const data = await r.json();
            const moves = data.moves || [];
            // KS-4065: в lichess-задачах moves[0] — это ход, который приложение
            // ПРОИГРЫВАЕТ САМО (предыдущий ход, ставящий позицию), а решатель
            // вводит moves[1]. Определяем по доске: если moves[0] уже сделан
            // (его from пуст, to занят) — играем moves[1]; иначе moves[0]
            // (локальные задачи без автохода).
            let idx = 0;
            const m0 = moves[0] || '';
            if (m0.length >= 4) {
              const f0 = m0.slice(0, 2);
              const t0 = m0.slice(2, 4);
              const alreadyPlayed = await page.evaluate(
                ({ f0, t0 }) => {
                  const fromEmpty = !document.querySelector(
                    `[data-square="${f0}"] [data-piece]`,
                  );
                  const toFilled = !!document.querySelector(
                    `[data-square="${t0}"] [data-piece]`,
                  );
                  return fromEmpty && toFilled;
                },
                { f0, t0 },
              );
              if (alreadyPlayed) idx = 1;
            }
            const move = moves[idx];
            if (!move || move.length < 4) {
              log(`puzzleSolveCorrect: no moves[${idx}] in puzzle ${pid}`);
              break;
            }
            log(
              `puzzleSolveCorrect ${pid}: solverIdx=${idx}, играю линию click-to-move`,
            );
            // Играем всю линию решателя (moves[idx], idx+2, ...): приложение
            // само отвечает за соперника, задача отмечается решённой — растут
            // «Серия»/«Решено» и рейтинг (это и показывает сегмент).
            for (let k = idx; k < moves.length; k += 2) {
              const mv = moves[k];
              if (!mv || mv.length < 4) break;
              await clickMove(page, mv.slice(0, 2), mv.slice(2, 4));
              await page.waitForTimeout(action.replyWaitMs ?? 800);
            }
          } catch (e) {
            log(`puzzleSolveCorrect failed: ${String(e).slice(0, 160)}`);
          }
          break;
        }
        case 'puzzleSolveWrong': {
          // На /puzzle/:id — делает заведомо неверный ход. Через DOM
          // ищет первую пешку своей стороны (по FEN side), которая НЕ
          // участвует в корректном ходе, и двигает её на одну клетку вперёд.
          const u = page.url();
          const mm = u.match(/\/puzzle\/([^/?]+)/);
          if (!mm) {
            log(`puzzleSolveWrong: not on /puzzle URL=${u}`);
            break;
          }
          const pid = mm[1];
          const token = action.authToken || authA.accessToken;
          try {
            const r = await fetch(`${API}/puzzles/${pid}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!r.ok) {
              log(`puzzleSolveWrong: GET /puzzles/${pid} → ${r.status}`);
              break;
            }
            const data = await r.json();
            const moves = data.moves || [];
            const fen = data.fen || '';
            // KS-4065: как в puzzleSolveCorrect — определяем, сыгран ли уже
            // автоход moves[0]. Если да, очередь решателя (сторона
            // противоположна FEN-стороне), его правильный ход — moves[1].
            let idx = 0;
            const m0w = moves[0] || '';
            if (m0w.length >= 4) {
              const f0 = m0w.slice(0, 2);
              const t0 = m0w.slice(2, 4);
              const alreadyPlayed = await page.evaluate(
                ({ f0, t0 }) => {
                  const fromEmpty = !document.querySelector(
                    `[data-square="${f0}"] [data-piece]`,
                  );
                  const toFilled = !!document.querySelector(
                    `[data-square="${t0}"] [data-piece]`,
                  );
                  return fromEmpty && toFilled;
                },
                { f0, t0 },
              );
              if (alreadyPlayed) idx = 1;
            }
            const correctFrom = (moves[idx] || '').slice(0, 2);
            // Сторона решателя = цвет фигуры на from-клетке его правильного
            // хода (надёжнее, чем математика по FEN: учитывает реальное
            // состояние доски после автохода). data-piece формата "wP"/"bN".
            let side = fen.split(' ')[1] || 'w';
            if (correctFrom) {
              const pc = await page.evaluate((sq) => {
                const el = document.querySelector(
                  `[data-square="${sq}"] [data-piece]`,
                );
                return el ? el.getAttribute('data-piece') : null;
              }, correctFrom);
              if (pc && (pc[0] === 'w' || pc[0] === 'b')) side = pc[0];
            }
            // Найти первую пешку нашей стороны (не совпадающую с правильным
            // from-полем) и сходить +1 ряд.
            const target = await page.evaluate(
              ({ side, correctFrom }) => {
                const occ = (sq) =>
                  !!document.querySelector(`[data-square="${sq}"] [data-piece]`);
                const squares = document.querySelectorAll('[data-square]');
                for (const sq of squares) {
                  const code = sq.getAttribute('data-square');
                  if (code === correctFrom) continue;
                  const piece = sq.querySelector('[data-piece]');
                  if (!piece) continue;
                  const dp = piece.getAttribute('data-piece') || '';
                  // Формат "wP" / "bP" / "wQ" и т.п.
                  const isPawn =
                    (side === 'w' && dp === 'wP') ||
                    (side === 'b' && dp === 'bP');
                  if (!isPawn) continue;
                  const file = code[0];
                  const rank = parseInt(code[1], 10);
                  const fwd = `${file}${side === 'w' ? rank + 1 : rank - 1}`;
                  // только если клетка впереди пуста → ход пешкой легален
                  if (!occ(fwd)) return code;
                }
                return null;
              },
              { side, correctFrom },
            );
            if (!target) {
              log(
                `puzzleSolveWrong: не нашёл пешку (side=${side}) на доске`,
              );
              break;
            }
            const file = target[0];
            const rank = parseInt(target[1], 10);
            const toRank = side === 'w' ? rank + 1 : rank - 1;
            const to = `${file}${toRank}`;
            log(`puzzleSolveWrong ${pid}: click ${target}→${to} (intentional bad)`);
            await clickMove(page, target, to);
          } catch (e) {
            log(`puzzleSolveWrong failed: ${String(e).slice(0, 160)}`);
          }
          break;
        }
        case 'playVsEngine': {
          // KS-4066: ведёт play-vs-engine попытку точной игрой Stockfish.
          // Стартовый FEN задачи берём из /puzzles/:id; играем лучшие ходы,
          // ответ движка распознаём диффом доски против FEN от Stockfish.
          // Для наглядного успеха (5★/100%) сцена должна открывать задачу с
          // явным перевесом решающего (convertAdvantage) — на острых позициях
          // локальный SF может расходиться с движком раннера.
          const u = page.url();
          const mm = u.match(/\/puzzle\/([^/?]+)/);
          if (!mm) {
            log(`playVsEngine: not on /puzzle URL=${u}`);
            break;
          }
          const pid = mm[1];
          const token = action.authToken || authA.accessToken;
          const depth = action.depth ?? 14;
          const maxMy = action.maxMyMoves ?? 6;
          const replyWaitMs = action.replyWaitMs ?? 2200;
          const stepPauseMs = action.stepPauseMs ?? 700;
          try {
            const r = await fetch(`${API}/puzzles/${pid}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!r.ok) {
              log(`playVsEngine: GET /puzzles/${pid} → ${r.status}`);
              break;
            }
            const data = await r.json();
            const startFen = data.fen;
            if (!startFen) {
              log(`playVsEngine: нет fen в задаче ${pid}`);
              break;
            }
            const moves = [];
            for (let i = 0; i < maxMy; i++) {
              await page.waitForTimeout(stepPauseMs);
              const myMove = await stockfish(
                `position fen ${startFen} moves ${moves.join(' ')}`,
                { depth },
              );
              if (!myMove || myMove === '(none)' || myMove.length < 4) break;
              log(`playVsEngine ${pid}: ход ${i + 1} ${myMove}`);
              await clickMove(page, myMove.slice(0, 2), myMove.slice(2, 4));
              moves.push(myMove);
              const expFen = await stockfish(
                `position fen ${startFen} moves ${moves.join(' ')}`,
                { wantFen: true },
              );
              const expOcc = fenToOcc(expFen);
              // Опрашиваем доску до ФАКТИЧЕСКОГО ответа движка вместо
              // фиксированной паузы: время раздумий движка варьируется, и
              // фиксированный wait то срабатывал до ответа, то после —
              // ходы расходились, точность скакала (97% против 58%).
              await page.waitForTimeout(action.myMoveSettleMs ?? 500);
              let eng = null;
              let finished = false;
              const deadline = Date.now() + (action.replyTimeoutMs ?? 6000);
              while (Date.now() < deadline) {
                finished = await page.evaluate(() =>
                  /Точность:\s*\d+%/.test(document.body.innerText),
                );
                if (finished) break;
                eng = diffMove(expOcc, await boardOcc(page));
                if (eng) break;
                await page.waitForTimeout(300);
              }
              if (finished) {
                log(`playVsEngine ${pid}: попытка завершена (ход ${i + 1})`);
                break;
              }
              if (eng) moves.push(eng);
              else
                log(
                  `playVsEngine ${pid}: ответ движка не распознан (ход ${i + 1})`,
                );
            }
          } catch (e) {
            log(`playVsEngine failed: ${String(e).slice(0, 160)}`);
          }
          break;
        }
        case 'generatePuzzles': {
          // KS-4066: запускает клиентскую генерацию (Stockfish WASM из PGN) и
          // ждёт результата «Сгенерировано задач: N». Долгое действие (свой
          // потолок в цикле диспатча). PGN вставляется заранее (type-action).
          try {
            await page
              .locator("button:has-text('Сгенерировать задачи')")
              .first()
              .click({ timeout: 3000 })
              .catch(() => {});
            const maxMs = action.maxMs ?? 150000;
            const deadline = Date.now() + maxMs;
            let n = null;
            while (Date.now() < deadline) {
              await page.waitForTimeout(1500);
              n = await page.evaluate(
                () =>
                  (document.body.innerText.match(
                    /Сгенерировано задач:\s*(\d+)/,
                  ) || [])[1] || null,
              );
              if (n != null) break;
            }
            log(`generatePuzzles: сгенерировано ${n ?? '—'}`);
            // KS-4066: после результата — «Сохранить на сервер» и задержка на
            // подтверждении «N сохранено как черновики» (синхронно с диктором
            // «сохраняются как черновики»). На «Мои черновики» НЕ переходим:
            // страница черновиков ломается при включённом прокси каталога
            // (черновики локальные, /puzzles/browse идёт на прод → «Не удалось
            // загрузить»). Подтверждающая модалка покрывает текст сегмента.
            if (n != null) {
              await page.waitForTimeout(action.beforeSaveMs ?? 1200);
              await page
                .locator("button:has-text('Сохранить на сервер')")
                .first()
                .click({ timeout: 3000 })
                .catch(() => {});
              const saveDeadline = Date.now() + (action.saveTimeoutMs ?? 15000);
              while (Date.now() < saveDeadline) {
                await page.waitForTimeout(1000);
                const saved = await page.evaluate(() =>
                  /сохранено как черновики/i.test(document.body.innerText),
                );
                if (saved) break;
              }
              log('generatePuzzles: сохранено как черновики');
              await page.waitForTimeout(action.afterSaveMs ?? 1500);
              // KS-4066: переход в «Мои черновики» — показать сохранённые
              // черновики (прокси-фикс backend 471b7262: user-scoped browse
              // обслуживается локально). Кнопка модалки = точный текст без
              // счётчика (вкладка каталога — «Мои черновики (N)»).
              await page
                .locator('button:text-is("Мои черновики")')
                .first()
                .click({ timeout: 3000 })
                .catch(() => {});
              await page.waitForSelector('text=/Мои черновики \\(/', {
                timeout: 6000,
              }).catch(() => {});
              await page.waitForTimeout(action.dwellMs ?? 5000);
              log('generatePuzzles: открыты Мои черновики');
            }
          } catch (e) {
            log(`generatePuzzles failed: ${String(e).slice(0, 160)}`);
          }
          break;
        }
        case 'setInputFiles': {
          // Для скрытого <input type=file>. action.file (строка) или
          // action.files (массив строк) — пути к локальным файлам.
          if (!target) break;
          const files = action.files || (action.file ? [action.file] : []);
          if (!files.length) {
            log(`WARN: setInputFiles без file/files — skip`);
            break;
          }
          await target
            .setInputFiles(files, { timeout: 2000 })
            .catch((e) => log(`setInputFiles err: ${String(e).slice(0, 120)}`));
          break;
        }
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
      // ASSERT после успешного выполнения действия.
      if (action.assert !== undefined) {
        await runAssert({
          assertSpec: action.assert,
          pageA, pageB,
          label: ctx?.stepLabel || `action.${action.type}`,
          sceneIdx: ctx?.sceneIdx,
          sceneTag: ctx?.sceneTag,
          attempt: ctx?.attempt,
          step: ctx?.stepLabel || `action.${action.type}`,
        });
      }
    } catch (e) {
      if (e instanceof SceneFailError) throw e;
      log(`action ${action.type} ${sel || ''} failed: ${String(e).slice(0, 120)}`);
      if (action.assert !== undefined && action.assert !== 'decorative') {
        throw new SceneFailError(
          `action "${action.type}" threw before assert: ` +
            String(e).slice(0, 200),
          { sceneIdx: ctx?.sceneIdx, step: ctx?.stepLabel },
        );
      }
    }
  }

  // ── meta-action dispatcher ────────────────────────────────────
  async function runMetaActions(scene, ctx = {}) {
    const metas = scene.metaActions || [];
    let _stepI = -1;
    for (const m of metas) {
      _stepI += 1;
      const _stepLabel = `meta[${_stepI}].${m.type}`;
      const side = m.side || 'A';
      const page = side === 'B' ? pageB : pageA;
      try {
        switch (m.type) {
          case 'goto': {
            const url = expandUrl(m.url || '');
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
          case 'pageClick': {
            // Простой клик по селектору на нужной стороне в metaActions
            // фазе (т.е. до фиксации sceneStartMs). Нужен, чтобы тихо
            // подготовить state UI до того, как зритель увидит сцену.
            const sides = m.sides || [side];
            for (const sd of sides) {
              const p = sd === 'B' ? pageB : pageA;
              try {
                await p
                  .locator(m.selector)
                  .first()
                  .click({ timeout: m.timeoutMs || 2000 });
              } catch (e) {
                log(`pageClick ${m.selector} (${sd}) failed: ${String(e).slice(0, 100)}`);
              }
            }
            break;
          }
          case 'gotoPrecisionAttempt': {
            // KS-4066: переход на разбор ВАЛИДНОЙ попытки precision
            // (halfMovesPlayed>0). Клик по первой строке истории может
            // попасть на пустую legacy-запись, чья detail-страница «не найдена».
            const token = m.authToken || authA.accessToken;
            try {
              const r = await fetch(
                `${API}/precision/attempts/me?limit=20&offset=0`,
                { headers: { Authorization: `Bearer ${token}` } },
              );
              const body = await r.json();
              const items = Array.isArray(body)
                ? body
                : body.items || body.data || [];
              const valid = items.find(
                (a) => (a.halfMovesPlayed || 0) > 0 && (a.attemptId || a.id),
              );
              if (!valid) {
                log(`gotoPrecisionAttempt: нет валидной попытки`);
                break;
              }
              const aid = valid.attemptId || valid.id;
              await pageA.goto(`${WEB}/precision/attempts/${aid}`, {
                waitUntil: 'domcontentloaded',
              });
              await pageA.waitForTimeout(m.waitMsAfter ?? 1800);
              log(
                `gotoPrecisionAttempt → ${aid} (acc ${valid.accuracyPercent}%)`,
              );
            } catch (e) {
              log(`gotoPrecisionAttempt failed: ${String(e).slice(0, 160)}`);
            }
            break;
          }
          case 'gotoNextPuzzle': {
            // Берёт случайную задачу из /puzzles?limit=20 и переходит
            // на её /puzzle/<id>. Опционально пропускает skipIds (массив).
            const token = m.authToken || authA.accessToken;
            try {
              // KS-4065: на dev каталог проксируется на прод через
              // /puzzles/browse, и /puzzles/:id тоже идёт на прод. Непроксируемый
              // /puzzles?limit=20 отдаёт локальные id, которых нет на проде →
              // последующий GET /puzzles/:id даёт 503. Берём пул из browse.
              const r = await fetch(`${API}/puzzles/browse?limit=20&source=lichess`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              const body = await r.json();
              const pool = Array.isArray(body) ? body : (body.data || []);
              if (!pool.length) {
                log(`gotoNextPuzzle: пустой пул`);
                break;
              }
              const skip = new Set(m.skipIds || []);
              // KS-4065: пропускаем задачу, открытую в текущем URL, чтобы
              // solve-wrong не взял ту же позицию, что и solve-correct.
              const curId = (page.url().match(/\/puzzle\/([^/?]+)/) || [])[1];
              if (curId) skip.add(curId);
              const pick = pool.find((p) => !skip.has(p.id)) || pool[0];
              const url = `${WEB}/puzzle/${pick.id}`;
              await page.goto(url, { waitUntil: 'domcontentloaded' });
              await page.waitForTimeout(m.waitMsAfter ?? 1500);
              log(`gotoNextPuzzle → ${pick.id}`);
            } catch (e) {
              log(`gotoNextPuzzle failed: ${String(e).slice(0, 200)}`);
            }
            break;
          }
          case 'seedPuzzleAttempts': {
            // Сидирует историю решённых/неверных попыток у пользователя A.
            // m.solved (по умолчанию 3) и m.failed (по умолчанию 1) —
            // сколько успешных и провальных попыток создать (на разных
            // случайных задачах из базы).
            const token = m.authToken || authA.accessToken;
            const solvedCount = m.solved ?? 3;
            const failedCount = m.failed ?? 1;
            let okSolved = 0,
              okFailed = 0;
            try {
              // Берём пул задач с разнообразием
              const pool = await fetch(`${API}/puzzles?limit=20`, {
                headers: { Authorization: `Bearer ${token}` },
              }).then((r) => r.json());
              if (!Array.isArray(pool) || !pool.length) {
                log(`seedPuzzleAttempts: пул задач пуст`);
                break;
              }
              let i = 0;
              for (let n = 0; n < solvedCount && i < pool.length; n++, i++) {
                const pid = pool[i].id;
                const r = await fetch(`${API}/puzzles/${pid}/attempt`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                  },
                  body: JSON.stringify({
                    result: 'solved',
                    timeMs: 12000 + Math.floor(Math.random() * 8000),
                    moveCount: 2,
                  }),
                });
                if (r.ok) okSolved += 1;
              }
              for (let n = 0; n < failedCount && i < pool.length; n++, i++) {
                const pid = pool[i].id;
                const r = await fetch(`${API}/puzzles/${pid}/attempt`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                  },
                  body: JSON.stringify({
                    result: 'failed',
                    timeMs: 30000 + Math.floor(Math.random() * 15000),
                    moveCount: 1,
                  }),
                });
                if (r.ok) okFailed += 1;
              }
              log(
                `seedPuzzleAttempts → solved=${okSolved}/${solvedCount} failed=${okFailed}/${failedCount}`,
              );
            } catch (e) {
              log(`seedPuzzleAttempts failed: ${String(e).slice(0, 200)}`);
            }
            break;
          }
          case 'setExternalAccounts': {
            // PATCH /users/me/external-accounts — выставляет username'ы
            // chess.com / lichess у текущего пользователя A. Нужен для
            // показа кнопок «Импорт chess.com» / «Импорт lichess» в UI.
            const token = m.authToken || authA.accessToken;
            const body = {
              chesscomUsername: m.chesscomUsername ?? null,
              lichessUsername: m.lichessUsername ?? null,
            };
            try {
              const r = await fetch(`${API}/users/me/external-accounts`, {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(body),
              });
              log(
                `setExternalAccounts → ${r.status} (chess=${body.chesscomUsername} lichess=${body.lichessUsername})`,
              );
            } catch (e) {
              log(`setExternalAccounts failed: ${String(e).slice(0, 200)}`);
            }
            break;
          }
          case 'seedAnalyses': {
            // Массово создаёт анализы у пользователя A.
            // m.items: [{pgnFile, title, category, tags: string[]}].
            // После POST /analyses (id), если заданы tags, делает
            // PATCH /analyses/:id {tags: [...]}.
            const token = m.authToken || authA.accessToken;
            const items = Array.isArray(m.items) ? m.items : [];
            let okCount = 0;
            for (const it of items) {
              try {
                let pgn = it.pgn || '';
                if (!pgn && it.pgnFile) {
                  pgn = await fs.readFile(it.pgnFile, 'utf-8');
                }
                if (!pgn) {
                  log(`seedAnalyses: skip (no pgn) — ${it.title || '?'}`);
                  continue;
                }
                const postBody = {
                  title: it.title || 'Auto analysis',
                  pgn,
                  ...(it.category ? { category: it.category } : {}),
                };
                const rPost = await fetch(`${API}/analyses`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                  },
                  body: JSON.stringify(postBody),
                });
                if (!rPost.ok) {
                  const t = await rPost.text().catch(() => '');
                  throw new Error(`POST HTTP ${rPost.status} ${t.slice(0, 160)}`);
                }
                const created = await rPost.json();
                if (Array.isArray(it.tags) && it.tags.length) {
                  await fetch(`${API}/analyses/${created.id}`, {
                    method: 'PATCH',
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify({ tags: it.tags }),
                  }).catch(() => {});
                }
                okCount += 1;
                log(`seedAnalyses ${okCount}/${items.length}: ${it.title}`);
              } catch (e) {
                log(`seedAnalyses item failed: ${String(e).slice(0, 200)}`);
              }
            }
            log(`seedAnalyses → создано ${okCount}/${items.length}`);
            break;
          }
          case 'createAnalysisFromPgn': {
            // Создаёт запись анализа на API из PGN-файла или строки PGN.
            // Сохраняет id в gameState.analysisId; дальше можно использовать
            // ${ANALYSIS_ID} в URL последующих metaAction.goto.
            // Поля: pgnFile (путь к .pgn) или pgn (строка); title (опц.);
            //       authToken — по умолчанию accessToken пользователя A.
            let pgnText = m.pgn || '';
            if (!pgnText && m.pgnFile) {
              try {
                pgnText = await fs.readFile(m.pgnFile, 'utf-8');
              } catch (e) {
                log(`WARN: cannot read pgnFile ${m.pgnFile}: ${e.message}`);
                break;
              }
            }
            if (!pgnText) {
              log(`WARN: createAnalysisFromPgn без pgn/pgnFile, skip`);
              break;
            }
            const token = m.authToken || authA.accessToken;
            try {
              const r = await fetch(`${API}/analyses`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                  pgn: pgnText,
                  title: m.title || 'Auto analysis',
                }),
              });
              if (!r.ok) {
                const t = await r.text().catch(() => '');
                throw new Error(
                  `HTTP ${r.status} ${t.slice(0, 200)}`,
                );
              }
              const data = await r.json();
              gameState.analysisId = data.id;
              log(`createAnalysisFromPgn → id=${data.id}`);
            } catch (e) {
              log(`createAnalysisFromPgn failed: ${String(e).slice(0, 200)}`);
            }
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
          case 'ensureLectureLive': {
            // KS-4316: гарантирует перевод лекции в `live` через
            // POST /lectures/:id/start {analysisId}. Используется как
            // safety net после UI-сабмита в `CreateLectureModal`: если
            // submit-click не сработал (page-exception, гонка с
            // navigation, etc.), API-вызов идемпотентно завершает запуск.
            // Endpoint идемпотентен — для уже live-лекций просто
            // возвращает текущую запись.
            const lectureId = (m.lectureId || '').trim();
            const analysisId = (m.analysisId || '').trim();
            if (!lectureId || !analysisId) {
              log(`ensureLectureLive: пустой lectureId/analysisId — skip`);
              break;
            }
            const token = m.authToken
              || (m.side === 'B' ? authB.accessToken : authA.accessToken);
            try {
              const r = await fetch(
                `${API}/lectures/${encodeURIComponent(lectureId)}/start`,
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                  },
                  body: JSON.stringify({ analysisId }),
                },
              );
              if (!r.ok) {
                const t = await r.text().catch(() => '');
                log(
                  `ensureLectureLive HTTP ${r.status} ${t.slice(0, 160)}`,
                );
              } else {
                log(`ensureLectureLive ${lectureId} → live`);
              }
              await pageA.waitForTimeout(m.waitMsAfter ?? 800);
            } catch (e) {
              log(`ensureLectureLive failed: ${String(e).slice(0, 160)}`);
            }
            break;
          }
          case 'captureLectureSlug': {
            // KS-4316 / ASSERT-режим: читает `/lectures/:id` через REST
            // и сохраняет `liveAnalysis.slug` + сам `id` в gameState.
            // Зрительские сцены позже используют `${LECTURE_SLUG}` и
            // `${LECTURE_ID}` в URL (например, `/live/${LECTURE_SLUG}`).
            const lectureId = (m.lectureId || '').trim();
            if (!lectureId) {
              log(`captureLectureSlug: пустой lectureId — skip`);
              break;
            }
            const token = m.authToken
              || (m.side === 'B' ? authB.accessToken : authA.accessToken);
            try {
              const r = await fetch(
                `${API}/lectures/${encodeURIComponent(lectureId)}`,
                {
                  headers: { Authorization: `Bearer ${token}` },
                },
              );
              if (!r.ok) {
                const t = await r.text().catch(() => '');
                log(
                  `captureLectureSlug HTTP ${r.status} ${t.slice(0, 160)}`,
                );
                break;
              }
              const data = await r.json();
              const slug = data?.liveAnalysis?.slug || null;
              gameState.lectureId = lectureId;
              gameState.lectureSlug = slug;
              log(
                `captureLectureSlug ${lectureId} → slug=${slug || '<null>'}`,
              );
            } catch (e) {
              log(`captureLectureSlug failed: ${String(e).slice(0, 160)}`);
            }
            break;
          }
          case 'forceEndLecture': {
            // KS-4316: POST /lectures/:id/force-end под токеном текущего
            // owner'а (по умолчанию — authA / coach). Используется когда
            // UI-кнопка `lecture-publisher-close` недоступна (например,
            // запись MediaRecorder не запустилась в headless fake-audio,
            // и `isRecording=false` → close-кнопки нет в DOM), но в
            // сценарии лекция должна перейти в `recorded`, чтобы
            // дальнейшие сцены (replay, recorded-cta) сработали.
            //
            // Fallback: если переданный lectureId не в `live`-статусе
            // (например, сценарий сделал submit под другой лекцией —
            // create-new режим вместо bind), ищем любую live-лекцию
            // текущего owner'а через GET /lectures и завершаем её.
            const token = m.authToken
              || (m.side === 'B' ? authB.accessToken : authA.accessToken);
            const tryForceEnd = async (lid) => {
              if (!lid) return { ok: false, code: 0 };
              const r = await fetch(
                `${API}/lectures/${encodeURIComponent(lid)}/force-end`,
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                  },
                },
              );
              return { ok: r.ok, code: r.status };
            };
            try {
              const lectureId = (m.lectureId || '').trim();
              let result = await tryForceEnd(lectureId);
              if (!result.ok) {
                // KS-4316: при любом не-ok ищем live-лекцию owner'а
                // (403 = owner у переданного id не совпал; 404 = лекции нет;
                // 409 = статус неподходящий; 0 = сеть). Логируем код прямой
                // попытки, потом пробуем fallback.
                log(`forceEndLecture direct HTTP ${result.code} → fallback`);
                // ищем live-лекцию owner'а
                const list = await fetch(
                  `${API}/my/lectures?status=live`,
                  { headers: { Authorization: `Bearer ${token}` } },
                ).then((r) => (r.ok ? r.json() : null)).catch(() => null);
                const items = list?.items
                  || (Array.isArray(list) ? list : []);
                const live = items.find((l) => l.status === 'live');
                if (live?.id) {
                  log(
                    `forceEndLecture fallback: ${lectureId || '<empty>'} → ` +
                      `${live.id}`,
                  );
                  result = await tryForceEnd(live.id);
                  if (result.ok) {
                    log(`forceEndLecture ${live.id} → recorded`);
                  } else {
                    log(`forceEndLecture fallback HTTP ${result.code}`);
                  }
                } else {
                  log(`forceEndLecture: live-лекций owner'а не найдено`);
                }
              } else if (result.ok) {
                log(`forceEndLecture ${lectureId} → recorded`);
              } else {
                log(`forceEndLecture HTTP ${result.code}`);
              }
              await pageA.waitForTimeout(m.waitMsAfter ?? 800);
            } catch (e) {
              log(`forceEndLecture failed: ${String(e).slice(0, 160)}`);
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
          case 'setLocalStorage': {
            // KS-4280 (content): прямая запись localStorage перед сценой.
            // Аккордеоны Kingside хранят состояние в `ks:analysis-sidebar:collapsed`
            // — клики по headers иногда не успевают примениться к React-state
            // при `recordVideo` (расходится с интерактивной средой). Запись
            // напрямую + reload даёт точное состояние без race conditions.
            // Поля: key, value (JSON-стрингифицируется автоматически если object),
            // reload (default true) — перезагружает страницу после установки.
            const sides = m.sides || [side];
            for (const sd of sides) {
              const p = sd === 'B' ? pageB : pageA;
              try {
                const valueStr =
                  typeof m.value === 'string' ? m.value : JSON.stringify(m.value);
                await p.evaluate(
                  ([k, v]) => window.localStorage.setItem(k, v),
                  [m.key, valueStr],
                );
                log(`setLocalStorage: ${m.key} = ${valueStr.slice(0, 80)}`);
                if (m.reload !== false) {
                  await p.reload({ waitUntil: 'load' });
                  await p.waitForTimeout(m.waitMsAfter ?? 1200);
                } else {
                  await p.waitForTimeout(m.waitMsAfter ?? 200);
                }
              } catch (e) {
                log(`setLocalStorage ${m.key} failed: ${String(e).slice(0, 120)}`);
              }
            }
            break;
          }
          case 'click': {
            // KS-4280: поддержка click в metaActions (тихо подготовить state UI
            // до фиксации sceneStartMs). Отличие от pageClick — этот click
            // всегда force, без waitForSelector, со срабатыванием по первому
            // подходящему селектору. Для open/close модальных окон и меню.
            // KS-4280 (content): `repeat` — повторить N раз с тем же
            // waitMsAfter (например, прокрутка списка ходов вперёд).
            const sides = m.sides || [side];
            const repeat = Math.max(1, m.repeat || 1);
            for (const sd of sides) {
              const p = sd === 'B' ? pageB : pageA;
              for (let i = 0; i < repeat; i++) {
                try {
                  await p
                    .locator(m.selector)
                    .first()
                    .click({ timeout: m.timeoutMs || 2500, force: m.force ?? false })
                    .catch((e) => {
                      log(`meta click ${m.selector} failed: ${String(e).slice(0, 100)}`);
                    });
                  await p.waitForTimeout(m.waitMsAfter ?? 250);
                } catch (e) {
                  log(`meta click ${m.selector} error: ${String(e).slice(0, 100)}`);
                }
              }
            }
            break;
          }
          case 'ensureExpanded': {
            // KS-4280: раскрыть свёрнутый <details>-аккордеон, если ещё не
            // раскрыт. Селектор — на корневой контейнер панели; внутри
            // ожидается элемент-заголовок `.analysis-panel-header`, по
            // которому делается click для раскрытия.
            const sides = m.sides || [side];
            for (const sd of sides) {
              const p = sd === 'B' ? pageB : pageA;
              try {
                const root = await p.waitForSelector(m.selector, {
                  timeout: m.timeoutMs || 4000,
                });
                if (!root) {
                  log(`ensureExpanded: root not found ${m.selector}`);
                  continue;
                }
                const isCollapsed = await root.evaluate((el) => {
                  // считается «свёрнут» если у самого `<details>` нет open,
                  // либо элемент содержит маркер ▸ (свёрнут) вместо ▾.
                  if (el.tagName === 'DETAILS' && !el.open) return true;
                  const inner = el.querySelector('details');
                  if (inner && !inner.open) return true;
                  if (el.classList.contains('collapsed')) return true;
                  if (el.getAttribute('data-state') === 'collapsed') return true;
                  // KS-4280 (content): React-аккордеоны Kingside не используют
                  // <details> и не выставляют class/data-state. Маркер свёрнутости —
                  // символ ▸ в `.analysis-panel-chevron` или `.archive-tree-panel__chevron`.
                  // Дополнительная проверка: тело панели (`*-panel-body`) рендерится
                  // только при раскрытии — если есть chevron, но нет тела, panel collapsed.
                  const chev = el.querySelector(
                    '.analysis-panel-chevron, .archive-tree-panel__chevron',
                  );
                  if (chev) {
                    const t = (chev.textContent || '').trim();
                    if (t === '▸' /* ▸ */) return true;
                    const body = el.querySelector(
                      '.analysis-panel-body, .archive-tree-panel__body',
                    );
                    if (!body) return true;
                  }
                  return false;
                });
                if (!isCollapsed) {
                  log(`ensureExpanded: already expanded ${m.selector}`);
                  continue;
                }
                const header = await root.$(
                  '.analysis-panel-header, .archive-tree-panel__header, summary, [role="button"], button',
                );
                if (header) {
                  await header.click({ timeout: 1500 }).catch(() => {});
                  log(`ensureExpanded: clicked header for ${m.selector}`);
                } else {
                  // Fallback: клик по корневому элементу.
                  await root.click({ timeout: 1500 }).catch(() => {});
                  log(`ensureExpanded: clicked root for ${m.selector}`);
                }
                await p.waitForTimeout(m.waitMsAfter ?? 250);
              } catch (e) {
                log(`ensureExpanded ${m.selector} failed: ${String(e).slice(0, 120)}`);
              }
            }
            break;
          }
          case 'ensureCollapsed': {
            // KS-4280 (content): обратная пара ensureExpanded — если
            // панель раскрыта, кликнуть header для сворачивания. Признаки
            // «раскрыто»: есть тело `.analysis-panel-body`/`.archive-tree-panel__body`
            // ИЛИ chevron `▾`. Используется в сцене 9 (moves-review),
            // чтобы остальные панели не забивали место для списка ходов.
            const sides = m.sides || [side];
            for (const sd of sides) {
              const p = sd === 'B' ? pageB : pageA;
              try {
                const root = await p.waitForSelector(m.selector, {
                  timeout: m.timeoutMs || 4000,
                });
                if (!root) {
                  log(`ensureCollapsed: root not found ${m.selector}`);
                  continue;
                }
                const isExpanded = await root.evaluate((el) => {
                  if (el.tagName === 'DETAILS' && el.open) return true;
                  const inner = el.querySelector('details');
                  if (inner && inner.open) return true;
                  if (el.getAttribute('data-state') === 'expanded') return true;
                  const chev = el.querySelector(
                    '.analysis-panel-chevron, .archive-tree-panel__chevron',
                  );
                  if (chev) {
                    const t = (chev.textContent || '').trim();
                    if (t === '▾') return true;
                  }
                  const body = el.querySelector(
                    '.analysis-panel-body, .archive-tree-panel__body',
                  );
                  if (body) return true;
                  return false;
                });
                if (!isExpanded) {
                  log(`ensureCollapsed: already collapsed ${m.selector}`);
                  continue;
                }
                const header = await root.$(
                  '.analysis-panel-header, .archive-tree-panel__header, summary, [role="button"], button',
                );
                if (header) {
                  await header.click({ timeout: 1500 }).catch(() => {});
                  log(`ensureCollapsed: clicked header for ${m.selector}`);
                } else {
                  await root.click({ timeout: 1500 }).catch(() => {});
                  log(`ensureCollapsed: clicked root for ${m.selector}`);
                }
                await p.waitForTimeout(m.waitMsAfter ?? 250);
              } catch (e) {
                log(`ensureCollapsed ${m.selector} failed: ${String(e).slice(0, 120)}`);
              }
            }
            break;
          }
          case 'injectMockup':
          case 'updateMockup':
          case 'removeMockup': {
            // Накладные макеты запрещены в ASSERT-режиме: они рисуют
            // элементы поверх страницы, а реальная DOM-проверка по
            // селектору такого «фантома» проходит — но это обход.
            // Любое появление такого действия в сценарии — провал
            // конвейера на этапе исполнения сцены.
            throw new SceneFailError(
              `mockup actions are forbidden in ASSERT mode ` +
                `(metaAction "${m.type}", id "${m.mockupId || ''}"). ` +
                `Use a real component with a real data-testid instead.`,
            );
          }
          default:
            log(`WARN: unknown metaAction type "${m.type}" — skip`);
        }
        // ASSERT после успешного выполнения шага.
        // Декларация `assert` — обязательна для всех «продуктивных» шагов;
        // декоративное действие явно помечается строкой `"decorative"`.
        if (m.assert !== undefined) {
          await runAssert({
            assertSpec: m.assert,
            pageA, pageB,
            label: _stepLabel,
            sceneIdx: ctx.sceneIdx,
            sceneTag: ctx.sceneTag,
            attempt: ctx.attempt,
            step: _stepLabel,
          });
        }
      } catch (e) {
        if (e instanceof SceneFailError) throw e;
        log(`meta ${m.type} failed: ${String(e).slice(0, 120)}`);
        if (m.assert !== undefined && m.assert !== 'decorative') {
          throw new SceneFailError(
            `meta step "${_stepLabel}" threw before assert: ` +
              String(e).slice(0, 200),
            { sceneIdx: ctx.sceneIdx, step: _stepLabel },
          );
        }
      }
    }
  }

  // ── переход на узкие контексты (перед первой split-сценой) ────
  async function switchToNarrowContexts() {
    if (gameState.switchedToNarrow) return;
    // KS-4316: scene-driven режим — каждая split-сцена сама navigated через
    // metaActions.goto в свои URL'ы (например, тренер на /analysis/<id>,
    // зритель на /lectures/<id>). Авто-переход на /game/:uuid не нужен.
    if (sceneDrivenNarrowSwitch) {
      // KS-4316: A1/B1 НЕ закрываем — они нужны для последующих
      // single-coach / single-viewer сцен после split. Запись там
      // продолжается до самого конца, и build-track берёт нужные куски
      // по startMs/holdMs.
      log('switching to narrow A2/B2 (scene-driven, без auto-goto, A1/B1 не закрываем)…');
      pageA = pa2;
      pageB = pb2;
      // только wait fonts + dismiss onboarding на стартовых страницах
      // (которые остались с момента создания контекстов — about:blank).
      // Реальная навигация произойдёт в metaActions сцены.
      await Promise.all([
        waitForFonts(pa2).catch(() => {}),
        waitForFonts(pb2).catch(() => {}),
      ]);
      gameState.switchedToNarrow = true;
      return;
    }
    // Шахматный режим: оба контекста уходят на /game/:gameId одной партии.
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

  // ── откат состояния между попытками сцены ─────────────────────
  // Минимальный откат: нажать Escape на всех страницах, чтобы
  // закрылись модалки/всплывающие меню, и подождать стабилизацию.
  // Дополнительный откат (например, возврат лекции из live в
  // scheduled) — задача сценария: либо в metaActions сцены идёт
  // безопасный «привести state в нужный» шаг (например,
  // `ensureLectureLive` уже идемпотентен), либо сценарий не
  // полагается на иное.
  async function cleanupAfterFail() {
    for (const p of [pa1, pb1, pa2, pb2]) {
      try {
        await p.keyboard.press('Escape');
      } catch {}
    }
    try {
      await pa1.waitForTimeout(800);
    } catch {}
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

    // KS-4316: scene-driven режим — pageA/pageB переключаются ПОСЦЕННО.
    // single-coach → pa1 (wide coach), single-viewer → pb1 (wide viewer),
    // split → pa1 (wide coach) + pb2 (narrow viewer). pa2 не используется в
    // sceneDriven — это нужно потому, что live-broadcast у coach
    // (`useAnalysisLiveBroadcast.attachExistingSession`) сработал в pa1
    // после UI-сабмита `CreateLectureModal`; в pa2 (новый context) attach
    // не вызывается, и ходы тренера не публикуются в namespace. Держим
    // coach в pa1, чтобы синхронизация доска тренер↔зритель работала.
    // build-track читает `splitSource` из placements и в split-сценах
    // склеивает A1 (left) + B2 (right) через hstack.
    if (sceneDrivenNarrowSwitch) {
      if (effectiveLayout === 'split') {
        pageA = pa1;
        pageB = pb2;
      } else if (
        effectiveLayout === 'single-viewer' ||
        scene.layout === 'single-viewer'
      ) {
        pageA = pb1;
        pageB = pb1;
      } else {
        // 'single' | 'single-coach' | default
        pageA = pa1;
        pageB = pa1;
      }
    }

    // ASSERT-режим: до 3 попыток на сцену. Любой провал проверки
    // обрывает попытку через SceneFailError, делается короткий
    // откат (Escape всех открытых страниц + пауза), сцена пишется
    // заново. После третьей попытки — fatal exit с записью в журнал.
    const sceneIdx = placements.length;
    let attempt = 0;
    let sceneOk = false;
    let lastErr = null;
    let sceneStartMs = 0;
    let holdMs = 0;
    while (attempt < 3 && !sceneOk) {
      attempt += 1;
      const sceneCtx = {
        sceneIdx, sceneTag: scene.tag, attempt,
      };
      await writeEvent({
        type: 'scene_attempt_start',
        ...sceneCtx,
        layout: effectiveLayout,
        segment: scene.segment,
      });
      try {
        // meta-actions выполняются ДО фиксации sceneStartMs,
        // чтобы actions/voice стартовали в одной точке времени.
        await runMetaActions(scene, sceneCtx);
        sceneStartMs = Date.now() - recordStartedAt;
        log(
          `SCENE ${scene.tag} start=${sceneStartMs}ms dur=${durMs}ms ` +
            `layout=${effectiveLayout} attempt=${attempt}`,
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
              log(`  anchor "${a.anchor}" not found, fallback atMs=${atMs}`);
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
        const anchorActs = scheduled.filter(
          (a) => a.anchor && a.delayFromPrevMs == null,
        );
        const seqActs = scheduled.filter((a) => a.delayFromPrevMs != null);
        anchorActs.sort((x, y) => x.atMs - y.atMs);
        const finalSchedule = [...anchorActs, ...seqActs].sort(
          (x, y) => x.atMs - y.atMs,
        );

        // диспатч действий сцены. SceneFailError из dispatchAction
        // пробрасывается через .catch и обрывает цикл сцены —
        // мы попадаем в внешний catch (ниже) и идём на следующую
        // попытку (или, исчерпав лимит, в fatal).
        let cursorMs = 0;
        const refPage = pageA;
        let _actI = -1;
        for (const a of finalSchedule) {
          _actI += 1;
          const wait = Math.max(0, a.atMs - cursorMs);
          if (wait > 0) await refPage.waitForTimeout(wait);
          const stepLabel = `actions[${_actI}].${a.type}`;
          await dispatchAction(a, { ...sceneCtx, stepLabel });
          cursorMs = Date.now() - recordStartedAt - sceneStartMs;
        }

        // удержание сцены до durMs + BUFFER
        const spent = Date.now() - recordStartedAt - sceneStartMs;
        const need = durMs + BUFFER_MS;
        if (spent < need) await refPage.waitForTimeout(need - spent);
        holdMs = Date.now() - recordStartedAt - sceneStartMs;

        sceneOk = true;
        await writeEvent({
          type: 'scene_attempt_ok',
          ...sceneCtx,
          sceneStartMs,
          holdMs,
        });
      } catch (e) {
        if (!(e instanceof SceneFailError)) {
          // Техническая ошибка не от ASSERT — пробрасываем наружу,
          // конвейер падает с понятным stack-trace.
          throw e;
        }
        lastErr = e;
        log(`scene "${scene.tag}" attempt ${attempt} FAILED: ${e.message}`);
        await writeEvent({
          type: 'scene_attempt_fail',
          ...sceneCtx,
          reason: e.message,
          ...(e.ctx ? { failCtx: e.ctx } : {}),
        });
        if (attempt < 3) {
          await cleanupAfterFail();
        }
      }
    }
    if (!sceneOk) {
      await writeEvent({
        type: 'scene_fatal',
        sceneIdx,
        sceneTag: scene.tag,
        reason: lastErr?.message || '<unknown>',
      });
      const fmsg =
        `FATAL: scene "${scene.tag}" failed after 3 attempts. ` +
        `Last reason: ${lastErr?.message || '<unknown>'}`;
      log(fmsg);
      throw new Error(fmsg);
    }

    placements.push({
      tag: scene.tag,
      segment: scene.segment,
      startMs: sceneStartMs,
      durMs,
      holdMs,
      layout: effectiveLayout,
      attempts: attempt,
      ...(sceneDrivenNarrowSwitch && effectiveLayout === 'split'
        ? { splitSource: 'A1+B2' }
        : {}),
      ...(scene.splice ? { splice: scene.splice } : {}),
    });
    log(
      `  scene "${scene.tag}" done: hold=${holdMs}ms ` +
        `(need ${durMs + BUFFER_MS}ms, attempts=${attempt})`,
    );
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
  // KS-4316: B1 теперь полноценный источник для сцен single-viewer
  // (если scenarios.wideViewportB и sceneDrivenNarrowSwitch включены).
  // findVideoFile возвращает webm, который Playwright записывал
  // от создания контекста до browser.close().
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
}

// ── pipeline v3: chain-based рекординг ─────────────────────────────
// Точечная пересъёмка одной цепочки. См. docs/content-guide/
// video-overview-pipeline.md (§3 формат, §5 hash, §6 команды).
//
// Стратегия: каждая DIRTY цепочка превращается во временный v2-style
// сценарий (chain.scenes → scenes[]) и запускается тем же runV2 как
// subprocess с подменённым KEY → собственным DIR. Это даёт точную
// изоляцию contexts (Playwright recordVideo пишется только этот chain)
// и нулевой риск регрессий по уже работающему v2-коду. После записи
// мастер-видео нарезается на scenes/<sceneId>/capture.webm через
// build-track.py --cut-capture (общий ffmpeg-код с финальной сборкой).

const RECORD_VERSION_V3 = '3.0.0';

// Стабильная сериализация JSON: sorted keys, без пробелов.
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) {
    return '[' + v.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

async function sha256File(p) {
  try {
    const buf = await fs.readFile(p);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

function sha256Str(s) {
  return createHash('sha256').update(s).digest('hex');
}

async function computeSceneHashV3({
  recordVersion,
  chain,
  scene,
  sceneIdxInChain,
  prevSceneHashes,
  resolvedStateRefs,
  segments,
  globalDefaults,
}) {
  const seg = segments.find((s) => s.idx === scene.segment);
  const segFile = seg ? seg.file : null;
  const fileBase = segFile ? path.basename(segFile, '.mp3') : null;
  const txtPath = fileBase ? path.join(VOICE_DIR, `${fileBase}.txt`) : null;
  const mp3Path = segFile;
  const timPath = fileBase ? path.join(VOICE_DIR, `${fileBase}.timings.json`) : null;

  const [hashTxt, hashMp3, hashTim] = await Promise.all([
    txtPath ? sha256File(txtPath) : Promise.resolve(null),
    mp3Path ? sha256File(mp3Path) : Promise.resolve(null),
    timPath ? sha256File(timPath) : Promise.resolve(null),
  ]);

  // chain без `scenes` — в hash сцены идут preconditions и stableState chain.
  const chainDecl = {
    chainId: chain.chainId,
    preconditions: chain.preconditions || {},
    stableState: chain.stableState === true,
    stateRefs: chain.stateRefs || [],
    stateOut: chain.stateOut || null,
    resolvedStateRefs: resolvedStateRefs || {},
  };

  const payload = {
    recordVersion,
    chainId: chain.chainId,
    sceneId: scene.sceneId,
    sceneIdxInChain,
    segmentIdx: scene.segment,
    segmentText: hashTxt,
    segmentMp3: hashMp3,
    segmentTimings: hashTim,
    sceneDeclaration: scene,
    chainDeclaration: chainDecl,
    prevScenesInChain: prevSceneHashes.slice(),
    globalDefaults: globalDefaults || {},
  };

  return sha256Str(canonicalJson(payload));
}

// Хелпер: подстановка ${state.<chainId>.<key>} и ${WEB} в строке.
function substituteV3(str, resolvedRefsMap) {
  if (str == null) return str;
  let out = String(str).replace(/\$\{WEB\}/g, WEB);
  out = out.replace(/\$\{state\.([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\}/g, (m, ch, key) => {
    const v = resolvedRefsMap[`${ch}.${key}`];
    return v == null ? '' : String(v);
  });
  return out;
}

// Рекурсивная подстановка в произвольной структуре (URL/text внутри
// metaActions/actions). Не модифицирует исходный объект.
function deepSubstituteV3(obj, refsMap) {
  if (obj == null) return obj;
  if (typeof obj === 'string') return substituteV3(obj, refsMap);
  if (Array.isArray(obj)) return obj.map((x) => deepSubstituteV3(x, refsMap));
  if (typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = deepSubstituteV3(obj[k], refsMap);
    return out;
  }
  return obj;
}

// Spawn subprocess record.mjs в режиме v2 с временным KEY=<KEY>__<chainId>.
// chainKey даёт изолированный /tmp/<chainKey>/ под сцены этой цепочки.
async function spawnChainV2({ chainKey, chainDir, scenesRaw, chain, segments, resolvedRefsMap }) {
  // Подготавливаем v2-style scene-actions.json: scenes[] = chain.scenes,
  // preconditions.navigate → metaAction goto в первой сцене (как pre-roll).
  // initialAuth/wideViewportB/sceneDrivenNarrowSwitch/grantMicrophone/
  // fakeAudioFile/defaults — копируются как есть.
  const v2Scenes = [];
  for (const sc of chain.scenes) {
    const sub = deepSubstituteV3(sc, resolvedRefsMap);
    // Уносим sceneId → tag для совместимости с v2 loadInputs/main loop.
    const v2Scene = {
      tag: sub.sceneId,
      ...sub,
    };
    delete v2Scene.sceneId;
    v2Scenes.push(v2Scene);
  }
  // Pre-roll: первый scene получает goto(<initialUrl>) в начале metaActions,
  // если в preconditions.navigate он объявлен и в metaActions ещё его нет.
  // Это эквивалент v2 firstScene.goto автоматического pre-roll.
  if (chain.preconditions && chain.preconditions.navigate) {
    const firstSc = v2Scenes[0];
    if (firstSc) {
      const prepend = [];
      for (const [side, url] of Object.entries(chain.preconditions.navigate)) {
        const resolved = substituteV3(url, resolvedRefsMap);
        prepend.push({ type: 'goto', side, url: resolved, waitMsAfter: 1500 });
      }
      firstSc.metaActions = [...prepend, ...(firstSc.metaActions || [])];
    }
  }

  const v2Doc = {
    $schema: 'scene-actions.v2',
    ticket: chainKey,
    scenarioVersion: `${scenesRaw.scenarioVersion || 'v1'}/chain-${chain.chainId}`,
    initialAuth: scenesRaw.initialAuth || 'user',
    wideViewportB: scenesRaw.wideViewportB === true,
    sceneDrivenNarrowSwitch: scenesRaw.sceneDrivenNarrowSwitch === true,
    grantMicrophone: Array.isArray(scenesRaw.grantMicrophone) ? scenesRaw.grantMicrophone : [],
    fakeAudioFile: scenesRaw.fakeAudioFile || null,
    defaults: scenesRaw.defaults || {},
    scenes: v2Scenes,
  };

  // Кладём scene-actions.json + segments.json (symlink) в chainDir.
  await fs.mkdir(chainDir, { recursive: true });
  await fs.writeFile(path.join(chainDir, 'scene-actions.json'), JSON.stringify(v2Doc, null, 2));
  const parentSegments = path.join(DIR, 'segments.json');
  const chainSegments = path.join(chainDir, 'segments.json');
  try { await fs.unlink(chainSegments); } catch {}
  await fs.symlink(parentSegments, chainSegments).catch(async () => {
    await fs.copyFile(parentSegments, chainSegments);
  });
  // Симлинк voice-dir
  const parentVoice = `/tmp/voiceover/${KEY}`;
  const chainVoice = `/tmp/voiceover/${chainKey}`;
  try { await fs.unlink(chainVoice); } catch {}
  await fs.symlink(parentVoice, chainVoice).catch(async () => {
    // если копия — копируем (на случай ограничений symlink)
    await fs.mkdir(chainVoice, { recursive: true });
  });

  // Запуск record.mjs --key=<chainKey>
  const env = { ...process.env };
  const selfPath = process.argv[1];
  const proc = spawn(process.execPath, [selfPath, `--key=${chainKey}`], {
    env,
    stdio: 'inherit',
  });
  const code = await new Promise((resolve) => {
    proc.on('exit', (c) => resolve(c));
  });
  if (code !== 0) {
    throw new Error(`record.mjs subprocess для цепочки ${chain.chainId} завершился с кодом ${code}`);
  }

  // Читаем placements.json
  const placementsPath = path.join(chainDir, 'placements.json');
  const placementsMeta = JSON.parse(await fs.readFile(placementsPath, 'utf-8'));
  return placementsMeta;
}

// Запрос stateOut (например, чтение `slug` лекции из API). Минимальный
// набор источников — расширяется по мере необходимости сценариев.
async function captureStateOut({ chainKey, chain, placementsMeta }) {
  const out = {};
  const decl = chain.stateOut || {};
  for (const [key, src] of Object.entries(decl)) {
    if (!src || typeof src !== 'object') continue;
    try {
      if (src.from === 'api') {
        // { from: 'api', method: 'GET', path: '/lectures/<id>', extract: 'liveAnalysis.slug' }
        const url = `${API}${substituteV3(src.path, {})}`;
        const r = await fetch(url, {
          method: src.method || 'GET',
          headers: src.headers || {},
        });
        if (r.ok) {
          const json = await r.json();
          out[key] = jsonExtract(json, src.extract);
        }
      } else if (src.from === 'constant') {
        out[key] = src.value;
      }
      // другие источники (DOM-капча, placements) — добавляются по требованию.
    } catch (e) {
      log(`stateOut ${chain.chainId}.${key} capture failed: ${e.message}`);
    }
  }
  return out;
}

function jsonExtract(obj, pathStr) {
  if (!pathStr) return obj;
  let cur = obj;
  for (const seg of pathStr.split('.')) {
    if (cur == null) return null;
    cur = cur[seg];
  }
  return cur;
}

async function runV3(scenesRaw) {
  log(`v3 pipeline start KEY=${KEY}`);
  const recordVersion = scenesRaw.recordVersion || RECORD_VERSION_V3;
  const chains = scenesRaw.chains;
  if (!Array.isArray(chains) || chains.length === 0) {
    throw new Error('scene-actions.v3: пустой chains[]');
  }
  // Все sceneId должны быть уникальны.
  const allSceneIds = new Set();
  for (const ch of chains) {
    for (const sc of (ch.scenes || [])) {
      if (!sc.sceneId) throw new Error(`scene без sceneId в chain ${ch.chainId}`);
      if (allSceneIds.has(sc.sceneId)) throw new Error(`duplicate sceneId: ${sc.sceneId}`);
      allSceneIds.add(sc.sceneId);
    }
    if (!ch.chainId) throw new Error('chain без chainId');
  }

  await fs.mkdir(path.join(DIR, 'scenes'), { recursive: true });
  await fs.mkdir(path.join(DIR, 'chains'), { recursive: true });
  await fs.mkdir(path.join(DIR, 'state'), { recursive: true });

  // Загружаем segments.json
  const segments = JSON.parse(await fs.readFile(path.join(DIR, 'segments.json'), 'utf-8'));

  // Загружаем stateOut'ы предыдущих прогонов.
  const stateByChain = new Map();
  for (const ch of chains) {
    const sp = path.join(DIR, 'state', `${ch.chainId}.out.json`);
    try {
      stateByChain.set(ch.chainId, JSON.parse(await fs.readFile(sp, 'utf-8')));
    } catch {}
  }

  // planRebuild
  const plan = []; // [{ chainId, dirty: bool, scenes: [{sceneId, hash, dirty}] }]
  const dirtyChains = new Set();
  for (const ch of chains) {
    // resolved stateRefs (для hash и для подстановки)
    const resolvedRefsMap = {};
    let missingRef = false;
    for (const ref of (ch.stateRefs || [])) {
      const [refChain, refKey] = ref.split('.');
      const s = stateByChain.get(refChain);
      if (s && refKey in s) {
        resolvedRefsMap[ref] = s[refKey];
      } else {
        missingRef = true;
        resolvedRefsMap[ref] = null;
      }
      // forward propagation
      const refDecl = chains.find((c) => c.chainId === refChain);
      if (refDecl && dirtyChains.has(refChain) && refDecl.stableState !== true) {
        dirtyChains.add(ch.chainId);
      }
    }
    if (missingRef) dirtyChains.add(ch.chainId);

    const prevHashes = [];
    let chainDirty = false;
    const sceneEntries = [];
    for (const [idx, sc] of (ch.scenes || []).entries()) {
      const expectedHash = await computeSceneHashV3({
        recordVersion,
        chain: ch,
        scene: sc,
        sceneIdxInChain: idx,
        prevSceneHashes: prevHashes,
        resolvedStateRefs: resolvedRefsMap,
        segments,
        globalDefaults: scenesRaw.defaults || {},
      });
      const metaPath = path.join(DIR, 'scenes', sc.sceneId, 'meta.json');
      let currentHash = null;
      try {
        const m = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
        currentHash = m.hash || null;
      } catch {}
      const captureExists = await fs.access(
        path.join(DIR, 'scenes', sc.sceneId, 'capture.webm'),
      ).then(() => true).catch(() => false);
      const sceneDirty = currentHash !== expectedHash || !captureExists;
      if (sceneDirty) chainDirty = true;
      sceneEntries.push({ sceneId: sc.sceneId, expectedHash, currentHash, dirty: sceneDirty });
      prevHashes.push(expectedHash);
    }
    if (chainDirty) dirtyChains.add(ch.chainId);
    plan.push({
      chainId: ch.chainId,
      dirty: dirtyChains.has(ch.chainId),
      scenes: sceneEntries,
      resolvedRefsMap,
    });
  }

  // --plan-only
  if (args.planOnly) {
    console.log('=== plan ===');
    for (const p of plan) {
      console.log(`${p.dirty ? 'DIRTY' : 'SKIP '} ${p.chainId} (${p.scenes.length} scenes)`);
      for (const s of p.scenes) {
        console.log(`   ${s.dirty ? '~' : ' '} ${s.sceneId}  hash=${s.expectedHash.slice(0, 12)}…`);
      }
    }
    return;
  }

  // --invalidate
  if (args.invalidate) {
    let targetChainId = args.chain;
    if (!targetChainId && args.scene) {
      const ch = chains.find((c) => (c.scenes || []).some((s) => s.sceneId === args.scene));
      if (!ch) {
        console.error(`ERROR: scene "${args.scene}" не найден в chains[]`);
        process.exit(2);
      }
      targetChainId = ch.chainId;
    }
    if (!targetChainId) {
      console.error('ERROR: --invalidate требует --scene= или --chain=');
      process.exit(2);
    }
    const ch = chains.find((c) => c.chainId === targetChainId);
    if (!ch) {
      console.error(`ERROR: chain "${targetChainId}" не найден`);
      process.exit(2);
    }
    for (const sc of (ch.scenes || [])) {
      const metaPath = path.join(DIR, 'scenes', sc.sceneId, 'meta.json');
      await fs.unlink(metaPath).catch(() => {});
      log(`invalidated ${metaPath}`);
    }
    return;
  }

  // --scene / --chain — фильтр: оставляем DIRTY только указанную цепочку.
  // (остальные SKIP, даже если по hash должны были бы переснимать.)
  let activePlan = plan;
  if (args.chain || args.scene) {
    let onlyChainId = args.chain;
    if (!onlyChainId && args.scene) {
      const ch = chains.find((c) => (c.scenes || []).some((s) => s.sceneId === args.scene));
      if (!ch) {
        console.error(`ERROR: scene "${args.scene}" не найден`);
        process.exit(2);
      }
      onlyChainId = ch.chainId;
    }
    activePlan = plan.map((p) =>
      p.chainId === onlyChainId ? { ...p, dirty: true } : { ...p, dirty: false },
    );
  } else if (args.force) {
    activePlan = plan.map((p) => ({ ...p, dirty: true }));
  }

  // Логируем план
  log('=== rebuild plan ===');
  for (const p of activePlan) {
    log(`${p.dirty ? 'DIRTY' : 'SKIP '} ${p.chainId}`);
  }

  // Для каждой DIRTY цепочки — запускаем v2 subprocess.
  for (const p of activePlan) {
    if (!p.dirty) continue;
    const chain = chains.find((c) => c.chainId === p.chainId);
    log(`>>> RECORD chain ${chain.chainId} (${chain.scenes.length} scenes)`);

    const chainKey = `${KEY}__${chain.chainId}`;
    const chainDir = `/tmp/${chainKey}`;
    // Чистим прежний tmp dir
    try {
      await fs.rm(chainDir, { recursive: true, force: true });
    } catch {}

    const placementsMeta = await spawnChainV2({
      chainKey, chainDir, scenesRaw, chain, segments,
      resolvedRefsMap: p.resolvedRefsMap,
    });

    // Нарезка scenes/<sceneId>/capture.webm + meta.json
    const placements = placementsMeta.scenes || [];
    const videos = placementsMeta.videos || {};
    const videoOffsets = placementsMeta.videoOffsets || {};

    for (const [idx, sc] of chain.scenes.entries()) {
      const pl = placements.find((x) => x.tag === sc.sceneId);
      if (!pl) {
        throw new Error(`placement для сцены ${sc.sceneId} не найден в chain run`);
      }
      const sceneDir = path.join(DIR, 'scenes', sc.sceneId);
      await fs.mkdir(sceneDir, { recursive: true });
      const capOut = path.join(sceneDir, 'capture.webm');

      const layout = pl.layout || sc.layout || 'single';
      const splice = pl.splice || sc.splice || null;

      // Выбираем источник по layout
      let srcA = null, srcB = null;
      let offA = 0, offB = 0;
      let split = false;
      const buildTrackPy = path.join(path.dirname(process.argv[1]), 'build-track.py');

      if (layout === 'split') {
        const splitSource = pl.splitSource || 'A1+B2';
        const sideA = splitSource.split('+')[0];
        const sideB = splitSource.split('+')[1];
        srcA = videos[sideA];
        srcB = videos[sideB];
        offA = videoOffsets[sideA] || 0;
        offB = videoOffsets[sideB] || 0;
        split = true;
        if (!srcA || !srcB) {
          throw new Error(`split scene ${sc.sceneId}: нет ${splitSource} в videos`);
        }
      } else if (layout === 'single-viewer') {
        srcA = videos.B1;
        offA = videoOffsets.B1 || 0;
        if (!srcA) throw new Error(`single-viewer scene ${sc.sceneId}: нет B1`);
      } else {
        // 'single' | 'single-coach' | default → A1
        srcA = videos.A1;
        offA = videoOffsets.A1 || 0;
        if (!srcA) throw new Error(`single scene ${sc.sceneId}: нет A1`);
      }

      const cutArgs = [
        buildTrackPy, '--cut-capture',
        '--src', srcA,
        '--offset-ms', String(offA),
        '--start-ms', String(pl.startMs),
        '--hold-ms', String(pl.holdMs),
        '--out', capOut,
      ];
      if (split) {
        cutArgs.push('--split', '--src-b', srcB, '--offset-ms-b', String(offB));
      }
      if (splice && splice.headMs && splice.tailMs) {
        cutArgs.push('--splice-head', String(splice.headMs), '--splice-tail', String(splice.tailMs));
      }
      log(`cut ${sc.sceneId}: ${path.basename(srcA)} ${pl.startMs}+${pl.holdMs}ms`);
      const cutProc = spawn('python3', cutArgs, { stdio: 'inherit' });
      const cutCode = await new Promise((resolve) => cutProc.on('exit', (c) => resolve(c)));
      if (cutCode !== 0) {
        throw new Error(`cut-capture для ${sc.sceneId} вернул ${cutCode}`);
      }

      // meta.json
      const meta = {
        sceneId: sc.sceneId,
        chainId: chain.chainId,
        sceneIdxInChain: idx,
        segmentIdx: sc.segment,
        layout,
        splitSource: pl.splitSource || null,
        splice,
        hash: p.scenes[idx].expectedHash,
        durMs: pl.durMs,
        holdMs: pl.holdMs,
        recordVersion,
        captureWidth: 1920,
        captureHeight: 1200,
        recordedAt: new Date().toISOString(),
      };
      await fs.writeFile(path.join(sceneDir, 'meta.json'), JSON.stringify(meta, null, 2));
    }

    // Сохраняем master-видео в chains/<chainId>/ если keepMasters.
    if (args.keepMasters) {
      const chDir = path.join(DIR, 'chains', chain.chainId);
      await fs.mkdir(chDir, { recursive: true });
      for (const [ctxName, srcPath] of Object.entries(videos)) {
        if (!srcPath) continue;
        const dst = path.join(chDir, `master-${ctxName}.webm`);
        try { await fs.copyFile(srcPath, dst); } catch (e) {
          log(`warn: master copy ${ctxName}: ${e.message}`);
        }
      }
      await fs.writeFile(
        path.join(chDir, 'placements.json'),
        JSON.stringify(placementsMeta, null, 2),
      );
    }

    // stateOut
    if (chain.stateOut) {
      const captured = await captureStateOut({ chainKey, chain, placementsMeta });
      await fs.writeFile(
        path.join(DIR, 'state', `${chain.chainId}.out.json`),
        JSON.stringify(captured, null, 2),
      );
      stateByChain.set(chain.chainId, captured);
      log(`stateOut ${chain.chainId} → ${JSON.stringify(captured)}`);
    }

    // Чистим tmp dir
    try { await fs.rm(chainDir, { recursive: true, force: true }); } catch {}
    try { await fs.unlink(`/tmp/voiceover/${chainKey}`); } catch {}

    log(`<<< chain ${chain.chainId} done`);
  }

  log('v3 pipeline done.');
}

// ── entry point ────────────────────────────────────────────────────
(async () => {
  // Читаем scene-actions.json и решаем v2 vs v3.
  let scenesRaw = null;
  try {
    scenesRaw = JSON.parse(
      await fs.readFile(path.join(DIR, 'scene-actions.json'), 'utf-8'),
    );
  } catch (e) {
    console.error(`FATAL: cannot read ${DIR}/scene-actions.json: ${e.message}`);
    process.exit(1);
  }
  const schema = !Array.isArray(scenesRaw) && scenesRaw && scenesRaw['$schema']
    ? scenesRaw['$schema']
    : 'scene-actions.v1';
  if (schema === 'scene-actions.v3') {
    await runV3(scenesRaw);
    return;
  }
  if (args.planOnly || args.invalidate) {
    console.error(`ERROR: --plan-only/--invalidate поддерживается только для $schema=scene-actions.v3 (текущий: ${schema})`);
    process.exit(2);
  }
  await runV2();
})().catch((e) => {
  console.error('FATAL:', e.stack || e);
  process.exit(1);
});
