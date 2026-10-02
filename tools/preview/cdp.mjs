/**
 * 一个够用的 DevTools Protocol 客户端。
 *
 * 截图和测试都要"以真机视口加载真实页面然后检查它"，
 * 这套连接逻辑抽出来共用，免得两边各写一份。
 *
 * 为什么不用 --screenshot：新版 Chromium 的 --headless=new 已不支持它，
 * 而 --headless=old 的视口控制不可靠，拿不到准确的设备尺寸。
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const EDGE = process.env.EDGE_PATH ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE_ROOT = path.resolve(import.meta.dirname, '..', '..', '.toolchain');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.method + ': ' + msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        const h = this.handlers.get(msg.method);
        if (h) h(msg.params);
      }
    });
  }

  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('超时: ' + method));
        }
      }, 30000);
    });
  }

  on(method, fn) { this.handlers.set(method, fn); }
}

async function waitForPort(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('等不到 CDP 端口 ' + port);
}

/**
 * 打开一个无头浏览器并连上，返回若干操作句柄。
 * 用完必须调 close()，否则 Edge 进程会留下。
 */
export async function open({ port = 9333, width = 412, height = 915, dpr = 3, mobile = true } = {}) {
  // 每次运行用独立的 profile 目录。
  // 共用同一个目录时，只要有一个残留的 Edge 进程活着，新进程就会把参数转交给它，
  // 于是我们连上的是上一次的浏览器，甚至在旧端口上等半天——这个坑必须绕开。
  const profile = path.join(PROFILE_ROOT, 'edgeprofile-' + process.pid + '-' + port);

  const child = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });

  const ws = new WebSocket(await waitForPort(port));
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
  });

  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: dpr, mobile
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  async function evaluate(expression) {
    const r = await cdp.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面里抛异常: ' +
        (r.exceptionDetails.exception && r.exceptionDetails.exception.description
          || r.exceptionDetails.text));
    }
    return r.result ? r.result.value : undefined;
  }

  async function goto(url, waitMs = 1200) {
    const loaded = new Promise((res) => {
      cdp.on('Page.loadEventFired', res);
      setTimeout(res, 10000);
    });
    await cdp.send('Page.navigate', { url });
    await loaded;
    await sleep(waitMs);
  }

  async function screenshot(file, { full = false, clip = null } = {}) {
    const params = { format: 'png', captureBeyondViewport: full || !!clip };
    if (clip) params.clip = { ...clip, scale: dpr };
    if (full) {
      const h = await evaluate('document.documentElement.scrollHeight');
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height: Math.min(h || height, 30000), deviceScaleFactor: dpr, mobile
      });
      await sleep(400);
    }
    const shot = await cdp.send('Page.captureScreenshot', params);
    const fs = await import('node:fs');
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return file;
  }

  /**
   * 模拟一次单指手势。用 CDP 派发的是真实事件，会走完整的命中测试，
   * 所以能验证"左缘热区有没有被别的东西挡住"这类问题——
   * 在页面里自己 dispatchEvent 是验不出来的。
   *
   * @param {Array<[number, number]>} points 依次经过的坐标
   */
  async function swipe(points, stepMs = 20) {
    const [first, ...rest] = points;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ x: first[0], y: first[1], id: 1 }]
    });
    for (const [x, y] of rest) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x, y, id: 1 }]
      });
      await sleep(stepMs);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(420);   // 等回弹动画走完
  }

  /** 轻点一下。用来验证某块覆盖层真的接得住触摸。 */
  async function tap(x, y) {
    return swipe([[x, y], [x, y]], 0);
  }

  function close() {
    try { ws.close(); } catch (e) { /* 已关闭 */ }
    // Edge 会派生子进程，child.kill() 只能带走父进程，剩下的会变成孤儿占住端口。
    // 必须按进程树杀。
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    } catch (e) {
      try { child.kill(); } catch (e2) { /* 已退出 */ }
    }
  }

  return { cdp, evaluate, goto, screenshot, swipe, tap, close };
}
