import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const htmlPath = resolve('/Users/jaygohil/Desktop/27-Apr/login.html');
const pageUrl = `file://${htmlPath}`;
const port = 9222;
const userDataDir = mkdtempSync(join(tmpdir(), 'cline-chrome-'));

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => (body += chunk));
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Invalid JSON from ${path}: ${body}`));
        }
      });
    }).on('error', reject);
  });
}

function websocketRequest(wsUrl, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(wsUrl);
    const key = Buffer.from(`${Date.now()}-${Math.random()}`).toString('base64');
    const socket = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    });

    socket.on('upgrade', (_res, conn) => {
      const json = JSON.stringify(payload);
      const data = Buffer.from(json);
      const header = [];
      header.push(0x81);
      if (data.length < 126) {
        header.push(0x80 | data.length);
      } else if (data.length < 65536) {
        header.push(0x80 | 126, (data.length >> 8) & 255, data.length & 255);
      } else {
        reject(new Error('Payload too large'));
        conn.destroy();
        return;
      }
      const mask = Buffer.from([1, 2, 3, 4]);
      header.push(...mask);
      const masked = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
      conn.write(Buffer.concat([Buffer.from(header), masked]));

      let buffer = Buffer.alloc(0);
      conn.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 2) return;
        const lengthByte = buffer[1] & 0x7f;
        let offset = 2;
        let length = lengthByte;
        if (lengthByte === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (lengthByte === 127) {
          reject(new Error('Large websocket frame not supported'));
          conn.destroy();
          return;
        }
        if (buffer.length < offset + length) return;
        const message = buffer.subarray(offset, offset + length).toString('utf8');
        try {
          const parsed = JSON.parse(message);
          if (parsed.id === payload.id) {
            resolve(parsed);
            conn.end();
          }
        } catch (error) {
          reject(error);
          conn.destroy();
        }
      });
      conn.on('error', reject);
    });

    socket.on('error', reject);
    socket.end();
  });
}

async function waitForChrome() {
  for (let i = 0; i < 60; i++) {
    try {
      return await httpJson('/json');
    } catch {
      await delay(250);
    }
  }
  throw new Error('Chrome DevTools endpoint did not become available');
}

const chrome = spawn(chromePath, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=900,700',
  pageUrl,
], { detached: true, stdio: 'ignore' });
chrome.unref();

await waitForChrome();
await delay(1000);
const tabs = await httpJson('/json');
const tab = tabs.find(t => t.url === pageUrl || t.url.startsWith(pageUrl)) ?? tabs[0];
if (!tab?.webSocketDebuggerUrl) throw new Error('Could not find browser tab websocket URL');

const expression = `
(async () => {
  const events = [];
  const form = document.querySelector('form');
  form.addEventListener('submit', event => {
    event.preventDefault();
    window.__formSubmitted = true;
    events.push('form submitted');
  });

  document.querySelector('#email').focus();
  document.querySelector('#email').value = 'tester@example.com';
  document.querySelector('#email').dispatchEvent(new Event('input', { bubbles: true }));
  events.push('input text into email field');

  document.querySelector('#password').value = 'Secret123!';
  document.querySelector('#password').dispatchEvent(new Event('input', { bubbles: true }));
  events.push('input text into password field');

  document.querySelector('input[name="remember"]').click();
  events.push('clicked checkbox button-like element');

  document.querySelector('button[type="submit"]').click();
  events.push('clicked Login button and submitted form');

  const spacer = document.createElement('div');
  spacer.id = 'runtime-scroll-spacer';
  spacer.style.height = '1200px';
  spacer.style.width = '1px';
  spacer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(spacer);
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
  await new Promise(resolve => setTimeout(resolve, 100));
  events.push('scrolled down the page');

  return {
    pageTitle: document.title,
    pageUrl: location.href,
    emailValue: document.querySelector('#email').value,
    passwordHasValue: document.querySelector('#password').value.length > 0,
    rememberChecked: document.querySelector('input[name="remember"]').checked,
    formSubmitted: window.__formSubmitted === true,
    scrollY: window.scrollY,
    maxScrollY: document.documentElement.scrollHeight - window.innerHeight,
    events,
  };
})()
`;

const response = await websocketRequest(tab.webSocketDebuggerUrl, {
  id: 1,
  method: 'Runtime.evaluate',
  params: { expression, awaitPromise: true, returnByValue: true },
});

if (response.error || response.result?.exceptionDetails) {
  throw new Error(JSON.stringify(response, null, 2));
}

const result = response.result.result.value;
writeFileSync('/Users/jaygohil/Desktop/27-Apr/browser-interactions-result.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
