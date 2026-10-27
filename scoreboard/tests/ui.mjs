// Browser check: serve `public/` first, e.g.
//   python -m http.server 8811 --directory public   then   node tests/ui.mjs
// SCOREBOARD_URL points it at another address (such as the deployed site).
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const url = process.env.SCOREBOARD_URL || 'http://127.0.0.1:8811/';
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
const press = async (ms = 80) => { await page.keyboard.down('Enter'); await page.waitForTimeout(ms); await page.keyboard.up('Enter'); };
try {
  await page.goto(url);
  assert.equal(await page.isVisible('#intro'), true, 'how-to popup shows on arrival');
  await page.screenshot({path: 'test-results/intro.png'});
  await page.touchscreen.tap(640, 400); await page.waitForTimeout(400);
  assert.equal(await page.isVisible('#intro'), false, 'a touch closes the popup');
  assert.equal(await score(), '0-0', 'the closing touch does not score');
  assert.equal(await page.textContent('.side[data-side=left] .team-name'), '우리 팀');
  await page.touchscreen.tap(320, 400); await page.waitForTimeout(300);
  await page.touchscreen.tap(960, 400); await page.waitForTimeout(300);
  assert.equal(await score(), '1-1', 'tap adds one point per side');
  await swipe(320, 250, 550);
  assert.equal(await score(), '2-1', 'swipe down adds exactly one point');
  await swipe(960, 550, 250);
  assert.equal(await score(), '2-0', 'swipe up cancels that team');
  await page.mouse.move(320, 400); await page.mouse.down(); await page.waitForTimeout(1200); await page.mouse.up();
  assert.equal(await score(), '2-0', 'a long touch is ignored');
  await press(); await page.waitForTimeout(700);
  assert.equal(await score(), '3-0', 'remote one press = our team');
  await press(); await page.waitForTimeout(150); await press(); await page.waitForTimeout(700);
  assert.equal(await score(), '3-1', 'remote two presses = opponent');
  await page.keyboard.down('Enter');
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(50); await page.keyboard.down('Enter'); }
  await page.keyboard.up('Enter'); await page.waitForTimeout(600);
  assert.equal(await score(), '3-0', 'remote long hold = undo once');
  // Rename by tapping the team name.
  await page.touchscreen.tap(...await page.$eval('.side[data-side=left] .team-name', e => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }));
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+A'); await page.keyboard.type('청팀'); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
  assert.equal(await page.textContent('.side[data-side=left] .team-name'), '청팀', 'tap on name renames');
  assert.equal(await score(), '3-0', 'renaming does not score');
  await page.reload(); await page.waitForTimeout(500);
  await page.touchscreen.tap(640, 400); await page.waitForTimeout(400);
  assert.equal(await score(), '3-0', 'score restored after reload');
  await page.click('#toolbar [data-act=undo]'); await page.waitForTimeout(200);
  assert.equal(await score(), '2-0', 'undo removes the latest point');
  await page.screenshot({path: 'test-results/scoreboard.png'});
  assert.deepEqual(errors, []);
  console.log('scoreboard UI checks passed');
} finally {
  await browser.close();
}
