/**
 * 把 node_modules 里的前端依赖搬进 app assets。
 *
 * 为什么要有这一步：安卓 assets 是运行时直接读的，不能引用 node_modules，
 * 也不该在运行时依赖 CDN（这是个纯本地阅读器，断网必须能用）。
 *
 *   node tools/vendor.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const NM = path.join(ROOT, 'tools', 'node_modules');
const OUT = path.join(ROOT, 'app', 'src', 'main', 'assets', 'reader', 'vendor');

/*
 * 想要的语言。顺序无所谓——下面会读 Prism 自己的 components.json
 * 把依赖补全并做拓扑排序。
 *
 * 这件事必须自动化：之前手工排的顺序漏了 markup-templating，
 * 而 php 组件会在全局 after-tokenize 钩子里无条件调用
 * Prism.languages["markup-templating"].tokenizePlaceholders()，
 * 结果每一种语言的高亮都会被它带崩。
 */
const WANTED = [
  'bash', 'batch', 'c', 'cpp', 'csharp', 'cmake', 'dart', 'diff', 'docker',
  'git', 'glsl', 'go', 'graphql', 'groovy', 'hlsl', 'http', 'ini', 'java',
  'json', 'jsx', 'kotlin', 'less', 'lua', 'makefile', 'markdown', 'nginx',
  'objectivec', 'perl', 'php', 'powershell', 'protobuf', 'python', 'r',
  'ruby', 'rust', 'scala', 'scss', 'sql', 'swift', 'toml', 'tsx', 'typescript',
  'yaml', 'zig'
];

/* prism.js 里已经内置了这几种，不必也不该重复引入 */
const IN_CORE = new Set(['markup', 'css', 'clike', 'javascript']);

const pkg = (name) => path.join(NM, name);
const read = (p) => fs.readFileSync(p, 'utf8');

/** 依赖优先的拓扑排序；环直接放过，交给 Prism 自己的加载顺序约定 */
function resolveOrder(wanted, meta) {
  const order = [], done = new Set(), visiting = new Set();
  function visit(name) {
    if (done.has(name) || visiting.has(name)) return;
    visiting.add(name);
    const info = meta[name];
    if (info) {
      for (const dep of [].concat(info.require || [], info.modify || [])) visit(dep);
    }
    visiting.delete(name);
    done.add(name);
    order.push(name);
  }
  wanted.forEach(visit);
  return order;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

console.log('复制库文件');
function copy(from, toName) {
  const dest = path.join(OUT, toName);
  fs.copyFileSync(from, dest);
  console.log(`  ${toName.padEnd(18)} ${(fs.statSync(dest).size / 1024).toFixed(0).padStart(6)} KB`);
}

/* marked：只发布了 UMD / ESM，没有压缩版，直接用 UMD */
copy(pkg('marked/lib/marked.umd.js'), 'marked.js');
/* DOMPurify：清洗 marked 产出的 HTML，防止 md 文件里的脚本在 WebView 里执行 */
copy(pkg('dompurify/dist/purify.min.js'), 'purify.js');

/* --------------------------- Prism --------------------------- */

console.log('\n拼接 Prism');

const componentsMetaPath = pkg('prismjs/components.json');
if (!fs.existsSync(componentsMetaPath)) throw new Error('找不到 prismjs/components.json');
/* 结构是 { core, themes, languages, plugins }，语言元数据在 languages 下 */
const componentsMeta = JSON.parse(read(componentsMetaPath)).languages;
if (!componentsMeta) throw new Error('components.json 里没有 languages 段');

const fullOrder = resolveOrder(WANTED, componentsMeta);
const emitOrder = fullOrder.filter((n) => !IN_CORE.has(n));
const extra = fullOrder.filter((n) => !WANTED.includes(n));

const parts = [
  '/* Prism core + 常用语言，由 tools/vendor.mjs 生成，请勿手改 */',
  'window.Prism = window.Prism || {};',
  'window.Prism.manual = true;',   // 关掉自动高亮，由 reader.js 在渲染后主动调用
  read(pkg('prismjs/prism.js'))
];

const missing = [];
for (const lang of emitOrder) {
  const f = pkg(`prismjs/components/prism-${lang}.min.js`);
  if (!fs.existsSync(f)) { missing.push(lang); continue; }
  parts.push(`/* --- prism: ${lang} --- */`, read(f));
}

const prismPath = path.join(OUT, 'prism.js');
fs.writeFileSync(prismPath, parts.join('\n'));
console.log(`  prism.js           ${(fs.statSync(prismPath).size / 1024).toFixed(0).padStart(6)} KB  (核心 + ${emitOrder.length - missing.length} 种语言)`);

if (extra.length) console.log(`  自动补入的依赖：${extra.join(', ')}`);
if (missing.length) console.warn(`  警告：缺少组件 -> ${missing.join(', ')}`);

/* ------------------------- 许可证 ------------------------- */

const LIBS = [
  ['marked', 'lib/marked.umd.js', 'MIT'],
  ['dompurify', 'dist/purify.min.js', 'Apache-2.0 或 MPL-2.0'],
  ['prismjs', 'prism.js', 'MIT']
];
let lic = '# 第三方库许可\n\n墨读在 `app/src/main/assets/reader/vendor/` 下随包分发以下库，' +
  '均由 `tools/vendor.mjs` 从 npm 复制而来。\n\n';
for (const [dir, file, license] of LIBS) {
  lic += `## ${dir}\n\n- 许可：${license}\n- 文件：\`vendor/${path.basename(file)}\`\n\n\`\`\`\n`;
  const candidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license'];
  let text = '';
  for (const c of candidates) {
    const p = path.join(NM, dir, c);
    if (fs.existsSync(p)) { text = read(p); break; }
  }
  lic += (text.trim() || '（未能读取许可证文件，请见 npm 包内 LICENSE）') + '\n```\n\n';
}
fs.writeFileSync(path.join(ROOT, 'THIRD-PARTY-LICENSES.md'), lic);

console.log('\n完成 -> app/src/main/assets/reader/vendor/');
