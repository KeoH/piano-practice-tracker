#!/usr/bin/env node
// Takes the README screenshots: opens the dev server in headless Chrome with a fake Tauri IPC
// (`demo-ipc.js`, invented data), walks through the main views and saves them in docs/screenshots/.
// Drives Chrome over the DevTools protocol with Node's built-in WebSocket: no extra dependencies.
//
// Usage: `npm start` in another terminal, then `node scripts/screenshots/capture.mjs [url]`.
// CHROME=/path/to/chrome overrides the browser.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', '..', 'docs', 'screenshots');
const url = process.argv[2] ?? 'http://localhost:4200';
const chrome = process.env.CHROME ?? 'google-chrome';
const port = 9300 + Math.floor(Math.random() * 500);
const WIDTH = 1440;
const HEIGHT = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, what, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not ready yet
    }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(200);
  }
}

const profile = mkdtempSync(join(tmpdir(), 'piano-shots-'));
const browser = spawn(
  chrome,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${WIDTH},${HEIGHT}`,
    '--lang=en-US',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let ws;
try {
  const target = await retry(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    return res.ok && (await res.json());
  }, 'Chrome');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
    return r.result.value;
  };
  /** Clicks the first `selector` element whose text includes `text`. */
  const click = (selector, text = '') =>
    retry(
      () =>
        evaluate(`(() => {
          const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
            .find((e) => e.textContent.includes(${JSON.stringify(text)}));
          if (!el) return false;
          el.click();
          return true;
        })()`),
      `${selector} "${text}"`,
    );
  const waitFor = (selector) => retry(() => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
  const shoot = async (name) => {
    await sleep(900); // canvases redraw on the next frames, the composer loads with @defer
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outDir, name), Buffer.from(data, 'base64'));
    console.log(`docs/screenshots/${name}`);
  };

  mkdirSync(outDir, { recursive: true });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: readFileSync(join(here, 'demo-ipc.js'), 'utf8') });
  await send('Page.navigate', { url });
  await waitFor('app-sidebar nav button');

  // The session view: the raw take on the piano roll, ready to slice.
  await click('app-sidebar li button', 'Evening practice');
  await waitFor('app-midi-slicer canvas');
  await shoot('session.png');

  // Its fragments, with their comments on the timeline.
  await click('[role=tab]', 'Fragments');
  await click('app-fragment-player button[aria-expanded]');
  await waitFor('app-fragment-player canvas');
  await shoot('fragments.png');

  // The composer.
  await click('app-sidebar nav button', 'Compose');
  await click('app-sidebar li button', 'Nocturne medley');
  await waitFor('app-composer-timeline');
  await shoot('composer.png');

  // The repertoire: takes of a piece grouped by passage.
  await click('app-sidebar nav button', 'Repertoire');
  await click('app-sidebar li button', 'Nocturne');
  await waitFor('app-pieces-view canvas');
  await shoot('pieces.png');

  // Practice statistics.
  await click('app-sidebar nav button', 'Statistics');
  await waitFor('app-stats-view svg');
  await shoot('stats.png');
} finally {
  ws?.close();
  browser.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
