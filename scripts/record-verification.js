#!/usr/bin/env node
/**
 * Record browser actions and produce a GIF via Playwright recordVideo + ffmpeg.
 *
 * Usage:
 *   node scripts/record-verification.js \
 *     --url http://localhost:5173/puzzle-rush \
 *     --actions "click:button:has-text('Start')" "wait:2000" "screenshot:started.png" \
 *     --output /tmp/puzzle-rush.gif \
 *     --viewport 1280x720
 *
 * Actions (space-separated, each quoted):
 *   click:<selector>        Click element by CSS selector
 *   wait:<ms>               Wait N milliseconds
 *   type:<selector>:<text>  Type text into element
 *   reload                  Reload the page
 *   screenshot:<path>       Take a screenshot (absolute or relative path)
 *
 * Options:
 *   --url <url>             URL to navigate (default: http://localhost:5173)
 *   --actions <action>...   List of actions to perform
 *   --output <path>         Output GIF path (default: /tmp/recording.gif)
 *   --viewport <WxH>        Viewport size (default: 1280x720)
 *   --timeout <ms>          Action timeout (default: 10000)
 *   --no-gif                Skip ffmpeg conversion, keep raw .webm
 *   --fps <n>               GIF frame rate (default: 10)
 *   --scale <width>         GIF width in px, height auto (default: 800)
 */

const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function parseArgs(argv) {
  const opts = {
    url: 'http://localhost:5173',
    actions: [],
    output: '/tmp/recording.gif',
    viewport: { width: 1280, height: 720 },
    timeout: 10000,
    noGif: false,
    fps: 10,
    scale: 800,
  };

  let i = 0;
  while (i < argv.length) {
    switch (argv[i]) {
      case '--url':
        opts.url = argv[++i];
        break;
      case '--actions':
        i++;
        while (i < argv.length && !argv[i].startsWith('--')) {
          opts.actions.push(argv[i]);
          i++;
        }
        continue; // don't increment i again
      case '--output':
        opts.output = argv[++i];
        break;
      case '--viewport': {
        const [w, h] = argv[++i].split('x').map(Number);
        opts.viewport = { width: w, height: h };
        break;
      }
      case '--timeout':
        opts.timeout = parseInt(argv[++i], 10);
        break;
      case '--no-gif':
        opts.noGif = true;
        break;
      case '--fps':
        opts.fps = parseInt(argv[++i], 10);
        break;
      case '--scale':
        opts.scale = parseInt(argv[++i], 10);
        break;
      case '--help':
        console.log('Usage: node scripts/record-verification.js [options]');
        console.log('See source for full docs.');
        process.exit(0);
    }
    i++;
  }
  return opts;
}

async function executeAction(page, action, timeout) {
  if (action === 'reload') {
    console.log('  → reload');
    await page.reload({ waitUntil: 'networkidle', timeout });
    return;
  }

  const colonIdx = action.indexOf(':');
  if (colonIdx === -1) {
    console.error(`  ✗ Unknown action: ${action}`);
    return;
  }

  const type = action.substring(0, colonIdx);
  const arg = action.substring(colonIdx + 1);

  switch (type) {
    case 'click':
      console.log(`  → click "${arg}"`);
      await page.click(arg, { timeout });
      break;
    case 'wait':
      console.log(`  → wait ${arg}ms`);
      await page.waitForTimeout(parseInt(arg, 10));
      break;
    case 'type': {
      const sep = arg.indexOf(':');
      const selector = arg.substring(0, sep);
      const text = arg.substring(sep + 1);
      console.log(`  → type "${text}" into "${selector}"`);
      await page.fill(selector, text, { timeout });
      break;
    }
    case 'screenshot':
      console.log(`  → screenshot "${arg}"`);
      await page.screenshot({ path: arg });
      break;
    default:
      console.error(`  ✗ Unknown action type: ${type}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-video-'));

  console.log(`Recording: ${opts.url}`);
  console.log(`Viewport: ${opts.viewport.width}x${opts.viewport.height}`);
  console.log(`Actions: ${opts.actions.length}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: opts.viewport,
    recordVideo: {
      dir: videoDir,
      size: opts.viewport,
    },
  });

  const page = await context.newPage();

  try {
    await page.goto(opts.url, { waitUntil: 'networkidle', timeout: opts.timeout });
    console.log('Page loaded');

    for (const action of opts.actions) {
      await executeAction(page, action, opts.timeout);
    }

    // Small pause so last action is visible in recording
    await page.waitForTimeout(500);
  } catch (err) {
    console.error(`Error during recording: ${err.message}`);
  }

  // Close context to finalize video
  const videoPath = await page.video().path();
  await context.close();
  await browser.close();

  console.log(`Video saved: ${videoPath}`);

  if (opts.noGif) {
    console.log('Skipping GIF conversion (--no-gif)');
    console.log(`Output: ${videoPath}`);
    return;
  }

  // Convert to GIF via ffmpeg
  try {
    const filter = `fps=${opts.fps},scale=${opts.scale}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`;
    const cmd = `ffmpeg -y -i "${videoPath}" -vf "${filter}" "${opts.output}" 2>&1`;
    console.log('Converting to GIF...');
    execSync(cmd, { stdio: 'pipe' });
    console.log(`GIF saved: ${opts.output}`);

    // Cleanup temp video
    fs.unlinkSync(videoPath);
    fs.rmSync(videoDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`ffmpeg error: ${err.message}`);
    console.log(`Raw video available at: ${videoPath}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
