// Browser check for the standalone scoreboard: serve `web/` and set SCOREBOARD_URL, e.g.
//   python -m http.server 8811 --directory web   then   SCOREBOARD_URL=http://127.0.0.1:8811/scoreboard/ node tests/scoreboard-ui.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const url = process.env.SCOREBOARD_URL || 'http://127.0.0.1:8811/scoreboard/';
const browser = await chromium.launch();
const page = await (await browser.newContext({viewport: {width: 1280, height: 800}, hasTouch: true})).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
fs.mkdirSync('test-results', {recursive: true});
const score = () => page.$$eval('.score', s => s.map(x => x.textContent).join('-'));
const swipe = async (x, y0, y1) => {
  await page.mouse.move(x, y0); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x, y0 + (y1 - y0) * i / 8);
  await page.mouse.up(); await page.waitForTimeout(300);
};
try {
  await page.goto(url);
  await page.touchscreen.tap(320, 400); await page.waitForTimeout(300);
  await page.touchscreen.tap(960, 400); await page.waitForTimeout(300);
  assert.equal(await score(), '1-1', 'tap adds one point per side');
  await swipe(320, 250, 550);
  assert.equal(await score(), '2-1', 'swipe down adds exactly one point');
  await swipe(960, 550, 250);
  assert.equal(await score(), '2-0', 'swipe up cancels that team');
  await page.mouse.move(320, 400); await page.mouse.down(); await page.waitForTimeout(1200); await page.mouse.up();
  assert.equal(await score(), '2-0', 'a long touch is ignored');
  await page.keyboard.down('Enter'); await page.waitForTimeout(100); await page.keyboard.up('Enter'); await page.waitForTimeout(400);
  assert.equal(await score(), '3-0', 'remote short press = our team');
  await page.keyboard.down('Enter');
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(50); await page.keyboard.down('Enter'); }
  await page.keyboard.up('Enter'); await page.waitForTimeout(400);
  assert.equal(await score(), '3-1', 'remote long press with auto-repeat = one opponent point');
  await page.reload(); await page.waitForTimeout(500);
  assert.equal(await score(), '3-1', 'score restored after reload');
  await page.click('#toolbar [data-act=undo]'); await page.waitForTimeout(200);
  assert.equal(await score(), '3-0', 'undo removes the latest point');
  await page.screenshot({path: 'test-results/scoreboard.png'});
  assert.deepEqual(errors, []);
  console.log('scoreboard UI checks passed');
} finally {
  await browser.close();
}
