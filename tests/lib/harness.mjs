import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const DASH = path.join(ROOT, 'AI Usage Dashboard.html');
export const OUT = path.join(import.meta.dirname, '..', 'fixtures', 'out');

export function findBrowser() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('No Chrome/Edge found - set CHROME_PATH');
}

export async function launch() {
  return puppeteer.launch({ executablePath: findBrowser(), headless: true });
}

/** Open the dashboard in a fresh page. opts: {tz, seedData, clockAt} */
export async function openDashboard(browser, opts = {}) {
  const page = await browser.newPage();
  if (opts.tz) await page.emulateTimezone(opts.tz);
  if (opts.clockAt) {
    await page.evaluateOnNewDocument((iso) => {
      const RealDate = Date;
      const offset = new RealDate(iso).getTime() - RealDate.now();
      class ShimDate extends RealDate {
        constructor(...args) { if (args.length === 0) super(RealDate.now() + offset); else super(...args); }
        static now() { return RealDate.now() + offset; }
      }
      ShimDate.parse = RealDate.parse; ShimDate.UTC = RealDate.UTC;
      window.Date = ShimDate;
    }, opts.clockAt);
  }
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const url = pathToFileURL(DASH).href;
  await page.goto(url, { waitUntil: 'load' });
  if (!opts.seedData && !opts.keepStorage) {
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('aiusage:')) localStorage.removeItem(k); });
    await page.reload({ waitUntil: 'load' });
  }
  if (opts.seedData) {
    await page.evaluate((data) => localStorage.setItem('aiusage:data', JSON.stringify(data)), opts.seedData);
    await page.reload({ waitUntil: 'load' });
  }
  return { page, errors };
}

export function readFixture(name) {
  return fs.readFileSync(path.join(OUT, name), 'utf8');
}
