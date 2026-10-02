/**
 * 渲染管线的集成测试。
 *
 * 在无头浏览器里加载真实的 assets（预览服务会注入和安卓侧同签名的桥接桩），
 * 然后对渲染结果断言。测的是"这条链路端到端对不对"，
 * 而不是给第三方库再写一遍单元测试。
 *
 *   node tools/test/render.test.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { open } from '../preview/cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failures.push(name);
    console.log('  ✗ ' + name + (detail ? '  -> ' + detail : ''));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'preview', 'server.mjs'), String(PORT)], {
    cwd: ROOT,
    stdio: 'ignore'
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/');
      if (r.ok) return child;
    } catch (e) { /* 还没起来 */ }
    await sleep(200);
  }
  child.kill();
  throw new Error('预览服务起不来');
}

const server = await startServer();
const page = await open({ port: 9334, width: 412, height: 915, dpr: 2 });

try {
  await page.goto(`${BASE}/?doc=fixture.md`, 1500);

  const errors = await page.evaluate('JSON.stringify(window.__errors || [])');
  check('页面无脚本错误', errors === '[]', errors);

  /* ---------------- 安全 ---------------- */
  console.log('\n安全');
  check('文档里的 <script> 没有进入正文',
    await page.evaluate('document.querySelectorAll("#doc script").length') === 0);
  check('on* 事件属性被剥掉',
    await page.evaluate('document.querySelectorAll("#doc [onerror], #doc [onload], #doc [onclick]").length') === 0);
  check('javascript: 链接被拦下',
    await page.evaluate('document.querySelectorAll(\'#doc a[href^="javascript:"]\').length') === 0);
  check('危险脚本没有被执行',
    await page.evaluate('window.__pwned === undefined'));

  /* ---------------- 提示块 ---------------- */
  console.log('\n提示块');
  const calloutTitles = await page.evaluate(
    'JSON.stringify([].map.call(document.querySelectorAll(".callout-title"), function(e){return e.textContent}))');
  check('三个提示块都识别出来了',
    await page.evaluate('document.querySelectorAll(".callout").length') === 3, calloutTitles);
  check('无标题的用中文默认名',
    calloutTitles === JSON.stringify(['提示', '自定义标题', '建议']), calloutTitles);
  check('提示块正文完整保留（未把正文误当标题）',
    (await page.evaluate('(document.querySelector(".callout p")||{}).textContent || ""')).trim() === '没有自定义标题的提示块。');
  check('提示块里跨行的正文合到一段',
    (await page.evaluate('(document.querySelectorAll(".callout p")[2]||{}).textContent || ""')).replace(/\s/g, '') === '正文跨了两行。');

  /* ---------------- 列表与表格 ---------------- */
  console.log('\n列表与表格');
  check('任务列表被转换',
    await page.evaluate('document.querySelectorAll("li.task").length') === 2);
  check('已勾选项被标记',
    await page.evaluate('document.querySelectorAll("li.task.done").length') === 1);
  check('每张表格都套上了横向滚动容器',
    await page.evaluate('document.querySelectorAll("#doc table").length') ===
    await page.evaluate('document.querySelectorAll("#doc .table-wrap > table").length'));
  const align = await page.evaluate(
    '(function(){var t=document.querySelector("#doc .table-wrap table");' +
    'return JSON.stringify([].map.call(t.querySelectorAll("th"), function(e){return e.getAttribute("align")}));})()');
  check('表格对齐属性保留', align === JSON.stringify(['left', 'center', 'right']), align);

  /* ---------------- 标题与目录 ---------------- */
  console.log('\n标题与目录');
  const ids = await page.evaluate(
    'JSON.stringify([].map.call(document.querySelectorAll("#doc h1,#doc h2,#doc h3"), function(e){return e.id}))');
  const idList = JSON.parse(ids);
  check('重名标题生成了唯一 id', new Set(idList).size === idList.length, ids);
  check('目录条目数与标题数一致',
    await page.evaluate('document.querySelectorAll("#toc [data-toc]").length') ===
    await page.evaluate('document.querySelectorAll("#doc h1,#doc h2,#doc h3,#doc h4,#doc h5,#doc h6").length'));

  /* ---------------- 代码高亮 ---------------- */
  console.log('\n代码');
  check('Prism 产出了 token',
    await page.evaluate('document.querySelectorAll("#doc .token").length') > 0,
    'token 数 ' + await page.evaluate('document.querySelectorAll("#doc .token").length'));
  check('代码块有语言题头',
    (await page.evaluate('(document.querySelector(".code-lang")||{}).textContent')) === 'js');
  check('代码块有复制按钮',
    await page.evaluate('document.querySelectorAll("[data-copy]").length') > 0);

  /* ---------------- 尖括号 ---------------- */
  console.log('\n尖括号与泛型');
  const prose = await page.evaluate(
    '(function(){var ps=document.querySelectorAll("#doc p");for(var i=0;i<ps.length;i++){if(ps[i].textContent.indexOf("尖括号不该当标签")>=0)return ps[i].textContent;}return "";})()');
  check('代码块外的 vector<int> 原样显示', prose.includes('vector<int>'), JSON.stringify(prose));
  check('代码块外的 List<String> 原样显示', prose.includes('List<String>'), JSON.stringify(prose));
  check('a < b 不被当成标签', prose.includes('a < b'), JSON.stringify(prose));

  /* ---------------- 图片 ---------------- */
  console.log('\n图片');
  // 预览环境里桥接桩的 localPrefix 返回空串，所以相对路径应当原样保留，
  // 由浏览器自己去取。若被改写成 mdr-file:// 就说明重写逻辑没有按桥的指示走。
  // 取最后一张：前面安全章节里还有一张用于测试 onerror 的 <img src="x">
  const imgSrc = await page.evaluate(
    '(function(){var a=document.querySelectorAll("#doc img");var i=a[a.length-1];return i?i.getAttribute("src"):"";})()');
  check('相对路径的图片未被重写', imgSrc.indexOf('mdr-file:') !== 0 && imgSrc.indexOf('nope.png') >= 0,
    JSON.stringify(imgSrc));

  /* ---------------- 脚注 ---------------- */
  console.log('\n脚注');
  check('文末生成了脚注一节',
    await page.evaluate('document.querySelectorAll("#doc .footnotes").length') === 1);
  check('脚注条数与定义条数一致',
    await page.evaluate('document.querySelectorAll("#doc .footnotes li").length') === 2);
  check('正文里的引用被换成了上标',
    await page.evaluate('document.querySelectorAll("#doc .fn-ref").length') === 2,
    '实际 ' + await page.evaluate('document.querySelectorAll("#doc .fn-ref").length'));
  check('上标链到对应的脚注',
    await page.evaluate('document.querySelector("#doc .fn-ref a").getAttribute("href")') === '#fn-1');
  check('上标落在正文段落里，而不是自成一块',
    await page.evaluate('(document.querySelector("#doc .fn-ref a").closest("p") || {}).tagName') === 'P');
  check('脚注带回到正文的锚点',
    await page.evaluate('document.querySelectorAll("#doc .footnotes .fn-back").length') === 2);
  check('没有定义的引用保持字面量',
    await page.evaluate('document.getElementById("doc").textContent.indexOf("[^missing]") >= 0'));
  check('行内代码里的引用没被动过',
    await page.evaluate(
      '(function(){var c=document.querySelectorAll("#doc code");for(var i=0;i<c.length;i++){if(c[i].textContent==="[^1]")return true;}return false;})()'));
  check('代码块里的 [^1] 也是字面量',
    await page.evaluate(
      '(function(){var p=document.querySelectorAll("#doc pre code");for(var i=0;i<p.length;i++){if(p[i].textContent.indexOf("[^1]: 代码块里的这一行")>=0)return true;}return false;})()'));
  check('代码块里的定义行没被当成脚注',
    await page.evaluate('document.querySelector("#doc .footnotes li").textContent.indexOf("代码块里的这一行") === -1'));
  check('脚注正文里的 markdown 被解析',
    await page.evaluate('document.querySelectorAll("#doc .footnotes li strong").length') === 1);
  check('缩进续行并进了同一条',
    await page.evaluate('document.querySelectorAll("#doc .footnotes li")[1].textContent.indexOf("缩进的续行") >= 0'));
  check('上标不继承链接的下划线',
    await page.evaluate('getComputedStyle(document.querySelector("#doc .fn-ref a")).borderBottomWidth') === '0px');
  check('脚注那一节的标题不混进目录',
    await page.evaluate('!!document.querySelector("#doc .footnotes .fn-title")') === true &&
    await page.evaluate(
      '[].every.call(document.querySelectorAll("#toc .ttext"), function(a){return a.textContent !== "脚注";})'));

  /* ---------------- 目录画成了结构图 ---------------- */
  console.log('\n目录结构图');
  await page.goto(`${BASE}/?doc=demo.md`, 1500);
  check('目录是一棵树，不是一列标题',
    await page.evaluate('document.querySelectorAll("#toc .tkids .tkids").length') > 0,
    '嵌套层数 ' + await page.evaluate('document.querySelectorAll("#toc .tkids .tkids").length'));
  check('每个标题都有节点，也都留了箭头位（文字才对得齐）',
    await page.evaluate('document.querySelectorAll("#toc .tnode").length') ===
      await page.evaluate('document.querySelectorAll("#toc .tchev").length') &&
    await page.evaluate('document.querySelectorAll("#toc .tnode").length') ===
      await page.evaluate('document.querySelectorAll("#doc h1,#doc h2,#doc h3,#doc h4,#doc h5,#doc h6").length'));
  check('不再有圆点（那是时间轴的样子，不是树）',
    await page.evaluate('document.querySelectorAll("#toc .tdot").length') === 0);
  check('子节点确实嵌在父节点下面，不是平铺',
    await page.evaluate(`(function(){
      var root = document.querySelector('#toc .troot > .tnode');
      var kids = root.nextElementSibling;
      if (!kids || !kids.classList.contains('tkids')) return false;
      // 根是唯一的 h1，那么其余所有标题都该嵌在它下面
      return kids.querySelectorAll('.tnode').length ===
             document.querySelectorAll('#doc h2,#doc h3,#doc h4,#doc h5,#doc h6').length;
    })()`));
  check('有分叉的才给折叠箭头',
    await page.evaluate('document.querySelectorAll("#toc [data-fold]").length') ===
    await page.evaluate(`(function(){
      var n = 0;
      [].forEach.call(document.querySelectorAll('#toc .tnode'), function(t){
        if (t.nextElementSibling && t.nextElementSibling.classList.contains('tkids')) n++;
      });
      return n;
    })()`));
  check('叶子不带箭头，分支带',
    await page.evaluate(`(function(){
      var leaf = document.querySelector('#toc .tnode.leaf');
      var branch = document.querySelector('#toc .tkids > .tnode:not(.leaf)');
      return leaf && !leaf.querySelector('[data-fold]') && branch && branch.querySelector('[data-fold]');
    })()`));
  check('横线：分支拉到箭头就停，叶子一直拉到文字',
    await page.evaluate(`(function(){
      var leaf = document.querySelector('#toc .tnode.leaf');
      var branch = document.querySelector('#toc .tkids > .tnode:not(.leaf)');
      var wl = parseFloat(getComputedStyle(leaf, '::after').width);
      var wb = parseFloat(getComputedStyle(branch, '::after').width);
      return wb > 0 && wl > wb;
    })()`));
  check('展开时不显示数字——那时候它是多余的',
    await page.evaluate(`(function(){
      var t = document.querySelector('#toc .tnode:not(.folded) .tcount');
      return !!t && getComputedStyle(t).display === 'none';
    })()`));

  await page.evaluate(`document.querySelector('#toc .troot > .tnode .tchev').click()`);
  await sleep(320);   // 箭头是转着过去的，读太早会读到过渡中间的那个矩阵
  check('点箭头能把这一支收起来',
    await page.evaluate('document.querySelector("#toc .troot > .tnode").classList.contains("folded")') === true);
  check('收起后子节点不再占位',
    await page.evaluate(`(function(){
      var root = document.querySelector('#toc .troot > .tnode');
      var kids = root.nextElementSibling;
      return !!kids && getComputedStyle(kids).display === 'none';
    })()`));
  check('收起后右侧给出这一支有多少个标题',
    await page.evaluate(`(function(){
      var root = document.querySelector('#toc .troot > .tnode');
      var c = root.querySelector('.tcount');
      return getComputedStyle(c).display !== 'none' &&
             Number(c.textContent) === document.querySelectorAll('#toc .tnode').length - 1;
    })()`));
  check('箭头跟着转（收起时朝右）',
    await page.evaluate(`(function(){
      var root = document.querySelector('#toc .troot > .tnode');
      var chev = root.querySelector('.tchev');
      return getComputedStyle(chev, '::before').transform === 'none';
    })()`));

  await page.evaluate(`document.querySelector('#toc .troot > .tnode .tchev').click()`);
  check('再点一下能展开',
    await page.evaluate('document.querySelector("#toc .troot > .tnode").classList.contains("folded")') === false);

  // 收起来之后滚到它的分支里，得自动展开，否则"你在哪"就丢了。
  // 注意用 instant：页面开了 scroll-behavior: smooth，滚到长文底部要花很久，
  // 等它自己滑完再断言就是在测运气。
  await page.evaluate(`document.querySelector('#toc .troot > .tnode .tchev').click()`);
  check('先确认它确实收着',
    await page.evaluate('document.querySelector("#toc .troot > .tnode").classList.contains("folded")') === true);

  await page.evaluate('window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" })');
  await sleep(500);
  check('滚进收起来的分支时会自动展开',
    await page.evaluate('document.querySelector("#toc .troot > .tnode").classList.contains("folded")') === false);
  check('当前读到的节点被标出来',
    await page.evaluate('document.querySelectorAll("#toc .tnode.active").length') >= 1);

  await page.evaluate('window.scrollTo({ top: 0, behavior: "instant" })');
  await sleep(400);
  await page.evaluate('document.querySelectorAll("#toc [data-toc]")[4].click()');
  await sleep(1800);   // 跳转本身是平滑滚动，得等它走完
  check('点节点会跳到那一节去', await page.evaluate('window.scrollY') > 200,
    'scrollY = ' + await page.evaluate('window.scrollY'));

  /* ---------------- 左侧工具栏 ---------------- */
  console.log('\n左侧工具栏');
  const railOpen = 'document.getElementById("navrail").classList.contains("show")';
  await page.goto(`${BASE}/?doc=fixture.md`, 1200);
  check('平时不占屏幕', await page.evaluate(railOpen) === false);

  await page.swipe([[6, 500], [22, 500], [55, 500], [95, 500]]);
  check('从左缘右滑能拉出来', await page.evaluate(railOpen) === true);
  const railLabels = await page.evaluate(
    'JSON.stringify([].map.call(document.querySelectorAll("#navrail .rail-label"), function(e){return e.textContent}))');
  check('条目齐全',
    railLabels === JSON.stringify(['返回', '目录', '检索', '编辑', '保存', '复制', '分享', '设置']), railLabels);
  check('非编辑态不显示保存',
    await page.evaluate('document.getElementById("navSave").hidden') === true);
  check('遮罩同步出现',
    await page.evaluate('document.getElementById("railScrim").classList.contains("show")') === true);

  // 是浮在正文上的卡片，不是贴着屏幕边的板子
  const railBox = JSON.parse(await page.evaluate(`JSON.stringify((function(){
    var r = document.getElementById('navrail').getBoundingClientRect();
    var s = getComputedStyle(document.getElementById('navrail'));
    return { left: r.left, top: r.top, right: r.right,
             bottom: window.innerHeight - r.bottom,
             h: r.height, vh: window.innerHeight,
             radius: parseFloat(s.borderTopLeftRadius),
             glass: (s.backdropFilter || s.webkitBackdropFilter || 'none'),
             bg: s.backgroundColor,
             shadow: s.boxShadow };
  })())`));
  check('四周都离开了屏幕边缘，是浮着的',
    railBox.left > 4 && railBox.top > 4 && railBox.bottom > 4, JSON.stringify(railBox));
  // 高度是内容说了算。拉满整屏的话，条目占不到六成，剩下四成是空玻璃，
  // 看着就是一条侧边栏而不是一张卡片
  check('不上下拉伸，只包住条目', railBox.h < railBox.vh * 0.8,
    `rail=${Math.round(railBox.h)} viewport=${railBox.vh}`);
  check('上下留白一样多，竖直居中', Math.abs(railBox.top - railBox.bottom) <= 2,
    `top=${Math.round(railBox.top)} bottom=${Math.round(railBox.bottom)}`);
  check('四角是圆的', railBox.radius >= 14, String(railBox.radius));
  check('底是半透明的', /rgba\(.*0\.\d+\)/.test(railBox.bg), railBox.bg);
  check('开了背景模糊', /blur/.test(railBox.glass), railBox.glass);
  check('带投影', railBox.shadow !== 'none' && railBox.shadow.length > 0, railBox.shadow);

  await page.tap(330, 500);
  check('点空白处收起', await page.evaluate(railOpen) === false);

  // 屏幕任意位置右滑都该拉出来——但纵向翻页和这几个抢手势的地方要放行
  await page.swipe([[150, 700], [200, 700], [260, 700], [300, 700]]);
  check('屏幕中间右滑也能拉出来', await page.evaluate(railOpen) === true);
  await page.tap(330, 500);

  await page.swipe([[60, 300], [100, 380], [130, 460], [150, 540]]);
  check('纵向为主的斜滑不误触', await page.evaluate(railOpen) === false);
  await page.swipe([[340, 400], [280, 400], [220, 400]]);
  check('往左滑不误触', await page.evaluate(railOpen) === false);

  // 表格已经横向滚出去了，那一下该归表格把内容滚回来
  const tableBox = JSON.parse(await page.evaluate(`JSON.stringify((function(){
    var all = document.querySelectorAll('.table-wrap');
    var w = all[all.length - 1];   // 最后一张才是那个五列的宽表
    if (!w) return null;
    // 前面几次滑动已经把页面滚下去了，先把它挪回视野中间再取坐标，
    // 否则点击落空，测的就不是"表格吃掉手势"而是"点在空白处"
    w.scrollIntoView({ block: 'center', behavior: 'instant' });
    w.scrollLeft = 60;
    var r = w.getBoundingClientRect();
    return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2),
             scrolled: w.scrollLeft, overflow: w.scrollWidth - w.clientWidth };
  })())`));
  check('样本里有一张会横向溢出的表格',
    tableBox && tableBox.overflow > 40 && tableBox.scrolled > 0, JSON.stringify(tableBox));
  await page.swipe([[tableBox.x, tableBox.y], [tableBox.x + 40, tableBox.y],
                    [tableBox.x + 80, tableBox.y], [tableBox.x + 120, tableBox.y]]);
  check('表格滚出去之后，右滑归表格不归工具栏',
    await page.evaluate(railOpen) === false);

  await page.swipe([[6, 500], [22, 500], [60, 500], [95, 500]]);
  check('再拉开一次', await page.evaluate(railOpen) === true);
  check('返回键先收工具栏而不是退出阅读',
    await page.evaluate('String(MDR.handleBack())') === 'true');
  check('工具栏已收起', await page.evaluate(railOpen) === false);

  // 编辑时正文那一大片的横拖是拖选文字，不能抢
  await page.goto(`${BASE}/?doc=fixture.md`, 1200);
  await page.evaluate('MDR.startEdit()');
  await page.swipe([[150, 500], [200, 500], [260, 500], [310, 500]]);
  check('编辑态里正文区的横拖归选字，不拉栏', await page.evaluate(railOpen) === false);
  await page.swipe([[6, 500], [22, 500], [60, 500], [95, 500]]);
  check('编辑态里左缘仍然拉得出工具栏（保存和预览在这里）',
    await page.evaluate(railOpen) === true);

  /* ---------------- 编辑 ---------------- */
  console.log('\n编辑与保存');
  await page.goto(`${BASE}/?doc=fixture.md`, 1200);
  check('默认不在编辑态',
    await page.evaluate('document.getElementById("editor").classList.contains("show")') === false);

  await page.evaluate('MDR.startEdit()');
  check('进入编辑', await page.evaluate('document.getElementById("editor").classList.contains("show")') === true);
  check('工具栏那一条变成"预览"',
    await page.evaluate('document.getElementById("navEditLabel").textContent') === '预览');
  check('编辑器带出的是原始 Markdown',
    await page.evaluate('document.getElementById("editorArea").value.indexOf("# 渲染测试样本") === 0'));
  check('编辑态下保存入口出现',
    await page.evaluate('document.getElementById("navSave").hidden') === false);

  await page.evaluate(
    '(function(){var ta=document.getElementById("editorArea");ta.focus();' +
    'var i=ta.value.indexOf("渲染测试样本");ta.setSelectionRange(i,i+6);})()');
  await page.evaluate('document.querySelector(\'[data-md="b"]\').click()');
  check('粗体按钮把选中内容包了起来',
    await page.evaluate('document.getElementById("editorArea").value.indexOf("**渲染测试样本**") >= 0'));
  check('改动后标记为未保存',
    await page.evaluate('document.getElementById("editorState").textContent') === '未保存');
  check('未保存时状态变色',
    await page.evaluate('document.getElementById("editorState").classList.contains("dirty")') === true);
  check('字数统计跟着更新',
    await page.evaluate('document.getElementById("editorStat").textContent.indexOf("行") > 0'));

  await page.evaluate('document.getElementById("navSave").click()');
  check('保存把当前内容交给了原生',
    await page.evaluate('window.__written === document.getElementById("editorArea").value'));
  check('保存后回到已保存状态',
    await page.evaluate('document.getElementById("editorState").textContent') === '已保存');

  await page.evaluate('document.getElementById("navEdit").click()');
  check('切回阅读后编辑器收起',
    await page.evaluate('document.getElementById("editor").classList.contains("show")') === false);
  check('正文按改动后的内容重排',
    await page.evaluate('!!document.querySelector("#doc h1 strong")') === true);

  console.log('\n未保存就退出');
  await page.goto(`${BASE}/?doc=fixture.md`, 1200);
  await page.evaluate('MDR.startEdit()');
  await page.evaluate(
    '(function(){var ta=document.getElementById("editorArea");ta.value+="x";ta.dispatchEvent(new Event("input"));})()');
  check('返回键拦下来问一句，而不是直接丢掉',
    await page.evaluate('String(MDR.handleBack())') === 'true');
  check('确认框出现', await page.evaluate('document.getElementById("confirm").classList.contains("show")') === true);
  check('人还留在编辑器里',
    await page.evaluate('document.getElementById("editor").classList.contains("show")') === true);
  await page.evaluate('document.getElementById("confirmActs").querySelectorAll("button")[2].click()');
  check('选"放弃改动"后回到阅读',
    await page.evaluate('document.getElementById("editor").classList.contains("show")') === false);
  check('放弃之后正文没有被写脏',
    await page.evaluate('document.querySelectorAll("#doc h1 strong").length') === 0);

  console.log('\n补授权后重试保存');
  await page.goto(`${BASE}/?doc=fixture.md&waccess=deny`, 1200);
  await page.evaluate('MDR.startEdit()');
  await page.evaluate(
    '(function(){var ta=document.getElementById("editorArea");ta.value+="插入一行";ta.dispatchEvent(new Event("input"));})()');
  await page.evaluate('document.getElementById("navSave").click()');
  check('写不进去时引导补一次文件夹授权',
    await page.evaluate('document.getElementById("confirm").classList.contains("show")') === true);
  await page.evaluate('document.getElementById("confirmActs").querySelectorAll("button")[1].click()');
  await sleep(300);
  check('补完授权自动重试保存',
    await page.evaluate('window.__writeRequested === true && typeof window.__written === "string"'));

  /* ---------------- 阅读位置 ---------------- */
  console.log('\n阅读位置');
  await page.goto(`${BASE}/?doc=fixture.md&prog=0.5`, 1500);
  const maxScroll = await page.evaluate('document.body.scrollHeight - window.innerHeight');
  const restoredY = await page.evaluate('window.scrollY');
  check('按上次的位置打开', maxScroll > 200 && restoredY > maxScroll * 0.3,
    `y=${restoredY} max=${maxScroll}`);
  const reported = Number(await page.evaluate('MDR.currentProgress()'));
  check('报得出当前读到哪儿', reported > 0.3 && reported <= 0.6, String(reported));

  await page.evaluate('window.__progress = -1; window.scrollTo(0, 0)');
  await sleep(1400);   // 写入是节流的，等它落地
  check('滚动之后位置写回了原生',
    await page.evaluate('window.__progress === 0'), String(await page.evaluate('window.__progress')));

  await page.goto(`${BASE}/?doc=fixture.md&prog=0.5&remember=0`, 1200);
  check('关掉"记住位置"之后不回跳',
    await page.evaluate('window.scrollY') === 0);

  /* ---------------- 空文档与不可写 ---------------- */
  console.log('\n空文档');
  await page.goto(`${BASE}/?doc=blank.md`, 1200);
  check('空文档不是一片空白，而是给了入口',
    await page.evaluate('!!document.getElementById("emptyEdit")'));
  check('空文档不生成目录',
    await page.evaluate('document.querySelectorAll("#toc [data-toc]").length') === 0);
  await page.evaluate('document.getElementById("emptyEdit").click()');
  check('入口直接进编辑',
    await page.evaluate('document.getElementById("editor").classList.contains("show")') === true);

  await page.goto(`${BASE}/?doc=blank.md&edit=0`, 1200);
  check('不可写时不出现"开始写"',
    await page.evaluate('!document.getElementById("emptyEdit")'));
  await page.evaluate('MDR.startEdit()');
  check('不可写时进不了编辑',
    await page.evaluate('document.getElementById("editor").classList.contains("show")') === false);

  /* ---------------- 设置项 ---------------- */
  console.log('\n设置项');
  await page.goto(`${BASE}/?doc=fixture.md&lh=3`, 1200);
  check('行距档位生效',
    await page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--lh").trim()') === '2.12');
  check('设置里有"记住阅读位置"',
    await page.evaluate('!!document.getElementById("rememberToggle")'));
  check('屏幕里已经没有顶栏了',
    await page.evaluate('document.querySelectorAll(".topbar").length') === 0);

  /* ---------------- 统计 ---------------- */
  const tokens = await page.evaluate('document.querySelectorAll("#doc .token").length');
  console.log(`\n共 ${passed} 项通过，${failures.length} 项失败（token 数 ${tokens}）`);
  if (failures.length) {
    console.log('失败项：');
    failures.forEach((f) => console.log('  - ' + f));
  }
} finally {
  page.close();
  server.kill();
}

process.exit(failures.length ? 1 : 0);
