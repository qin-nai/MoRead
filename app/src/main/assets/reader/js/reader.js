/* ==========================================================================
   墨读 · reader.js
   阅读器全部交互逻辑。设计原则：原生只负责"给文件、存设置、写回文件"，
   所有界面都在这里，这样两端不会各写一半、对不上。
   ========================================================================== */

(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ------------------------------------------------------------------ *
   * 与安卓的桥
   * 浏览器里预览时 MDRNative 不存在，全部调用静默失败，不影响渲染。
   * ------------------------------------------------------------------ */

  var Native = window.MDRNative || null;

  function call(name, arg) {
    if (!Native) return undefined;
    var fn = Native[name];
    if (typeof fn !== 'function') return undefined;
    try { return arg === undefined ? fn.call(Native) : fn.call(Native, arg); }
    catch (e) { return undefined; }
  }

  /*
   * 相对资源（文档同目录的图片）在安卓侧要靠原生拦截请求才能读出来。
   * 重写前缀由原生给：给了才重写，没给就保持原样让浏览器自己取。
   * 这样浏览器预览和真机走的是同一份代码，不需要分支。
   */
  var LOCAL_PREFIX = (function () {
    var p = call('localPrefix');
    return typeof p === 'string' ? p : '';
  })();

  function callJson(name, arg) {
    var raw = call(name, arg);
    if (typeof raw !== 'string' || !raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */

  var LH_STEPS = [1.62, 1.78, 1.95, 2.12];
  var LH_NAMES = ['紧', '标准', '松', '舒'];

  var state = {
    settings: { theme: 'auto', fontSize: 17, wrap: false, lineHeight: 1, remember: true },
    resolvedTheme: 'light',
    toc: [],
    treeById: null,
    /** 折起来的节点，按 id 记。重渲染时用它把折痕还原回去 */
    collapsed: null,
    headingEls: [],
    headingTops: [],
    baseHtml: '',
    hits: [],
    hitIndex: -1,
    docName: '',
    docTitle: '',
    markdown: '',
    /** 磁盘上那一份的内容。编辑时拿它对比才知道有没有改动 */
    savedMarkdown: '',
    editable: false,
    progress: 0,
    editing: false,
    dirty: false,
    activeTocId: ''
  };

  var dom = {};

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */

  function toast(msg) {
    if (!dom.toast) return;
    dom.toast.textContent = msg;
    dom.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { dom.toast.classList.remove('show'); }, 1800);
  }

  function escapeText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* 与 GitHub 接近的锚点规则，保留中文，这样文档里手写的 #某标题 能对上 */
  function uniqueSlug(text, seen) {
    var base = String(text || '').trim().toLowerCase()
      .replace(/[\s　]+/g, '-')
      .replace(/[^\w㐀-䶿一-鿿぀-ヿ-]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '');
    if (!base) base = 'section';
    if (seen[base] == null) { seen[base] = 0; return base; }
    seen[base] += 1;
    return base + '-' + seen[base];
  }

  function throttleRaf(fn) {
    var queued = false;
    return function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; fn(); });
    };
  }

  /* 中文按字算，西文按词算，"多少字"对读者就是"有多长" */
  function countText(text) {
    var CJK = /[㐀-䶿一-鿿぀-ヿ가-힯]/g;
    var cjk = (String(text).match(CJK) || []).length;
    var words = (String(text).replace(CJK, ' ').match(/[A-Za-z0-9_'’-]+/g) || []).length;
    return cjk + words;
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function render(markdown) {
    if (!window.marked || !window.DOMPurify) {
      dom.doc.innerHTML = '<div class="empty"><b>渲染组件未就绪</b>请检查 vendor 目录是否完整</div>';
      return;
    }

    var rawHtml;
    try {
      rawHtml = window.marked.parse(preprocessMarkdown(markdown), { gfm: true, breaks: false });
    } catch (e) {
      dom.doc.innerHTML = '<div class="empty"><b>解析失败</b>' + escapeText(String(e && e.message || e)) + '</div>';
      return;
    }

    /* 清洗放在最前面：md 文件是外部输入，不能让其中的脚本进到 WebView 里跑。
       相对路径的重写在清洗之后做，否则会被 DOMPurify 的 URI 白名单拦掉。 */
    var clean = window.DOMPurify.sanitize(rawHtml, {
      ADD_TAGS: ['input', 'details', 'summary'],
      ADD_ATTR: ['align', 'type', 'checked', 'disabled', 'id', 'class']
    });

    var parsed = new DOMParser().parseFromString(clean, 'text/html');
    var root = parsed.body;

    postProcess(root);
    insertMeta(root, markdown);

    /* 空文档：与其给一片空白，不如直接告诉人从哪儿开始写 */
    if (!String(markdown || '').trim()) {
      dom.doc.innerHTML = '<div class="doc-empty"><b>这份文档还是空的</b>' +
        '<p>' + (state.editable ? '点下面的按钮开始写，内容会存回这个文件。' : '这份文档还没有内容。') + '</p>' +
        (state.editable ? '<button type="button" id="emptyEdit">开始写</button>' : '') + '</div>';
      state.headingEls = [];
      buildToc();
      return;
    }

    dom.doc.innerHTML = root.innerHTML;

    /* 渲染完才能量位置 */
    state.headingEls = $$('h1,h2,h3,h4,h5,h6', dom.doc);
    dom.doc.querySelectorAll('img').forEach(function (img) {
      if (!img.complete) img.addEventListener('load', onImageLoad, { once: true });
    });

    buildToc();
    measureHeadings();
    highlightCode();
  }

  /*
   * 正文顶部一行元信息：字数与预计阅读时长。
   * 中文按 420 字/分、西文按 220 词/分估算。
   */
  function insertMeta(root, markdown) {
    var text = String(markdown || '');
    var CJK = /[㐀-䶿一-鿿぀-ヿ가-힯]/g;
    var cjk = (text.match(CJK) || []).length;
    var words = (text.replace(CJK, ' ').match(/[A-Za-z0-9_'’-]+/g) || []).length;
    var minutes = Math.max(1, Math.round(cjk / 420 + words / 220));

    var meta = document.createElement('div');
    meta.className = 'doc-meta';
    var a = document.createElement('span');
    a.textContent = (cjk + words) + ' 字';
    var dot = document.createElement('span');
    dot.className = 'dot';
    dot.textContent = '·';
    var b = document.createElement('span');
    b.textContent = '约 ' + minutes + ' 分钟';
    meta.appendChild(a);
    meta.appendChild(dot);
    meta.appendChild(b);

    var h1 = root.querySelector('h1');
    if (h1) h1.after(meta);
    else root.insertBefore(meta, root.firstChild);
  }

  function postProcess(root) {
    /* --- 标题：补 id，同时收集目录 --- */
    state.toc = [];
    var seen = Object.create(null);
    $$('h1,h2,h3,h4,h5,h6', root).forEach(function (h) {
      var text = (h.textContent || '').replace(/\s+/g, ' ').trim();
      var id = uniqueSlug(text, seen);
      h.id = id;
      state.toc.push({ id: id, level: parseInt(h.tagName.charAt(1), 10), text: text });
    });

    /* --- 提示块 --- */
    convertCallouts(root);

    /* --- 脚注 --- */
    convertFootnotes(root);

    /* --- 代码块：题头 + 复制按钮 --- */
    $$('pre', root).forEach(function (pre) {
      var code = pre.querySelector('code');
      if (!code) return;
      var m = /language-([\w+#.-]+)/.exec(code.className || '');
      var lang = m ? m[1].toLowerCase() : '';
      code.classList.add('code-body');
      pre.setAttribute('data-lang', lang);

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-copy';
      btn.setAttribute('data-copy', '1');
      btn.textContent = '复制';

      if (lang) {
        var head = document.createElement('div');
        head.className = 'code-head';
        var label = document.createElement('span');
        label.className = 'code-lang';
        label.textContent = lang;
        head.appendChild(label);
        head.appendChild(btn);
        pre.insertBefore(head, pre.firstChild);
      } else {
        pre.classList.add('no-head');
        pre.appendChild(btn);
      }
    });

    /* --- 任务列表：把 checkbox 换成主题里的方块 --- */
    $$('li > input[type="checkbox"]', root).forEach(function (input) {
      var li = input.parentElement;
      var done = input.hasAttribute('checked');
      var box = document.createElement('span');
      box.className = 'task-box';
      box.setAttribute('aria-hidden', 'true');
      input.replaceWith(box);
      li.classList.add('task');
      if (done) li.classList.add('done');
      if (li.firstChild && li.firstChild.nodeType === 3) {
        li.firstChild.nodeValue = li.firstChild.nodeValue.replace(/^\s+/, '');
      }
    });

    /* --- 表格：横向滚动容器 --- */
    $$('table', root).forEach(function (t) {
      if (t.parentElement && t.parentElement.classList.contains('table-wrap')) return;
      var wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      t.replaceWith(wrap);
      wrap.appendChild(t);
    });

    /* --- 图片与链接 --- */
    $$('img', root).forEach(function (img) {
      img.classList.add('zoomable');
      var src = img.getAttribute('src');
      if (src) img.setAttribute('src', toLocalUrl(src));
    });

    $$('a[href]', root).forEach(function (a) {
      var href = a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) a.setAttribute('data-ext', '1');
      else if (/^mailto:|^tel:/i.test(href)) a.setAttribute('data-ext', '1');
    });
  }

  /* ------------------------------------------------------------------ *
   * 送进解析器之前的预处理
   * ------------------------------------------------------------------ */

  /*
   * 行内 HTML 白名单：只有这些标签会被当成 HTML 交给渲染。
   *
   * 为什么要管这件事：`List<String>`、`Result<T, E>` 这类泛型写法在中文技术笔记里很常见。
   * 如果任由解析器把 <String> 当成标签，它会被当作未知元素丢掉，正文就变成 "List"，
   * 信息直接没了（GitHub 也是这个行为，但对读技术文档的人来说就是实打实的损失）。
   * 所以：认识的标签放行，不认识的连尖括号一起转成字面量。
   */
  var ALLOWED_TAGS = new Set((
    'a abbr b bdi bdo big br cite code data del dfn em i ins kbd mark q rp rt ruby s samp small span ' +
    'strike strong sub sup time tt u var wbr font center img picture source svg g path circle rect ' +
    'div details summary section article aside figure figcaption table thead tbody tfoot tr td th ' +
    'dl dd dt hr p pre blockquote video audio'
  ).split(' '));

  var RE_TAGLIKE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*?)?)(\/?)>/g;

  function preprocessMarkdown(md) {
    return extractCallouts(extractFootnotes(protectAngleBrackets(stripDangerousBlocks(md))));
  }

  /* script / style 之类连内容一起丢掉，而不是转义成文字显示出来 */
  function stripDangerousBlocks(md) {
    return String(md == null ? '' : md)
      .replace(/<(script|style|iframe|object|embed|template)\b[^>]*>[^]*?<\/\1\s*>/gi, '');
  }

  function protectAngleBrackets(md) {
    var lines = String(md == null ? '' : md).split('\n');
    var out = [];
    var inFence = false;
    var fenceChar = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var fm = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fm) {
        var ch = fm[1].charAt(0);
        if (!inFence) { inFence = true; fenceChar = ch; }
        else if (ch === fenceChar) { inFence = false; }
        out.push(line);
        continue;
      }
      // 代码块里的尖括号本来就是字面量，不能动
      if (inFence) { out.push(line); continue; }
      out.push(escapeUnknownTags(line));
    }
    return out.join('\n');
  }

  /* 行内代码（反引号包起来的部分）同样原样跳过 */
  function escapeUnknownTags(line) {
    var parts = line.split(/(`+[^`]*`+)/);
    for (var i = 0; i < parts.length; i += 2) {
      parts[i] = parts[i].replace(RE_TAGLIKE, function (whole, close, name, attrs, selfClose) {
        if (ALLOWED_TAGS.has(name.toLowerCase())) return whole;
        return '&lt;' + close + name + attrs + selfClose + '&gt;';
      });
    }
    return parts.join('');
  }

  var CALLOUT_TITLE = {
    note: '提示', tip: '建议', important: '重要', warning: '警告', caution: '注意'
  };
  /* 哨兵用 U+2063（不可见分隔符）包裹，正常文档里不可能出现，也不会被 Markdown 语法碰到 */
  var SENTINEL = '⁣';
  var calloutMeta = [];

  /*
   * marked 不认 GitHub 的 > [!NOTE] 语法。
   *
   * 转换放在解析之前、但只把标记行换成一个哨兵，正文原封不动留给 marked 解析——
   * 因为提示块的正文里可能有列表、代码、表格，直接换成原始 HTML 会丢掉这些解析。
   * 不用"取到行尾当标题"的办法是因为 marked 会把软换行并起来，
   * 标题和正文之间没有可靠的换行边界，只能靠哨兵精确定位。
   */
  function extractCallouts(md) {
    calloutMeta = [];
    return String(md == null ? '' : md).replace(
      /^((?:[ \t]*>)+[ \t]*)\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*?)[ \t]*$/gim,
      function (whole, prefix, kind, title) {
        calloutMeta.push({ kind: kind.toLowerCase(), title: title.trim() });
        return prefix + SENTINEL + 'MDRCALLOUT' + (calloutMeta.length - 1) + SENTINEL;
      }
    );
  }

  function convertCallouts(root) {
    $$('blockquote', root).forEach(function (bq) {
      var first = bq.querySelector('p');
      if (!first) return;
      var m = new RegExp('^' + SENTINEL + 'MDRCALLOUT(\\d+)' + SENTINEL).exec(first.textContent || '');
      if (!m) return;
      var info = calloutMeta[+m[1]];
      if (!info) return;

      var kind = info.kind;
      var title = info.title || CALLOUT_TITLE[kind] || kind.toUpperCase();

      stripPrefix(first, m[0].length);
      if (!first.textContent.trim() && !first.querySelector('img, code, br')) first.remove();

      var box = document.createElement('div');
      box.className = 'callout callout-' + kind;
      var head = document.createElement('div');
      head.className = 'callout-title';
      head.textContent = title;
      box.appendChild(head);
      while (bq.firstChild) box.appendChild(bq.firstChild);
      bq.replaceWith(box);
    });
  }

  /* 从段落开头吃掉 count 个字符，顺带清掉紧跟的换行与空白 */
  function stripPrefix(p, count) {
    var remaining = count;
    var node = p.firstChild;
    while (node && remaining > 0) {
      var next = node.nextSibling;
      if (node.nodeType === 3) {
        var len = node.nodeValue.length;
        if (len <= remaining) { remaining -= len; p.removeChild(node); }
        else { node.nodeValue = node.nodeValue.slice(remaining); remaining = 0; }
      } else {
        p.removeChild(node);   /* 标记不会横跨元素，遇到元素整个丢掉 */
      }
      node = next;
    }
    while (p.firstChild) {
      var f = p.firstChild;
      if (f.nodeName === 'BR') { p.removeChild(f); continue; }
      if (f.nodeType === 3 && !f.nodeValue.trim()) { p.removeChild(f); continue; }
      if (f.nodeType === 3) f.nodeValue = f.nodeValue.replace(/^\s+/, '');
      break;
    }
  }

  /* ------------------------------------------------------------------ *
   * 脚注
   *
   * CommonMark 里 `[^1]: 说明` 本身就是合法的链接引用定义，marked 会把它收走，
   * 于是正文里的 `[^1]` 会变成一个指向空锚点的链接。所以必须在交给 marked 之前
   * 把定义行摘出来，再把引用就地换成上标 HTML，最后在文末补一节。
   * ------------------------------------------------------------------ */

  var fnDefs = [];

  /** 每一行是否落在围栏代码块里（围栏那一行也算）。 */
  function scanFences(lines) {
    var inside = [];
    var inFence = false, fenceChar = '';
    for (var i = 0; i < lines.length; i++) {
      var m = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
      var marker = false;
      if (m) {
        var ch = m[1].charAt(0);
        if (!inFence) { inFence = true; fenceChar = ch; }
        else if (ch === fenceChar) { inFence = false; }
        marker = true;
      }
      inside[i] = inFence || marker;
    }
    return inside;
  }

  function extractFootnotes(md) {
    fnDefs = [];
    var src = String(md == null ? '' : md);
    if (src.indexOf('[^') === -1) return src;

    var lines = src.split('\n');
    var inCode = scanFences(lines);
    var indexById = Object.create(null);
    var cur = null;

    /* 第一遍：把定义行摘出来。必须先把定义拿掉——
       CommonMark 里 `[^1]: 说明` 本身就是合法的链接引用定义，留着的话
       正文里的 `[^1]` 会被 marked 变成一个指向空锚点的链接。 */
    for (var i = 0; i < lines.length; i++) {
      if (inCode[i]) { cur = null; continue; }

      var def = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(lines[i]);
      if (def) {
        var id = def[1];
        if (indexById[id] != null) {           // 重复定义：后一条覆盖前一条
          cur = fnDefs[indexById[id]];
          cur.text = def[2];
        } else {
          indexById[id] = fnDefs.length;
          cur = { id: id, text: def[2] };
          fnDefs.push(cur);
        }
        lines[i] = '';                          // 留一个空行，避免把上下文两段粘起来
        continue;
      }
      // 续行：缩进四格或一个制表符，且上一条定义还没结束
      if (cur && /^(?: {4}|\t)/.test(lines[i])) {
        cur.text += '\n' + lines[i].replace(/^(?: {4}|\t)/, '');
        lines[i] = '';
        continue;
      }
      cur = null;
    }

    if (!fnDefs.length) return src;

    /* 第二遍：把正文里的引用换成上标。代码块和行内代码里的 `[^1]` 是字面量，不能动 */
    for (var j = 0; j < lines.length; j++) {
      if (inCode[j] || !lines[j] || lines[j].indexOf('[^') === -1) continue;
      lines[j] = replaceFootnoteRefs(lines[j], indexById);
    }
    return lines.join('\n');
  }

  function replaceFootnoteRefs(line, indexById) {
    var parts = line.split(/(`+[^`]*`+)/);
    for (var i = 0; i < parts.length; i += 2) {
      parts[i] = parts[i].replace(/\[\^([^\]\s]+)\]/g, function (whole, id) {
        var idx = indexById[id];
        if (idx == null) return whole;          // 没有对应定义就照原样显示
        var n = idx + 1;
        return '<sup class="fn-ref"><a href="#fn-' + n + '" id="fnref-' + n + '">' + n + '</a></sup>';
      });
    }
    return parts.join('');
  }

  /* 脚注正文要单独过一遍 markdown 和清洗，不能直接塞进已清洗的树里 */
  function convertFootnotes(root) {
    if (!fnDefs.length) return;

    var box = document.createElement('section');
    box.className = 'footnotes';
    // 刻意不用 h2：那样它会被算成一个正文章节，混进目录和滚动位置判定里
    var head = document.createElement('div');
    head.className = 'fn-title';
    head.textContent = '脚注';
    box.appendChild(head);

    var ol = document.createElement('ol');
    fnDefs.forEach(function (d, i) {
      var li = document.createElement('li');
      li.id = 'fn-' + (i + 1);
      var inner = '';
      try { inner = window.marked.parseInline(d.text) || ''; } catch (e) { inner = escapeText(d.text); }
      li.innerHTML = window.DOMPurify.sanitize(inner);

      var back = document.createElement('a');
      back.className = 'fn-back';
      back.setAttribute('href', '#fnref-' + (i + 1));
      back.setAttribute('aria-label', '回到正文');
      back.textContent = '↩';
      li.appendChild(back);
      ol.appendChild(li);
    });
    box.appendChild(ol);
    root.appendChild(box);
  }

  /* 相对资源交给原生侧的 shouldInterceptRequest 提供字节流，
     这样文档目录旁的图片才能显示，又不用把图片读成 base64 塞进 HTML。 */
  function toLocalUrl(url) {
    if (!url || !LOCAL_PREFIX) return url;
    if (/^(?:[a-z][a-z0-9+.-]*:)/i.test(url)) return url;  /* 已是绝对 URL 或 data: */
    if (url.charAt(0) === '#') return url;
    return LOCAL_PREFIX + encodeURIComponent(url);
  }

  /* Prism 在 window.Prism.manual=true 下不会自动跑，渲染后手动调用 */
  function highlightCode() {
    if (!window.Prism) return;
    $$('pre > code.code-body', dom.doc).forEach(function (code) {
      try { window.Prism.highlightElement(code); } catch (e) { /* 高亮失败就保留纯文本 */ }
    });
  }

  /* ------------------------------------------------------------------ *
   * 目录
   * ------------------------------------------------------------------ */

  /*
   * 目录画成文档的结构图，不是一列标题。
   *
   * 标题本来就是一棵树（h2 归它上面的 h1，h3 再归 h2），把它摊平成缩进列表
   * 等于把这份结构丢掉。这里按层级重新接回父子关系，再用连接线画出来：
   * 竖向主干 + 每个节点一段横向引出，收尾的那一段只画半截。
   *
   * 分叉处挂一个数字角标，点它折叠——长文档里这是它的主要用处。
   */
  function buildTocTree(items) {
    var roots = [];
    var stack = [];
    var byId = Object.create(null);

    items.forEach(function (it) {
      var node = { id: it.id, level: it.level, text: it.text, children: [], parent: null };
      while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
      var parent = stack.length ? stack[stack.length - 1] : null;
      node.parent = parent;
      if (parent) parent.children.push(node);
      else roots.push(node);
      stack.push(node);
      byId[node.id] = node;
    });
    return { roots: roots, byId: byId };
  }

  function tocNodeHtml(n) {
    /* n.sub 是整棵子树里的标题数。折叠箭头只在有分叉时出现；
       叶子节点留一个等宽的空位，文字才对得齐。 */
    n.sub = 0;
    var kids = n.children.map(function (c) {
      var html = tocNodeHtml(c);
      n.sub += 1 + c.sub;
      return html;
    }).join('');

    var branch = n.children.length > 0;
    return '<div class="tnode lv' + Math.min(n.level, 4) +
        (state.collapsed[n.id] ? ' folded' : '') +
        (branch ? '' : ' leaf') +
        '" data-toc="' + escapeText(n.id) + '">' +
        '<i class="tchev"' + (branch ? ' data-fold="1" role="button"' : '') +
          ' aria-hidden="true"></i>' +
        '<span class="ttext">' + escapeText(n.text) + '</span>' +
        /* 数字只在这一支被收起来的时候才出来——平时它就是多余的，
           收起来时才是"你还藏着多少个标题"的唯一答案 */
        (branch ? '<b class="tcount">' + n.sub + '</b>' : '') +
      '</div>' + (kids ? '<div class="tkids">' + kids + '</div>' : '');
  }

  function tocBodyHtml() {
    var tree = buildTocTree(state.toc);
    state.treeById = tree.byId;

    if (!state.toc.length) return '<div class="toc-empty">这份文档没有标题层级</div>';

    var maxLv = state.toc.reduce(function (m, it) { return Math.max(m, it.level); }, 0);
    var stat = '<div class="toc-stat">' + state.toc.length + ' 个标题 · 最深 ' + maxLv + ' 层</div>';
    return stat + '<div class="troot">' + tree.roots.map(tocNodeHtml).join('') + '</div>';
  }

  function buildToc() {
    state.collapsed = state.collapsed || Object.create(null);
    var body = tocBodyHtml();

    dom.toc.innerHTML = body;
    dom.rail.innerHTML = body;

    /* 把节点元素挂回树上，revealNode 要靠它一路往上展开。
       抽屉和宽屏右栏是同一份 HTML 的两份拷贝，两边都要收着——
       只记一个的话，展开的会是看不见的那一边。 */
    [dom.toc, dom.rail].forEach(function (box) {
      $$('[data-toc]', box).forEach(function (el) {
        var node = state.treeById[el.getAttribute('data-toc')];
        if (node) (node.els || (node.els = [])).push(el);
      });
    });

    /* 文档有 3 个以上标题时，宽屏才让右栏常驻 */
    document.body.classList.toggle('has-rail', state.toc.length >= 3);
  }

  /* 当前读到的这一节若在折叠的分支里，把沿途都展开，否则"你在哪"就看不见了 */
  function revealNode(id) {
    if (!state.treeById) return;
    var n = state.treeById[id];
    while (n && n.parent) {
      n = n.parent;
      state.collapsed[n.id] = false;
      if (n.els) n.els.forEach(function (el) { el.classList.remove('folded'); });
    }
  }

  function toggleFold(chev) {
    var node = chev.closest('.tnode');
    if (!node) return;
    var on = node.classList.toggle('folded');
    state.collapsed[node.getAttribute('data-toc')] = on;
    chev.setAttribute('aria-expanded', on ? 'false' : 'true');
  }

  function measureHeadings() {
    state.headingTops = state.headingEls.map(function (el) { return el.offsetTop; });
    updateActiveHeading();
  }

  function updateActiveHeading() {
    if (!state.headingEls.length) return;
    var top = window.scrollY + 90;
    var idx = -1;
    for (var i = 0; i < state.headingTops.length; i++) {
      if (state.headingTops[i] <= top) idx = i;
      else break;
    }
    /* 滚到底部时，强制选中最后一个标题 */
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) {
      idx = state.headingEls.length - 1;
    }
    var id = idx >= 0 ? state.headingEls[idx].id : '';
    if (id === state.activeTocId) return;
    state.activeTocId = id;
    if (id) revealNode(id);

    $$('[data-toc]', dom.drawer).concat($$('[data-toc]', dom.rail)).forEach(function (a) {
      var on = a.getAttribute('data-toc') === id;
      a.classList.toggle('active', on);
      if (!on) return;
      /* 让当前这一节停在可视区中间。用 rect 算，不要用 offsetTop——
         滚动容器的定位祖先不一定是它自己，offsetTop 的参照物靠不住 */
      var box = a.closest('.toc, .toc-rail');
      if (!box) return;
      var r = a.getBoundingClientRect(), br = box.getBoundingClientRect();
      var delta = (r.top - br.top) - (box.clientHeight - r.height) / 2;
      if (Math.abs(delta) > box.clientHeight * 0.4) box.scrollTop += delta;
    });
  }

  function scrollToId(id) {
    var el = document.getElementById(id);
    if (!el) return;
    var top = el.getBoundingClientRect().top + window.scrollY - 66;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    state.activeTocId = '';   /* 让滚动结束后重新判定，避免当场被覆盖 */
  }

  /* ------------------------------------------------------------------ *
   * 滚动：进度、卷首标题、回到顶部、阅读位置记忆
   * ------------------------------------------------------------------ */

  var lastY = 0;
  var progressTimer = null;
  var titleDismissed = false;

  function scrollRatio() {
    var max = document.body.scrollHeight - window.innerHeight;
    return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
  }

  function queueProgressSave() {
    if (!state.settings.remember || state.editing) return;
    clearTimeout(progressTimer);
    progressTimer = setTimeout(function () {
      call('saveProgress', String(scrollRatio()));
    }, 900);
  }

  var onScroll = throttleRaf(function () {
    var y = window.scrollY;
    var pct = scrollRatio() * 100;

    dom.progress.style.width = pct + '%';
    dom.toTop.classList.toggle('show', y > window.innerHeight * 0.8);

    /* 卷首标题：只在最顶上露一下，滚下去就收 */
    if (y < 4 && titleDismissed) { titleDismissed = false; showTitleTag(); }
    else if (y > 40 && !titleDismissed) { titleDismissed = true; dom.titleTag.classList.remove('show'); }

    lastY = y;
    updateActiveHeading();
    queueProgressSave();
  });

  function showTitleTag() {
    if (!state.docTitle) return;
    dom.titleTagText.textContent = state.docTitle;
    dom.titleTag.classList.add('show');
    clearTimeout(showTitleTag._t);
    showTitleTag._t = setTimeout(function () {
      if (window.scrollY > 40) { titleDismissed = true; dom.titleTag.classList.remove('show'); }
    }, 2800);
  }

  /*
   * 位置的存储单位是"整篇滚了百分之几"，不是像素。
   * 像素在字号、行距、图片加载完成之后全都会变，百分比不会。
   */
  var restoreUntil = 0;

  function restoreProgress() {
    if (!state.settings.remember || !state.progress) return;
    var p = Math.min(1, Math.max(0, state.progress));
    if (p < 0.01) return;
    applyRestore(p);
    restoreUntil = Date.now() + 1500;   // 图片陆续撑开高度，这段时间里再校几次
  }

  function applyRestore(p) {
    var max = document.body.scrollHeight - window.innerHeight;
    if (max > 0) window.scrollTo(0, max * p);
  }

  /* 图片加载会改变总高度，早先算出来的位置就偏了，趁人还没开始滚再校一次 */
  function onImageLoad() {
    measureHeadings();
    if (restoreUntil && Date.now() < restoreUntil && state.progress) {
      applyRestore(Math.min(1, Math.max(0, state.progress)));
    }
  }

  /* ------------------------------------------------------------------ *
   * 左侧工具栏
   * ------------------------------------------------------------------ */

  var EDGE = 26;        /* 落在左缘这一段的起手，算"精确起手" */
  var DECIDE = 14;      /* 横向位移超过这么多才判定成"拉栏"，在此之前一律放行 */
  var EDGE_LOCK = 1.15; /* 左缘起手横向压过纵向就够，那一片本来也没什么可竖着滚的 */
  var PAGE_LOCK = 1.35; /* 屏幕中间起手：要求横向明显压过纵向，免得斜着翻页时被抢 */

  var rail = { open: false };
  var swipe = null;

  function openRail() {
    resetRailDrag();
    dom.navrail.classList.add('show');
    dom.railScrim.classList.add('show');
    document.body.classList.add('rail-open');
    rail.open = true;
  }

  function closeRail() {
    resetRailDrag();
    dom.navrail.classList.remove('show');
    dom.railScrim.classList.remove('show');
    document.body.classList.remove('rail-open');
    rail.open = false;
  }

  function resetRailDrag() {
    dom.navrail.classList.remove('dragging');
    dom.navrail.style.transform = '';
    dom.railScrim.classList.remove('dragging');
    dom.railScrim.style.opacity = '';
  }

  function railWidth() {
    return dom.navrail.offsetWidth || 56;
  }

  /* 起手在左缘时，用卡片自己的宽度当行程——手感是"把这块板子拽出来" */
  function edgeTravel() {
    return Math.max(railWidth(), 88);
  }

  /* 起手在屏幕中间时，用左栏宽度就太灵敏了，手指抖一下栏就出来了；
     折中成屏宽的三分之一左右，一次短促的横拨刚好能拉满 */
  function pageTravel() {
    return Math.min(window.innerWidth * 0.32, 150);
  }

  /* 收起态是 translateX(-115%) scale(.94)，跟手时要沿着同一条路径走，
     否则松手那一下会从"拖到一半的位置"跳到"完全收起"再弹回来。 */
  var DRAG_FROM = -115;
  var DRAG_SCALE = 0.06;

  function dragRail(p) {
    p = Math.min(1, Math.max(0, p));
    dom.navrail.classList.add('dragging');
    dom.navrail.style.transform =
      'translateX(' + (DRAG_FROM + p * -DRAG_FROM) + '%) scale(' + (0.94 + p * DRAG_SCALE) + ')';
    if (p > 0) {
      dom.railScrim.classList.add('show', 'dragging');
      dom.railScrim.style.opacity = String(p);
    } else {
      dom.railScrim.classList.remove('show');
      dom.railScrim.style.opacity = '';
    }
    return p;
  }

  function endRailDrag(p) {
    if (p > 0.42) openRail(); else closeRail();
  }

  function anyOverlayOpen() {
    return dom.drawer.classList.contains('show')
      || dom.sheet.classList.contains('show')
      || dom.lightbox.classList.contains('show')
      || dom.confirm.classList.contains('show');
  }

  /*
   * 起手落在"已经横向滚出去"的表格或代码块上时，这一下是在往回滚内容，
   * 不是在拉栏。滚到最左边就没什么可回的了，那时候再让工具栏接管。
   */
  function inScrolledBox(el) {
    while (el && el !== document.body) {
      if (el.scrollLeft > 0 && el.scrollWidth > el.clientWidth) return true;
      el = el.parentElement;
    }
    return false;
  }

  /*
   * 手势挂在 document 上，而不是铺一层透明的热区。
   * 铺热区会把正文里的链接、图片、可拖选的文字一起吃掉；
   * 挂在 document 上则只有真的横拖超过了阈值才 preventDefault，
   * 单击和长按照常落到它该去的地方。
   */
  function bindRailGesture() {
    document.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1 || anyOverlayOpen()) { swipe = null; return; }
      var x = e.touches[0].clientX;
      var y = e.touches[0].clientY;

      if (rail.open) {
        // 已经拉开时，从卡片上往左推可以送回去
        if (x > dom.navrail.getBoundingClientRect().right) { swipe = null; return; }
        swipe = { from: 'rail', x0: x, y0: y, decided: false, p: 1 };
        return;
      }
      /*
       * 编辑器里横拖是拖选文字，正文那一大片不能抢。
       * 但左栏是编辑时唯一的出口（保存、预览都在上面），所以左缘仍然留着。
       */
      if (state.editing && x > EDGE) { swipe = null; return; }
      if (inScrolledBox(e.target)) { swipe = null; return; }

      swipe = {
        from: x <= EDGE ? 'edge' : 'page',
        x0: x, y0: y, decided: false, p: 0
      };
    }, { passive: true });

    /* 长按选字一旦开始，这一串触摸就归选择用了，不能再当成拉栏。
       只认"真的选出了东西"，光标移动那种空选区不算。 */
    document.addEventListener('selectionchange', function () {
      if (state.editing || !swipe || swipe.decided) return;
      var sel = window.getSelection();
      if (sel && !sel.isCollapsed && String(sel).length) swipe = null;
    });

    document.addEventListener('touchmove', function (e) {
      if (!swipe || e.touches.length !== 1) return;
      var t = e.touches[0];
      var dx = t.clientX - swipe.x0;
      var dy = t.clientY - swipe.y0;

      if (!swipe.decided) {
        if (Math.abs(dx) < DECIDE) return;
        // 竖着动的是翻页；横向反方向的是别的意图——都放行
        var lock = swipe.from === 'edge' ? EDGE_LOCK : PAGE_LOCK;
        if (Math.abs(dy) * lock > Math.abs(dx)) { swipe = null; return; }
        if (swipe.from === 'rail' ? dx > 0 : dx < 0) { swipe = null; return; }
        swipe.decided = true;
      }

      var travel = swipe.from === 'page' ? pageTravel() : edgeTravel();
      swipe.p = dragRail(swipe.from === 'rail' ? 1 + dx / travel : dx / travel);
      e.preventDefault();
    }, { passive: false });

    function finish() {
      if (!swipe) return;
      var s = swipe;
      swipe = null;
      if (s.decided) endRailDrag(s.p);
    }
    document.addEventListener('touchend', finish);
    document.addEventListener('touchcancel', finish);
  }

  /* ------------------------------------------------------------------ *
   * 页内检索
   * ------------------------------------------------------------------ */

  var searchTimer = null;
  var searchQuery = '';

  function runSearch(query) {
    /* 每次都从渲染后的原始 HTML 重建，避免 mark 层层叠加 */
    if (query !== searchQuery) {
      dom.doc.innerHTML = state.baseHtml;
      state.hits = [];
      state.hitIndex = -1;
      if (query) state.hits = markMatches(dom.doc, query);
      searchQuery = query;
    }

    $$('mark.hit.current', dom.doc).forEach(function (m) { m.classList.remove('current'); });

    if (!state.hits.length) {
      dom.searchCount.textContent = query ? '无结果' : '';
      return;
    }
    if (state.hitIndex < 0) state.hitIndex = 0;
    focusHit(state.hitIndex);
  }

  function markMatches(root, query) {
    var needle = query.toLowerCase();
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (/^(SCRIPT|STYLE|MARK|TEXTAREA)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    var hits = [];
    nodes.forEach(function (node) {
      var text = node.nodeValue;
      var hay = text.toLowerCase();
      var at = hay.indexOf(needle);
      if (at === -1) return;

      var frag = document.createDocumentFragment();
      var last = 0;
      while (at !== -1) {
        if (at > last) frag.appendChild(document.createTextNode(text.slice(last, at)));
        var mark = document.createElement('mark');
        mark.className = 'hit';
        mark.textContent = text.substr(at, query.length);
        frag.appendChild(mark);
        hits.push(mark);
        last = at + query.length;
        at = hay.indexOf(needle, last);
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });

    return hits;
  }

  function focusHit(i) {
    if (!state.hits.length) return;
    state.hitIndex = (i + state.hits.length) % state.hits.length;
    $$('mark.hit.current', dom.doc).forEach(function (m) { m.classList.remove('current'); });
    var el = state.hits[state.hitIndex];
    el.classList.add('current');
    var top = el.getBoundingClientRect().top + window.scrollY - window.innerHeight / 2.4;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    dom.searchCount.textContent = (state.hitIndex + 1) + '/' + state.hits.length;
  }

  function openSearch() {
    closeRail();
    dom.searchbar.classList.add('show');
    setTimeout(function () { dom.searchInput.focus(); }, 260);
  }

  function closeSearch() {
    dom.searchbar.classList.remove('show');
    dom.searchInput.blur();
    dom.searchInput.value = '';
    if (searchQuery) { dom.doc.innerHTML = state.baseHtml; state.hits = []; searchQuery = ''; }
    state.headingEls = $$('h1,h2,h3,h4,h5,h6', dom.doc);
    measureHeadings();
    highlightCode();
    dom.searchCount.textContent = '';
  }

  /* ------------------------------------------------------------------ *
   * 阅读设置
   * ------------------------------------------------------------------ */

  function resolveTheme(choice) {
    if (choice === 'light' || choice === 'dark') return choice;
    if (window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  }

  function applySettings() {
    var s = state.settings;
    var root = document.documentElement;
    root.setAttribute('data-theme', state.resolvedTheme);
    root.style.setProperty('--fs', s.fontSize + 'px');
    root.style.setProperty('--lh', LH_STEPS[s.lineHeight] || LH_STEPS[1]);
    root.setAttribute('data-wrap', s.wrap ? 'on' : 'off');

    dom.fontRange.value = s.fontSize;
    dom.fsHint.textContent = s.fontSize + 'px';
    dom.lhRange.value = s.lineHeight;
    dom.lhHint.textContent = LH_NAMES[s.lineHeight] || LH_NAMES[1];
    dom.wrapToggle.checked = !!s.wrap;
    dom.rememberToggle.checked = !!s.remember;

    $$('#segTheme button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-v') === s.theme);
    });
  }

  function saveSettings() {
    call('saveSettings', JSON.stringify(state.settings));
  }

  /* ------------------------------------------------------------------ *
   * 确认框
   * 原生侧没有接 WebChromeClient，window.confirm 不会弹；而且它也没法做三选一。
   * ------------------------------------------------------------------ */

  var confirmOpen = false;

  function askConfirm(title, msg, actions) {
    dom.confirmTitle.textContent = title;
    dom.confirmMsg.textContent = msg;
    dom.confirmActs.innerHTML = '';
    actions.forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      if (a.primary) b.className = 'primary';
      if (a.danger) b.className = 'danger';
      b.addEventListener('click', function () {
        closeConfirm();
        if (a.run) a.run();
      });
      dom.confirmActs.appendChild(b);
    });
    dom.confirm.classList.add('show');
    confirmOpen = true;
  }

  function closeConfirm() {
    dom.confirm.classList.remove('show');
    confirmOpen = false;
  }

  /* ------------------------------------------------------------------ *
   * 编辑
   * ------------------------------------------------------------------ */

  function enterEdit() {
    if (!state.editable) { toast('这份文档不可写，请从文件夹打开'); return; }
    state.editing = true;
    dom.editorArea.value = state.markdown;
    dom.editor.classList.add('show');
    dom.navEditLabel.textContent = '预览';
    dom.navEdit.classList.add('on');
    dom.navSave.hidden = false;
    updateEditorStat();
    updateSaveState();
    closeRail();
  }

  /* 从编辑回到阅读：先看缓冲区，不落盘 */
  function previewEdit() {
    // 改完再切回来时位置大概率变了，但整篇的进度还是对得上的，
    // 按百分比接回去比直接弹回顶部要不突兀
    var keep = scrollRatio();

    state.editing = false;
    dom.editor.classList.remove('show');
    dom.navEditLabel.textContent = '编辑';
    dom.navEdit.classList.remove('on');
    dom.navSave.hidden = true;
    closeRail();

    render(state.markdown);
    state.baseHtml = dom.doc.innerHTML;
    applyRestore(keep);
    restoreUntil = Date.now() + 1200;
    lastY = window.scrollY;
    onScroll();
  }

  function onEditorInput() {
    state.markdown = dom.editorArea.value;
    setDirty(state.markdown !== state.savedMarkdown);
    updateEditorStat();
  }

  function setDirty(v) {
    state.dirty = v;
    updateSaveState();
  }

  function updateSaveState() {
    if (!state.editing) return;
    dom.editorState.textContent = state.dirty ? '未保存' : '已保存';
    dom.editorState.className = state.dirty ? 'dirty' : '';
  }

  function updateEditorStat() {
    var text = dom.editorArea.value;
    var lines = text ? text.split('\n').length : 0;
    dom.editorStat.textContent = countText(text) + ' 字 · ' + lines + ' 行';
  }

  /* 光标处包一层，没选中就给一段占位文字并选中它，方便直接改写 */
  function surround(before, after, placeholder) {
    var ta = dom.editorArea;
    var s = ta.selectionStart, e = ta.selectionEnd;
    var sel = ta.value.slice(s, e) || placeholder || '';
    replaceRange(s, e, before + sel + after, s + before.length, s + before.length + sel.length);
  }

  /* 整行加前缀，再点一次就取消，来回切不用手工删 */
  function toggleLinePrefix(prefix, numbered) {
    var ta = dom.editorArea;
    var s = ta.selectionStart, e = ta.selectionEnd;
    var from = ta.value.lastIndexOf('\n', s - 1) + 1;
    var to = ta.value.indexOf('\n', e);
    if (to === -1) to = ta.value.length;

    var lines = ta.value.slice(from, to).split('\n');
    var allOn = true;
    lines.forEach(function (l, i) {
      var n = numbered ? (i + 1) + '. ' : prefix;
      if (l.indexOf(n) !== 0) allOn = false;
    });

    var out = lines.map(function (l, i) {
      var n = numbered ? (i + 1) + '. ' : prefix;
      if (allOn) return l.indexOf(n) === 0 ? l.slice(n.length) : l;
      return l.indexOf(n) === 0 ? l : n + l;
    }).join('\n');

    replaceRange(from, to, out, from, from + out.length);
  }

  function insertBlock(text, caretOffset) {
    var ta = dom.editorArea;
    var s = ta.selectionStart, e = ta.selectionEnd;
    var at = s;
    var needBefore = at > 0 && ta.value.charAt(at - 1) !== '\n';
    var pre = needBefore ? '\n\n' : '';
    var body = pre + text;
    var caret = s + body.length + (caretOffset == null ? 0 : caretOffset);
    replaceRange(s, e, body, caret);
  }

  function replaceRange(from, to, text, selStart, selEnd) {
    var ta = dom.editorArea;
    ta.value = ta.value.slice(0, from) + text + ta.value.slice(to);
    if (selStart != null) {
      ta.selectionStart = selStart;
      ta.selectionEnd = selEnd == null ? selStart : selEnd;
    } else {
      var c = from + text.length;
      ta.selectionStart = c;
      ta.selectionEnd = c;
    }
    ta.focus();
    onEditorInput();
  }

  var MD_ACTIONS = {
    h: function () { toggleLinePrefix('## ', false); },
    b: function () { surround('**', '**', '粗体'); },
    i: function () { surround('*', '*', '斜体'); },
    del: function () { surround('~~', '~~', '删除线'); },
    code: function () { surround('`', '`', 'code'); },
    pre: function () { surround('\n```\n', '\n```\n', 'code'); },
    quote: function () { toggleLinePrefix('> ', false); },
    ul: function () { toggleLinePrefix('- ', false); },
    ol: function () { toggleLinePrefix('- ', true); },
    task: function () { toggleLinePrefix('- [ ] ', false); },
    link: function () { surround('[', '](https://)', '链接文字'); },
    img: function () { surround('![', '](./image.png)', '图注'); },
    table: function () {
      insertBlock('| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n', -20);
    },
    hr: function () { insertBlock('---\n'); },
    note: function () { insertBlock('> [!NOTE]\n> 提示内容\n', -6); }
  };

  /* 列表项里回车自动续上标记；空项再回车就退出列表 */
  function editorEnter(e) {
    var ta = dom.editorArea;
    var s = ta.selectionStart;
    if (s !== ta.selectionEnd) return;

    var from = ta.value.lastIndexOf('\n', s - 1) + 1;
    var line = ta.value.slice(from, s);
    var m = /^(\s*)([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/.exec(line);
    if (!m) return;

    e.preventDefault();
    if (line.trim() === m[0].trim()) { replaceRange(from, s, ''); return; }

    var marker = /^\d+\.$/.test(m[2]) ? (parseInt(m[2], 10) + 1) + '.' : m[2];
    var ins = '\n' + m[1] + marker + ' ' + (m[3] ? '[ ] ' : '');
    replaceRange(s, s, ins, s + ins.length);
  }

  function saveNow(afterwards) {
    if (!state.editable) {
      askWriteAccess(afterwards);
      return;
    }
    var res = call('writeText', state.markdown);
    if (res === 'ok') {
      state.savedMarkdown = state.markdown;
      setDirty(false);
      updateSaveState();
      toast('已保存');
      if (afterwards) afterwards();
      return;
    }
    if (res === 'denied') { askWriteAccess(afterwards); return; }
    toast(typeof res === 'string' && res ? res : '保存失败');
  }

  /* 单文件授权写不进去，就地让用户补一次文件夹授权，不必退出去重开 */
  function askWriteAccess(afterwards) {
    askConfirm('这个位置不能写', '墨读只拿到了这一个文件的读取权限，写不回去。授权它所在的文件夹之后就能保存了。', [
      { label: '取消' },
      { label: '选择文件夹', primary: true, run: function () { call('requestWriteAccess'); } }
    ]);
    pendingAfterSave = afterwards || null;
  }

  var pendingAfterSave = null;

  function leaveEditor() {
    if (!state.dirty) { previewEdit(); return; }
    var actions = [{ label: '继续写' }];
    if (state.editable) {
      actions.push({ label: '保存并退出', primary: true, run: function () {
        saveNow(function () { previewEdit(); });
      } });
    }
    actions.push({ label: '放弃改动', danger: true, run: function () {
      state.markdown = state.savedMarkdown;
      setDirty(false);
      previewEdit();
    } });
    askConfirm('还没保存', '这份文档有改动还没写回文件。', actions);
  }

  /* ------------------------------------------------------------------ *
   * 图片灯箱
   * ------------------------------------------------------------------ */

  function initLightbox() {
    var box = dom.lightbox;
    var img = dom.lightboxImg;
    var scale = 1, tx = 0, ty = 0;
    var pinchStart = 0, pinchScale = 1, panStart = null, lastTap = 0, moved = false;

    function apply() {
      img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    }
    function reset() {
      scale = 1; tx = 0; ty = 0; apply();
    }
    function open(src, alt) {
      img.setAttribute('src', src);
      img.setAttribute('alt', alt || '');
      reset();
      box.classList.add('show');
    }
    function close() {
      box.classList.remove('show');
      setTimeout(function () { if (!box.classList.contains('show')) img.removeAttribute('src'); }, 220);
    }

    function dist(t) {
      var dx = t[0].clientX - t[1].clientX;
      var dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    function onStart(e) {
      moved = false;
      if (e.touches.length === 2) {
        pinchStart = dist(e.touches);
        pinchScale = scale;
        panStart = null;
      } else if (e.touches.length === 1) {
        panStart = { x: e.touches[0].clientX - tx, y: e.touches[0].clientY - ty };
      }
    }

    function onMove(e) {
      e.preventDefault();
      if (e.touches.length === 2 && pinchStart) {
        var next = pinchScale * (dist(e.touches) / pinchStart);
        scale = Math.min(6, Math.max(1, next));
        if (scale === 1) { tx = 0; ty = 0; }
        moved = true;
        apply();
      } else if (e.touches.length === 1 && panStart && scale > 1) {
        tx = e.touches[0].clientX - panStart.x;
        ty = e.touches[0].clientY - panStart.y;
        moved = true;
        apply();
      }
    }

    function onEnd(e) {
      pinchStart = 0;
      if (panStart && Math.abs(e.changedTouches[0].clientX - (panStart.x + tx)) > 8) moved = true;
      panStart = null;
      if (moved) return;

      var now = Date.now();
      if (now - lastTap < 300) {
        if (scale > 1) reset();
        else { scale = 2.5; apply(); }
        lastTap = 0;
        return;
      }
      lastTap = now;
      if (scale === 1) close();
    }

    box.addEventListener('touchstart', onStart, { passive: true });
    box.addEventListener('touchmove', onMove, { passive: false });
    box.addEventListener('touchend', onEnd);
    dom.lightboxClose.addEventListener('click', close);

    /* 桌面浏览器预览用 */
    box.addEventListener('click', function (e) {
      if (e.target === box) close();
    });
    box.addEventListener('wheel', function (e) {
      e.preventDefault();
      scale = Math.min(6, Math.max(1, scale * (e.deltaY < 0 ? 1.12 : 0.89)));
      if (scale === 1) { tx = 0; ty = 0; }
      apply();
    }, { passive: false });
    box.addEventListener('dblclick', function () {
      if (scale > 1) reset(); else { scale = 2.5; apply(); }
    });
    img.addEventListener('mousedown', function (e) {
      var sx = e.clientX, sy = e.clientY, ox = tx, oy = ty;
      function mv(ev) { tx = ox + ev.clientX - sx; ty = oy + ev.clientY - sy; apply(); }
      function up() {
        window.removeEventListener('mousemove', mv);
        window.removeEventListener('mouseup', up);
      }
      window.addEventListener('mousemove', mv);
      window.addEventListener('mouseup', up);
    });

    window.__openLightbox = open;
    window.__closeLightbox = close;
  }

  /* ------------------------------------------------------------------ *
   * 剪贴板
   * ------------------------------------------------------------------ */

  function copyText(text) {
    /* 优先走原生剪贴板：WebView 里的 navigator.clipboard 常因权限不可用 */
    if (Native && typeof Native.copyText === 'function') {
      call('copyText', text);
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { legacyCopy(text); });
      return;
    }
    legacyCopy(text);
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
    document.body.removeChild(ta);
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定
   * ------------------------------------------------------------------ */

  function bindEvents() {
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', function () { measureHeadings(); });

    /* --- 侧栏 --- */
    dom.railScrim.addEventListener('click', closeRail);
    $('#navBack').addEventListener('click', function () { closeRail(); call('back'); });
    $('#navToc').addEventListener('click', function () { closeRail(); openDrawer(); });
    $('#navSearch').addEventListener('click', openSearch);
    $('#navCopy').addEventListener('click', function () {
      closeRail();
      copyText(state.markdown);
    });
    $('#navShare').addEventListener('click', function () {
      closeRail();
      call('shareText', state.markdown);
    });
    $('#navSettings').addEventListener('click', function () {
      closeRail();
      dom.sheet.classList.add('show');
      dom.scrim.classList.add('show');
    });
    dom.navEdit.addEventListener('click', function () {
      if (state.editing) { previewEdit(); } else { enterEdit(); }
    });
    dom.navSave.addEventListener('click', function () { closeRail(); saveNow(null); });

    /* --- 其它浮层 --- */
    dom.btnSearchClose.addEventListener('click', closeSearch);
    dom.btnNextHit.addEventListener('click', function () { focusHit(state.hitIndex + 1); });
    dom.btnPrevHit.addEventListener('click', function () { focusHit(state.hitIndex - 1); });
    dom.scrim.addEventListener('click', closeOverlays);
    dom.toTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

    dom.searchInput.addEventListener('input', function () {
      var v = dom.searchInput.value.trim();
      clearTimeout(searchTimer);
      /* 文档可能很大，每次重建 DOM 不便宜，压一下频率 */
      searchTimer = setTimeout(function () {
        state.hitIndex = -1;
        runSearch(v);
      }, 180);
    });
    dom.searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); focusHit(state.hitIndex + 1); }
      if (e.key === 'Escape') closeSearch();
    });

    dom.segTheme.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-v]');
      if (!btn) return;
      state.settings.theme = btn.getAttribute('data-v');
      state.resolvedTheme = resolveTheme(state.settings.theme);
      applySettings();
      saveSettings();
      /* 主题是"跟随系统"时，由原生用系统配置给出准确值并回调 setResolvedTheme */
      call('requestResolvedTheme');
    });

    dom.fontRange.addEventListener('input', function () {
      state.settings.fontSize = parseInt(dom.fontRange.value, 10) || 17;
      applySettings();
      measureHeadings();
    });
    dom.fontRange.addEventListener('change', saveSettings);

    dom.lhRange.addEventListener('input', function () {
      state.settings.lineHeight = parseInt(dom.lhRange.value, 10) || 0;
      applySettings();
      measureHeadings();
    });
    dom.lhRange.addEventListener('change', saveSettings);

    dom.wrapToggle.addEventListener('change', function () {
      state.settings.wrap = dom.wrapToggle.checked;
      applySettings();
      saveSettings();
    });

    dom.rememberToggle.addEventListener('change', function () {
      state.settings.remember = dom.rememberToggle.checked;
      applySettings();
      saveSettings();
      if (!state.settings.remember) call('saveProgress', '0');
    });

    /* --- 编辑器 --- */
    dom.editorArea.addEventListener('input', onEditorInput);
    dom.editorArea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') editorEnter(e);
    });
    dom.editorBar.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-md]');
      if (!btn) return;
      var fn = MD_ACTIONS[btn.getAttribute('data-md')];
      if (fn) fn();
    });

    /* 正文区委托：复制、图片、链接、目录、空文档入口 */
    document.addEventListener('click', function (e) {
      if (e.target.id === 'emptyEdit') { enterEdit(); return; }

      var copyBtn = e.target.closest('[data-copy]');
      if (copyBtn) {
        var pre = copyBtn.closest('pre');
        var body = pre && pre.querySelector('.code-body');
        if (body) {
          copyText(body.textContent);
          copyBtn.textContent = '已复制';
          copyBtn.classList.add('done');
          setTimeout(function () {
            copyBtn.textContent = '复制';
            copyBtn.classList.remove('done');
          }, 1500);
        }
        return;
      }

      var img = e.target.closest('img.zoomable');
      if (img && img.getAttribute('src')) {
        if (window.__openLightbox) window.__openLightbox(img.getAttribute('src'), img.getAttribute('alt'));
        return;
      }

      /* 结构图上的分叉角标：只折叠，不跳转 */
      var caret = e.target.closest('[data-fold]');
      if (caret) { toggleFold(caret); return; }

      var tocNode = e.target.closest('[data-toc]');
      if (tocNode) {
        e.preventDefault();
        closeOverlays();
        scrollToId(tocNode.getAttribute('data-toc'));
        return;
      }

      var link = e.target.closest('a[href]');
      if (!link) return;
      var href = link.getAttribute('href');

      if (link.hasAttribute('data-ext')) {
        e.preventDefault();
        call('openExternal', href);
        return;
      }
      /* 脚注的往返锚点走这里 */
      if (href && href.charAt(0) === '#') {
        e.preventDefault();
        closeOverlays();
        scrollToId(decodeURIComponent(href.slice(1)));
        return;
      }
      /* 其余相对链接交给原生处理（可能指向同目录的另一个 md） */
      e.preventDefault();
      call('openRelative', href);
    });

    /* 键盘：桌面浏览器预览时方便 */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeOverlays(); closeSearch(); closeConfirm(); closeRail(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); openSearch(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && state.editing) { e.preventDefault(); saveNow(null); }
    });
  }

  function openDrawer() {
    dom.drawer.classList.add('show');
    dom.scrim.classList.add('show');
  }

  function closeOverlays() {
    dom.drawer.classList.remove('show');
    dom.sheet.classList.remove('show');
    dom.scrim.classList.remove('show');
  }

  /* ------------------------------------------------------------------ *
   * 加载文档
   * ------------------------------------------------------------------ */

  function loadDocument() {
    var doc = callJson('getDocument');
    var settings = callJson('getSettings');

    if (settings) {
      state.settings.theme = settings.theme || 'auto';
      state.settings.fontSize = settings.fontSize || 17;
      state.settings.wrap = !!settings.wrap;
      state.settings.lineHeight = typeof settings.lineHeight === 'number' ? settings.lineHeight : 1;
      state.settings.remember = settings.remember !== false;
    }
    state.resolvedTheme = (settings && settings.resolvedTheme) || resolveTheme(state.settings.theme);
    applySettings();

    if (!doc || typeof doc.content !== 'string') {
      dom.doc.innerHTML = '<div class="empty"><b>没有打开文档</b>从首页选择一个 .md 文件</div>';
      dom.drawerTitle.textContent = '';
      return;
    }

    state.docName = doc.name || '';
    state.markdown = doc.content;
    state.savedMarkdown = doc.content;
    state.editable = !!doc.editable;
    state.progress = typeof doc.progress === 'number' ? doc.progress : 0;
    state.dirty = false;
    state.editing = false;

    var title = (doc.title || doc.name || '').replace(/\.(md|markdown|mdown)$/i, '');
    state.docTitle = title;
    dom.drawerTitle.textContent = title;
    document.title = title || '墨读';

    render(state.markdown);
    state.baseHtml = dom.doc.innerHTML;

    /* 有存档位置就先落在那儿，否则从头开始 */
    if (state.settings.remember && state.progress > 0.01) {
      restoreProgress();
    } else {
      window.scrollTo(0, 0);
      titleDismissed = false;
      showTitleTag();
    }
    lastY = window.scrollY;
    onScroll();
  }

  /* ------------------------------------------------------------------ *
   * 供原生调用
   * ------------------------------------------------------------------ */

  window.MDR = {
    /* 原生在读取完文件后调用，或要求重新加载 */
    reload: loadDocument,

    /* 系统主题变化、"跟随系统"解析完成后由原生回调 */
    setResolvedTheme: function (theme) {
      if (!theme) return;
      state.resolvedTheme = theme;
      applySettings();
    },

    toast: toast,

    /* 新建出来的文件是空的，原生加载完直接把人送进编辑器 */
    startEdit: function () {
      if (!state.editing) enterEdit();
    },

    /*
     * 补到文件夹授权之后，相对资源的可用性变了。
     * 前缀是加载时定下的，这里必须一并更新，否则图片要等下次打开才出来。
     */
    setLocalPrefix: function (p) {
      LOCAL_PREFIX = typeof p === 'string' ? p : '';
      if (state.editing) return;
      render(state.markdown);
      state.baseHtml = dom.doc.innerHTML;
      if (state.settings.remember && state.progress > 0.01) restoreProgress();
      measureHeadings();
    },

    /* 补授权回来之后原生调这个，把结果告诉页面 */
    writeAccessResult: function (ok) {
      if (!ok) { toast('没有拿到写入权限'); return; }
      toast('已授权，正在保存');
      saveNow(pendingAfterSave);
      pendingAfterSave = null;
    },

    /*
     * 物理返回键先问页面：有浮层就关浮层，没有才让原生结束 Activity。
     * 返回 true 表示"我处理了"，原生收到就不要再退出。
     */
    handleBack: function () {
      if (dom.lightbox.classList.contains('show')) {
        if (window.__closeLightbox) window.__closeLightbox();
        return true;
      }
      if (confirmOpen) { closeConfirm(); return true; }
      if (dom.searchbar.classList.contains('show')) { closeSearch(); return true; }
      if (rail.open) { closeRail(); return true; }
      if (dom.drawer.classList.contains('show') || dom.sheet.classList.contains('show')) {
        closeOverlays();
        return true;
      }
      if (state.editing) { leaveEditor(); return true; }
      return false;
    },

    /* 原生已知文档变化但设置没变时，只重渲染正文 */
    setContent: function (content) {
      state.markdown = content;
      state.savedMarkdown = content;
      state.dirty = false;
      render(content);
      state.baseHtml = dom.doc.innerHTML;
    },

    /* 原生在 onPause 时问一次当前位置，保证最后一小段滚动不丢 */
    currentProgress: function () {
      return String(scrollRatio());
    },

    getStats: function () {
      return JSON.stringify({
        headings: state.toc.length,
        chars: state.baseHtml.length,
        editing: state.editing,
        dirty: state.dirty,
        railOpen: rail.open
      });
    }
  };

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  function init() {
    dom = {
      doc: $('#doc'),
      progress: $('#progress'),
      titleTag: $('#titleTag'),
      titleTagText: $('#titleTagText'),

      searchbar: $('#searchbar'),
      searchInput: $('#searchInput'),
      searchCount: $('#searchCount'),
      btnSearchClose: $('#btnSearchClose'),
      btnPrevHit: $('#btnPrevHit'),
      btnNextHit: $('#btnNextHit'),

      drawer: $('#drawer'),
      drawerTitle: $('#drawerTitle'),
      toc: $('#toc'),
      rail: $('#rail'),
      scrim: $('#scrim'),

      navrail: $('#navrail'),
      railScrim: $('#railScrim'),
      navEdit: $('#navEdit'),
      navEditLabel: $('#navEditLabel'),
      navSave: $('#navSave'),

      editor: $('#editor'),
      editorArea: $('#editorArea'),
      editorBar: $('#editorBar'),
      editorStat: $('#editorStat'),
      editorState: $('#editorState'),

      confirm: $('#confirm'),
      confirmTitle: $('#confirmTitle'),
      confirmMsg: $('#confirmMsg'),
      confirmActs: $('#confirmActs'),

      sheet: $('#sheet'),
      segTheme: $('#segTheme'),
      fontRange: $('#fontRange'),
      fsHint: $('#fsHint'),
      lhRange: $('#lhRange'),
      lhHint: $('#lhHint'),
      wrapToggle: $('#wrapToggle'),
      rememberToggle: $('#rememberToggle'),

      toTop: $('#toTop'),
      lightbox: $('#lightbox'),
      lightboxImg: $('#lightboxImg'),
      lightboxClose: $('#lightboxClose'),
      toast: $('#toast')
    };

    dom.navSave.hidden = true;

    bindEvents();
    bindRailGesture();
    initLightbox();
    loadDocument();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
