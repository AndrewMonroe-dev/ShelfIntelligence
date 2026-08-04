// REPL driver for ShelfIntelligence. `chromium-cli` isn't available on this
// machine (Windows, not the Linux container it targets), so this is the
// fallback described in the run-skill-generator's playwright.md: a plain
// Playwright `chromium` page instead of `chromium-cli`/`_electron`.
// Designed for agents: run directly (commands piped via stdin/heredoc) or
// under tmux with send-keys/capture-pane for iterative use.
import { chromium } from 'playwright';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const BASE_URL = process.env.BASE_URL || 'http://localhost:8791';
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), 'shelfintelligence-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let browser = null;
let page = null;

// Every command takes ONE raw string argument -- the rest of the line after
// the command word, whitespace collapsed at the edges but preserved inside
// (e.g. a full JS expression for `eval`, or "selector some text" for `fill`).
// Commands that need more than one logical argument (`fill`) split it
// themselves on the first space, since positional spread (`fn(...rest)`)
// silently truncated multi-word args to their first word -- e.g. `eval` only
// ever received the first token of the expression, which is why an early
// version of this driver threw "Unexpected end of input" on every non-trivial
// eval.
const COMMANDS = {
  async launch(hashRoute) {
    if (browser) return console.log('already launched');
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    page = await (await browser.newContext()).newPage();
    page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
    // Native confirm()/alert() (e.g. Planogram Viewer's "Reset All to AI",
    // the bay-overflow warning) blocks the page indefinitely under
    // Playwright unless a dialog handler responds -- auto-accept so a
    // scripted run doesn't hang on one.
    page.on('dialog', (d) => d.accept());
    await page.goto(BASE_URL + (hashRoute ? `/#${hashRoute}` : ''), { waitUntil: 'networkidle' });
    console.log('launched.', page.url());
  },

  async nav(hashRoute) {
    if (!page) return console.log('ERROR: launch first');
    await page.goto(`${BASE_URL}/#${hashRoute}`, { waitUntil: 'networkidle' });
    console.log('navigated to', page.url());
  },

  async ss(name) {
    if (!page) return console.log('ERROR: launch first');
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png');
    await page.screenshot({ path: f });
    console.log('screenshot:', f);
  },

  async click(sel) {
    if (!page) return console.log('ERROR: launch first');
    try { await page.locator(sel).first().click(); console.log('click', sel, '-> OK'); }
    catch (e) { console.log('click', sel, '-> ERROR:', e.message); }
  },

  async 'click-text'(text) {
    if (!page) return console.log('ERROR: launch first');
    const r = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('button, a, [role="button"]')];
      const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t));
      if (!el) return 'NOT_FOUND';
      el.click(); return 'OK: ' + el.tagName;
    }, text);
    console.log('click-text', JSON.stringify(text), '->', r);
  },

  // App-specific: the store-select dropdown on Set Layout/Planogram Viewer/
  // Optimization Engine/etc. takes a visible <option> label substring
  // (e.g. "Retailer X - Location 12").
  async 'select-store'(nameSubstring) {
    if (!page) return console.log('ERROR: launch first');
    const sel = page.locator('.store-select');
    if (!(await sel.count())) return console.log('ERROR: no .store-select on this view');
    const options = await sel.locator('option').allTextContents();
    const match = options.find((o) => o.includes(nameSubstring));
    if (!match) return console.log('NOT_FOUND. Available:', options);
    await sel.selectOption({ label: match });
    await page.waitForTimeout(500);
    console.log('selected store:', match);
  },

  async fill(argsStr) {
    if (!page) return console.log('ERROR: launch first');
    const sp = argsStr.indexOf(' ');
    const sel = sp === -1 ? argsStr : argsStr.slice(0, sp);
    const text = sp === -1 ? '' : argsStr.slice(sp + 1);
    await page.locator(sel).fill(text);
    console.log('fill', sel, '->', JSON.stringify(text));
  },

  async type(text) { if (page) await page.keyboard.type(text, { delay: 20 }); },
  async press(key) { if (page) await page.keyboard.press(key); },

  async wait(sel) {
    if (!page) return console.log('ERROR: launch first');
    try { await page.waitForSelector(sel, { timeout: 10_000 }); console.log('found:', sel); }
    catch { console.log('TIMEOUT:', sel); }
  },

  async eval(expr) {
    if (!page) return console.log('ERROR: launch first');
    try { console.log(JSON.stringify(await page.evaluate(expr))); }
    catch (e) { console.log('ERROR:', e.message); }
  },

  async text(sel) {
    if (!page) return console.log('ERROR: launch first');
    console.log(await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null));
  },

  async quit() { if (browser) await browser.close().catch(() => {}); browser = null; page = null; },
  help() { console.log('commands:', Object.keys(COMMANDS).join(', ')); },
};

const stdin = process.platform === 'win32'
  ? process.stdin
  : fs.createReadStream(null, { fd: fs.openSync('/dev/stdin', 'r') });
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: 'driver> ' });

// A heredoc/pipe delivers every line before the first command's promise
// resolves -- readline's 'line' event fires per-line regardless, so without
// this chain each command starts before the previous one finishes (every
// command after `launch` raced it and saw `page` still null). Queuing
// through a single promise chain serializes them.
//
// Piped/heredoc stdin also makes readline auto-close (emit 'close') the
// instant it hits EOF, which is immediately -- long before the queued async
// commands finish running. Two consequences handled below: (1) `quit` exits
// directly from its own turn in the chain rather than waiting on 'close',
// since 'close' fires way too early to use as a completion signal; (2) every
// other `rl.prompt()` call is guarded by `closed`, since calling it after
// readline has already closed throws ERR_USE_AFTER_CLOSE.
let queue = Promise.resolve();
let exited = false;
let closed = false;
function safePrompt() { if (!closed) rl.prompt(); }
rl.on('line', (line) => {
  queue = queue.then(async () => {
    const trimmed = line.trim();
    if (!trimmed) { safePrompt(); return; }
    const sp = trimmed.indexOf(' ');
    const cmd = sp === -1 ? trimmed : trimmed.slice(0, sp);
    const argsStr = sp === -1 ? '' : trimmed.slice(sp + 1).trim();
    const fn = COMMANDS[cmd];
    if (!fn) { console.log('unknown:', cmd, '-- try: help'); safePrompt(); return; }
    try { await fn(argsStr); } catch (e) { console.log('ERROR:', e.message); }
    if (cmd === 'quit') { exited = true; process.exit(0); return; }
    safePrompt();
  });
});
rl.on('close', () => { closed = true; queue.then(() => { if (!exited) process.exit(0); }); });

console.log('ShelfIntelligence driver -- "help" for commands, "launch" to start');
rl.prompt();
