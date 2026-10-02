/**
 * 本地预览服务。
 *
 * 直接把 app/src/main/assets/reader 当作站点根目录跑起来，并在 </head> 前
 * 注入一段桥接桩，让浏览器里的页面走和安卓里完全相同的代码路径。
 * 这样截图看到的就是真机上的效果，而不是另写一套预览页。
 *
 *   node tools/preview/server.mjs          # http://127.0.0.1:8800
 *   node tools/preview/server.mjs 9000
 *
 * 可用查询参数：?theme=light|dark|auto&fs=17&wrap=1&doc=other.md
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..', '..');
const ASSETS = path.join(ROOT, 'app', 'src', 'main', 'assets', 'reader');
const SAMPLES = path.join(ROOT, 'tools', 'samples');
const PORT = Number(process.argv[2] || process.env.PORT || 8800);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8'
};

function readSample(name) {
  const safe = path.basename(name || 'demo.md');
  const p = path.join(SAMPLES, safe);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

/*
 * 把字符串变成可安全内联进 <script> 的 JS 字面量。
 * 必须转义 <\/：文档里只要出现 </script>，浏览器就会提前结束脚本标签，
 * 后面的桥接桩全部变成语法错误。真机上内容走 JS 桥不经过内联脚本，
 * 所以这只是预览装置的问题，但它会让测试悄悄失效。
 */
function jsLiteral(value) {
  return JSON.stringify(String(value)).replace(/<\//g, '<\\/');
}

function stubFor(docName) {
  const content = readSample(docName) || readSample('demo.md') || '# 空文档\n';
  const title = (content.match(/^#\s+(.+)$/m) || [, '未命名文档'])[1].trim();
  return `
<script>
/* 预览用桥接桩：接口与安卓侧 @JavascriptInterface 完全一致。
   可用查询参数：theme fs wrap lh remember edit prog waccess */
window.MDRNative = (function () {
  var q = new URLSearchParams(location.search);
  var choice = q.get('theme') || 'light';
  var resolved = choice === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : choice;
  var settings = {
    theme: choice,
    fontSize: Number(q.get('fs') || 17),
    wrap: q.get('wrap') === '1',
    lineHeight: Number(q.get('lh') || 1),
    remember: q.get('remember') !== '0',
    resolvedTheme: resolved
  };
  var doc = {
    name: ${jsLiteral(docName || 'demo.md')},
    title: ${jsLiteral(title)},
    content: ${jsLiteral(content)},
    /* ?edit=0 模拟"从单文件授权打开的文档"，用来验保存失败那条支路 */
    editable: q.get('edit') !== '0',
    progress: Number(q.get('prog') || 0)
  };
  /* ?waccess=deny 先模拟"单文件授权写不回去"，补完授权之后就该能写了 */
  var writable = q.get('waccess') !== 'deny';
  return {
    getDocument: function () { return JSON.stringify(doc); },
    getSettings: function () { return JSON.stringify(settings); },
    saveSettings: function (s) { try { Object.assign(settings, JSON.parse(s)); } catch (e) {} },
    requestResolvedTheme: function () {},
    /* 浏览器里没有 shouldInterceptRequest 可以接相对资源，返回空串表示不重写，
       让图片按普通相对路径加载。安卓侧这里返回 mdr-file://local/?p= 。 */
    localPrefix: function () { return ''; },
    back: function () { document.title = '« 返回'; },
    openExternal: function (u) { console.log('[bridge] openExternal', u); },
    openRelative: function (u) { console.log('[bridge] openRelative', u); },
    copyText: function (t) { window.__copied = t; console.log('[bridge] copyText', t.length, 'chars'); },
    toast: function (m) { console.log('[bridge] toast', m); },
    saveProgress: function (p) { window.__progress = Number(p); },
    writeText: function (t) {
      if (!writable) return 'denied';
      doc.content = t; window.__written = t;
      return 'ok';
    },
    shareText: function (t) { window.__shared = t; console.log('[bridge] shareText', t.length, 'chars'); },
    requestWriteAccess: function () {
      window.__writeRequested = true;
      writable = true;
      setTimeout(function () { window.MDR.writeAccessResult(true); }, 0);
    }
  };
})();
</script>
`;
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch (e) { return send(res, 400, 'text/plain', 'bad request'); }

  const pathname = decodeURIComponent(url.pathname);

  /* 首页：注入桥接桩 */
  if (pathname === '/' || pathname === '/index.html') {
    const html = fs.readFileSync(path.join(ASSETS, 'index.html'), 'utf8');
    const out = html.replace('</head>', stubFor(url.searchParams.get('doc')) + '</head>');
    return send(res, 200, MIME['.html'], out);
  }

  /* /samples/ 指向示例目录 */
  let base = ASSETS, rel = pathname;
  if (pathname.startsWith('/samples/')) {
    base = SAMPLES;
    rel = pathname.slice('/samples'.length);
  }

  const file = path.join(base, rel);
  if (!file.startsWith(base)) return send(res, 403, 'text/plain', 'forbidden');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, 'text/plain', 'not found: ' + pathname);
  }

  send(res, 200, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', fs.readFileSync(file));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`墨读预览  http://127.0.0.1:${PORT}/`);
  console.log(`暗色      http://127.0.0.1:${PORT}/?theme=dark`);
});
