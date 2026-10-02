/**
 * 用无头 Edge 给页面截图。
 *
 *   node tools/preview/shot.mjs <url> <out.png> [选项]
 *
 * 选项
 *   --w=412 --h=915        视口尺寸（默认手机竖屏）
 *   --dpr=3                像素密度
 *   --full                 截整页
 *   --clip=x,y,w,h         只截一块（CSS 像素）。配合高 dpr 看字体与间距细节，
 *                          整屏截图在预览里会被缩得看不清
 *   --wait=1200            加载后额外等待
 *   --scroll=N             先滚到某个位置
 *   --click="selector"     点一下再截
 *   --swipe="x,y;x,y;..."  依次滑过这些点再截（调左缘拉出工具栏这类手势用）
 *   --eval="js"            执行一段 JS 并打印结果（查布局用）
 */
import { open } from './cdp.mjs';

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const flag = (name) => argv.includes('--' + name);

const url = positional[0];
const out = positional[1];
if (!url || !out) {
  console.error('用法: node tools/preview/shot.mjs <url> <out.png> [--w= --h= --dpr= --full --clip= --eval=]');
  process.exit(2);
}

const page = await open({
  width: Number(opt('w', 412)),
  height: Number(opt('h', 915)),
  dpr: Number(opt('dpr', 3))
});

try {
  await page.goto(url, Number(opt('wait', 1200)));

  const errors = await page.evaluate('JSON.stringify(window.__errors || [])');
  if (errors && errors !== '[]') console.log('页面错误:', errors);

  const clickSel = opt('click', null);
  if (clickSel) {
    await page.evaluate(`document.querySelector(${JSON.stringify(clickSel)}).click()`);
    await new Promise((r) => setTimeout(r, 500));
  }

  const scrollTo = opt('scroll', null);
  if (scrollTo !== null) {
    await page.evaluate(`window.scrollTo(0, ${Number(scrollTo)})`);
    await new Promise((r) => setTimeout(r, 500));
  }

  const evalExpr = opt('eval', null);
  if (evalExpr) {
    const v = await page.evaluate(evalExpr);
    console.log('eval ->', typeof v === 'object' ? JSON.stringify(v, null, 2) : v);
  }

  // 手势放在最后：它就是被拍的那个动作，
  // 而 --eval 通常是用来先把页面摆到某个状态的（比如先进编辑态再拉栏）
  const swipeRaw = opt('swipe', null);
  if (swipeRaw) {
    const points = swipeRaw.split(';').map((p) => p.split(',').map(Number));
    await page.swipe(points);
  }

  // 上面这些操作多半会触发过渡动画，不等它走完就会截到一半的中间态
  const pause = Number(opt('pause', 600));
  if (pause > 0) await new Promise((r) => setTimeout(r, pause));

  const clipRaw = opt('clip', null);
  const clip = clipRaw
    ? (([x, y, width, height]) => ({ x, y, width, height }))(clipRaw.split(',').map(Number))
    : null;

  await page.screenshot(out, { full: flag('full'), clip });
  const fs = await import('node:fs');
  console.log(`已截图 ${out}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
} finally {
  page.close();
}
