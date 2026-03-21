#!/usr/bin/env node
/**
 * Interactive screenshot tool using Playwright Node API.
 * Supports navigation, clicking, waiting, and screenshotting.
 *
 * Usage:
 *   node scripts/interactive-screenshot.js <output.png> [options]
 *
 * Options:
 *   --url <url>              URL to navigate (default: http://localhost:5173)
 *   --click <selector>       CSS selector to click (can repeat)
 *   --wait <ms>              Wait after each action (default: 1000)
 *   --waitFor <selector>     Wait for element to appear before screenshot
 *   --viewport <WxH>         Viewport size (default: 1280x720)
 *   --fullpage               Full page screenshot
 *   --timeout <ms>           Navigation timeout (default: 10000)
 *
 * Examples:
 *   # Simple screenshot
 *   node scripts/interactive-screenshot.js /tmp/home.png --url http://localhost:5173
 *
 *   # Puzzle Rush: navigate, click Start, screenshot
 *   node scripts/interactive-screenshot.js /tmp/puzzle-rush.png \
 *     --url http://localhost:5173/puzzle-rush \
 *     --click "button:has-text('Start')" \
 *     --wait 2000 \
 *     --waitFor ".board-container"
 *
 *   # Multiple clicks
 *   node scripts/interactive-screenshot.js /tmp/result.png \
 *     --url http://localhost:5173/play \
 *     --click "#tab-blitz" \
 *     --click "button.play-btn"
 */

const { chromium } = require('playwright');

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help') {
    console.log('Usage: node scripts/interactive-screenshot.js <output.png> [options]');
    console.log('Run with --help for full usage info (see source comments).');
    process.exit(0);
  }

  const outputPath = args[0];
  const options = {
    url: 'http://localhost:5173',
    clicks: [],
    wait: 1000,
    waitFor: null,
    viewport: { width: 1280, height: 720 },
    fullPage: false,
    timeout: 10000,
  };

  // Parse args
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--url':
        options.url = args[++i];
        break;
      case '--click':
        options.clicks.push(args[++i]);
        break;
      case '--wait':
        options.wait = parseInt(args[++i], 10);
        break;
      case '--waitFor':
        options.waitFor = args[++i];
        break;
      case '--viewport': {
        const [w, h] = args[++i].split('x').map(Number);
        options.viewport = { width: w, height: h };
        break;
      }
      case '--fullpage':
        options.fullPage = true;
        break;
      case '--timeout':
        options.timeout = parseInt(args[++i], 10);
        break;
    }
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: options.viewport });

  try {
    await page.goto(options.url, { waitUntil: 'networkidle', timeout: options.timeout });

    for (const selector of options.clicks) {
      await page.click(selector, { timeout: options.timeout });
      await page.waitForTimeout(options.wait);
    }

    if (options.waitFor) {
      await page.waitForSelector(options.waitFor, { timeout: options.timeout });
    }

    await page.screenshot({ path: outputPath, fullPage: options.fullPage });
    console.log(`Screenshot saved: ${outputPath}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
