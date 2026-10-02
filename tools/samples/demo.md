# 墨读 · 阅读器设计说明

一份用来试渲染的文档，尽量把常见的 Markdown 写法都用上一遍，好看出哪里没照顾到。

> 烟雨江南，是这套界面的底色。纸白 #f9faf4 作纸，雾蓝 #758ea2 作墨，苔绿 #cee0ba 只用来点一下重点。

## 排版

正文基准 **17px**、行高 **1.78**。中文没有词间空格，行高给得比西文排版更宽才不显得挤。段落宽度限制在 43rem，一行大约 65–75 个字符——再宽，眼睛回行就容易串行。

字号可以在阅读设置里从 15px 调到 24px。调大之后行高按比例跟着走，不会出现"字大了但行距没变"的拥挤感。

### 标题层级

标题分了六层，但真正参与目录的只有前四层。第五、六层字号收得比正文还小，颜色也淡下去，用来做句内小标题而不是章节。

#### 四级标题

正文用无衬线，大标题用衬线。这一条是刻意的：衬线字在标题尺寸下更有书卷气，但在手机屏的正文尺寸下笔画太细，容易发虚。

##### 五级标题

层级越深，颜色越淡，避免读者在小标题上停留。

###### 六级标题

## 行内元素

**加粗**用来强调结论，*斜体*在中文里其实很别扭，一般只用在英文术语上。~~删除线~~表示已废弃。行内代码像 `WebSettings.setJavaScriptEnabled(true)` 这样。

化学式和代码里的尖括号是常见的坑：`vector<int>`、`List<String>`、`a < b && c > d`。它们必须原样显示，不能被当成 HTML 标签吃掉。

链接有几种：[行内链接](https://developer.android.com/reference/android/webkit/WebView)、裸链接 https://commonmark.org 、以及带标题的 [CommonMark 规范](https://spec.commonmark.org "一份写得非常细的规范")。

## 列表

无序列表用苔绿小方块代替圆点，和主题呼应：

- 解析交给 marked，清洗交给 DOMPurify
- 高亮交给 Prism，配色自己映射
- 界面全在 WebView 里，原生只负责给文件和存设置

嵌套要能正确缩进：

- 第一层
  - 第二层
    - 第三层
      - 第四层应该还能正常显示
- 回到第一层

有序列表：

1. 先用 `ACTION_OPEN_DOCUMENT` 拿到文件
2. 申请持久化读取权限，否则重启后失效
3. 读出内容交给 WebView

从别的序号开始也应该正确：

3. 第三条
4. 第四条

任务列表：

- [x] 确定配色方案
- [x] 打通渲染管线
- [ ] 补上图片灯箱的双指缩放
- [ ] 试一下超大文档（10MB 以上）的表现

## 代码

带语言标注的代码块会显示题头和复制按钮：

```kotlin
/**
 * 在 shouldInterceptRequest 里把相对路径的图片喂回去。
 * 这个方法跑在后台线程，不能碰 UI。
 */
override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
    val uri = request.url
    if (uri.scheme != "mdr-file") return null

    val relative = Uri.decode(uri.pathSegments.joinToString("/"))
    val doc = DocumentFile.fromSingleUri(this, docUri) ?: return null
    val parent = doc.parentFile ?: return null
    val target = parent.findFile(relative) ?: return null

    return WebResourceResponse(
        guessMime(target.name),
        "UTF-8",
        contentResolver.openInputStream(target.uri)
    )
}
```

Python：

```python
def reading_time(text: str) -> int:
    """中文按 420 字/分、英文按 220 词/分估算。"""
    cjk = sum(1 for ch in text if '一' <= ch <= '鿿')
    words = len(re.findall(r"[A-Za-z0-9_'-]+", text))
    return max(1, round(cjk / 420 + words / 220))
```

C++ 和命令行：

```cpp
struct DesignTokens {
  std::string paper = "#f9faf4";
  std::string mist  = "#758ea2";
  std::string smoke = "#cfd3d4";
  std::string moss  = "#cee0ba";
};
```

```bash
# 把 vendor 重新拷一遍
node tools/vendor.mjs && ./gradlew assembleDebug
```

没有语言标注的块就不显示题头，复制按钮浮在右上角：

```
这是一段没有标注语言的文本。
  缩进和空行都会保留。
```

JSON、YAML、SQL 也认：

```json
{
  "theme": "烟雨江南",
  "tokens": ["#f9faf4", "#758ea2", "#cfd3d4", "#cee0ba"]
}
```

```yaml
reader:
  fontSize: 17
  lineHeight: 1.78
  maxWidth: 43rem
```

## 表格

表格放在横向滚动容器里，窄屏也不会把版面撑破：

| 元素 | 色值 | 用途 | 对比度 |
|:---|:---:|:---|---:|
| 纸白 | `#f9faf4` | 正文底色 | — |
| 雾蓝 | `#758ea2` | 链接、强调 | 5.4:1 |
| 烟灰 | `#cfd3d4` | 分割线、边框 | — |
| 苔绿 | `#cee0ba` | 次级强调、列表符号 | — |

## 引用与提示

普通引用：

> 阅读器的本分是把字排好。所有的动效、抽屉、设置，都不该让人注意到它们的存在。
>
> —— 一句自我提醒

提示块用来放需要跳出来看的信息：

> [!NOTE]
> 主题是"跟随系统"时，亮暗由原生侧根据系统配置决定，再回调给页面。

> [!WARNING]
> 文档里的 HTML 会经过清洗：`<script>`、事件属性、`javascript:` 链接都会被剥掉。这不是多此一举——md 文件同样是外部输入。

> [!TIP]
> 长文档可以点右上角搜图标做页内检索，命中处会高亮，回车跳到下一处。

## 图片

图片可以点开看大图，支持双指缩放和双击放大：

![墨读的三色关系示意](samples/preview-cover.png "点击可以看大图")

## 分隔线与收尾

---

写到这里，常见的写法基本都覆盖了。剩下没照顾到的，大多是 LaTeX 公式这类需要额外渲染器的场景。
