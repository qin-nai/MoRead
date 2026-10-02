package com.moread;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.InputStream;
import java.util.Collections;

/**
 * 阅读页。
 *
 * 原生这一侧刻意做得很薄：给文件内容、存取阅读设置、把相对路径的图片喂回去、
 * 把编辑后的内容写回文件。所有界面都在 WebView 里，
 * 免得两端各写一半、行为对不上。
 */
public class ReaderActivity extends Activity {

    public static final String EXTRA_URI = "extra_uri";
    public static final String EXTRA_TREE = "extra_tree";
    public static final String EXTRA_NAME = "extra_name";
    public static final String EXTRA_TEXT = "extra_text";
    /** 文档在授权目录里的相对目录。文档里写的相对路径要相对它来解析，不是相对树根 */
    public static final String EXTRA_BASE = "extra_base";
    /** 新建出来的空文件，直接进编辑 */
    public static final String EXTRA_EDIT = "extra_edit";

    private static final String PREFS = "reader_settings";
    private static final String K_THEME = "theme";
    private static final String K_SIZE = "font_size";
    private static final String K_WRAP = "wrap";
    private static final String K_LINE = "line_height";
    private static final String K_REMEMBER = "remember";
    private static final String THEME_AUTO = "auto";
    private static final int DEFAULT_SIZE = 17;

    private static final int REQ_TREE = 2001;
    /** 左缘留给"右滑拉出工具栏"的宽度，单位 dp。 */
    private static final int EDGE_DP = 26;

    private WebView web;
    private View rootView;
    private SharedPreferences prefs;

    private Uri docUri;
    private Uri treeUri;
    /** 文档所在目录（相对授权树根）。"" 表示就在根目录下。 */
    private String basePath = "";
    private String docName;
    private String inlineText;
    private boolean openInEditor;
    private boolean loaded;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        readIntent();

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // 字号由页面自己管，关掉系统字体缩放，免得两层叠加
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        // 不开 setAllowFileAccess：assets 走 file:///android_asset 本来就够用，
        // 打开它反而等于把整个文件系统暴露给页面。

        web.setBackgroundColor(backgroundColor());
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        web.addJavascriptInterface(new Bridge(), "MDRNative");
        web.setWebViewClient(new Client());

        // 工具栏是从左缘横拖出来的，而系统返回手势默认也吃这一条边。
        // 把最左边一条报给系统做例外，否则每次拉栏都会被当成"返回"。
        web.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> excludeEdgeFromBackGesture());

        FrameLayout root = new FrameLayout(this);
        // Android 15 起 targetSdk 35 强制边到边，这一句把系统栏的位置让出来，
        // 免得正文钻到状态栏底下。
        root.setFitsSystemWindows(true);
        root.setBackgroundColor(backgroundColor());
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        rootView = root;
        setContentView(root);

        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);

        web.loadUrl("file:///android_asset/reader/index.html");

        registerBackHandler();
    }

    private void readIntent() {
        Intent i = getIntent();
        docUri = i.getParcelableExtra(EXTRA_URI);
        treeUri = i.getParcelableExtra(EXTRA_TREE);
        inlineText = i.getStringExtra(EXTRA_TEXT);
        docName = i.getStringExtra(EXTRA_NAME);
        String base = i.getStringExtra(EXTRA_BASE);
        basePath = base == null ? "" : base;
        openInEditor = i.getBooleanExtra(EXTRA_EDIT, false);
        if (docName == null) docName = "未命名.md";
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) excludeEdgeFromBackGesture();
    }

    private void excludeEdgeFromBackGesture() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || web == null) return;
        int h = web.getHeight();
        if (h <= 0) return;
        int w = Math.round(getResources().getDisplayMetrics().density * EDGE_DP);
        web.setSystemGestureExclusionRects(Collections.singletonList(new Rect(0, 0, w, h)));
    }

    /* ------------------------------------------------------------------ *
     * 返回键
     * ------------------------------------------------------------------ */

    private void registerBackHandler() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Android 13 起预测性返回走 OnBackInvoked，Android 15 上 targetSdk 35
            // 默认就启用了，不再回调 onBackPressed，所以两条路都要接。
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
    }

    /** 先问页面：有浮层就关浮层，没有才真的退出。 */
    private void handleBack() {
        if (web == null) {
            finish();
            return;
        }
        try {
            web.evaluateJavascript(
                    "(window.MDR && MDR.handleBack) ? String(MDR.handleBack()) : 'false'",
                    value -> {
                        if (!"true".equals(value)) finish();
                    });
        } catch (Exception e) {
            finish();
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        // 低版本走这里；高版本由 OnBackInvoked 接管
        handleBack();
    }

    /* ------------------------------------------------------------------ *
     * 生命周期：离开时把阅读位置落盘
     * ------------------------------------------------------------------ */

    @Override
    protected void onPause() {
        super.onPause();
        // 页面里滚动是节流写回的，最后一段可能还没到写入时机，这里补一次
        if (web == null || !loaded || docUri == null) return;
        if (!prefs.getBoolean(K_REMEMBER, true)) return;
        try {
            web.evaluateJavascript(
                    "(window.MDR && MDR.currentProgress) ? MDR.currentProgress() : ''",
                    value -> storeProgress(value));
        } catch (Exception ignored) {
            // 拿不到就算了，页面侧那一次写入已经覆盖了绝大部分情况
        }
    }

    private void storeProgress(String jsonValue) {
        if (jsonValue == null) return;
        String raw = jsonValue.trim();
        if (raw.isEmpty() || "null".equals(raw) || "\"\"".equals(raw)) return;
        if (raw.length() >= 2 && raw.charAt(0) == '"') raw = raw.substring(1, raw.length() - 1);
        try {
            Recents.setProgress(this, docUri.toString(), Float.parseFloat(raw));
        } catch (NumberFormatException ignored) {
            // 页面给了个不是数字的东西，忽略
        }
    }

    /* ------------------------------------------------------------------ *
     * 主题
     * ------------------------------------------------------------------ */

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // 系统切了深色，如果用户选的是"跟随系统"，把结果推给页面
        applyThemeToPage();
        applyBackground();
    }

    private String resolvedTheme() {
        String choice = prefs.getString(K_THEME, THEME_AUTO);
        if ("light".equals(choice) || "dark".equals(choice)) return choice;
        int mode = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mode == Configuration.UI_MODE_NIGHT_YES ? "dark" : "light";
    }

    private int backgroundColor() {
        return getColor("dark".equals(resolvedTheme())
                ? R.color.reader_bg_dark : R.color.reader_bg_light);
    }

    private void applyBackground() {
        int color = backgroundColor();
        if (web != null) web.setBackgroundColor(color);
        if (rootView != null) rootView.setBackgroundColor(color);
    }

    private void applyThemeToPage() {
        applyBackground();
        if (web == null) return;
        String t = resolvedTheme();
        web.evaluateJavascript("window.MDR && MDR.setResolvedTheme(" + JSONObject.quote(t) + ")", null);
    }

    /* ------------------------------------------------------------------ *
     * 网页请求拦截：把文档同目录的资源喂回去
     * ------------------------------------------------------------------ */

    private class Client extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (u != null && "mdr-file".equals(u.getScheme())) {
                return serveLocal(u);
            }
            return null;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // 页面内的点击都自己处理并转交原生，这里一律拦住，
            // 免得 WebView 自己跳走把阅读状态弄丢。
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            loaded = true;
            // 新建出来的文件是空的，把人直接送进编辑器，省一次点击
            if (openInEditor) {
                openInEditor = false;
                view.evaluateJavascript("window.MDR && MDR.startEdit && MDR.startEdit()", null);
            }
        }
    }

    /** 这个方法跑在后台线程，不能碰 UI。 */
    private WebResourceResponse serveLocal(Uri u) {
        String rel = u.getQueryParameter("p");
        if (rel == null || treeUri == null) return null;

        // 文档里写的是相对"它自己那一层"的路径，先补上文档所在目录
        String full = Docs.normalizePath(Docs.joinPath(basePath, rel));
        Uri file = Docs.resolveInTree(this, treeUri, full);
        if (file == null) return null;

        try {
            InputStream in = getContentResolver().openInputStream(file);
            if (in == null) return null;
            String name = Docs.displayName(this, file);
            return new WebResourceResponse(Docs.mimeOf(name), null, in);
        } catch (Exception e) {
            // 解析不出来就让这次加载失败，图片位置会空着，不影响正文
            return null;
        }
    }

    /* ------------------------------------------------------------------ *
     * 注入给页面的接口
     * ------------------------------------------------------------------ */

    private class Bridge {

        /** 页面加载完会主动来取正文，这样就不用把大段文本塞进 evaluateJavascript 里转义。 */
        @JavascriptInterface
        public String getDocument() {
            try {
                String content;
                if (inlineText != null) {
                    content = inlineText;
                } else {
                    content = Docs.readText(ReaderActivity.this, docUri);
                }
                JSONObject o = new JSONObject();
                o.put("name", docName);
                o.put("content", content);
                o.put("editable", isWritable());
                if (docUri != null) {
                    o.put("progress", Recents.progress(ReaderActivity.this, docUri.toString()));
                }
                return o.toString();
            } catch (Exception e) {
                return null;
            }
        }

        @JavascriptInterface
        public String getSettings() {
            try {
                JSONObject o = new JSONObject();
                o.put("theme", prefs.getString(K_THEME, THEME_AUTO));
                o.put("fontSize", prefs.getInt(K_SIZE, DEFAULT_SIZE));
                o.put("wrap", prefs.getBoolean(K_WRAP, false));
                o.put("lineHeight", prefs.getInt(K_LINE, 1));
                o.put("remember", prefs.getBoolean(K_REMEMBER, true));
                o.put("resolvedTheme", resolvedTheme());
                return o.toString();
            } catch (JSONException e) {
                return null;
            }
        }

        @JavascriptInterface
        public void saveSettings(String json) {
            if (json == null) return;
            try {
                JSONObject o = new JSONObject(json);
                SharedPreferences.Editor e = prefs.edit();
                if (o.has("theme")) e.putString(K_THEME, o.optString("theme", THEME_AUTO));
                if (o.has("fontSize")) e.putInt(K_SIZE, o.optInt("fontSize", DEFAULT_SIZE));
                if (o.has("wrap")) e.putBoolean(K_WRAP, o.optBoolean("wrap", false));
                if (o.has("lineHeight")) e.putInt(K_LINE, o.optInt("lineHeight", 1));
                if (o.has("remember")) e.putBoolean(K_REMEMBER, o.optBoolean("remember", true));
                e.apply();
            } catch (JSONException ignored) {
                // 设置存不下来不影响本次阅读
            }
        }

        /** 阅读位置写回。页面滚动时节流调用，onPause 还会补一次。 */
        @JavascriptInterface
        public void saveProgress(String p) {
            if (docUri == null) return;
            try {
                Recents.setProgress(ReaderActivity.this, docUri.toString(), Float.parseFloat(p));
            } catch (NumberFormatException ignored) {
                // 不是数字就丢掉
            }
        }

        /** 把编辑结果写回文件。返回值页面直接拿去判断怎么提示。 */
        @JavascriptInterface
        public String writeText(String text) {
            if (text == null) text = "";
            return Docs.writeText(ReaderActivity.this, docUri, text);
        }

        @JavascriptInterface
        public void shareText(String text) {
            if (text == null) return;
            final String body = text;
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType("text/plain");
                i.putExtra(Intent.EXTRA_SUBJECT, docName);
                i.putExtra(Intent.EXTRA_TEXT, body);
                try {
                    startActivity(Intent.createChooser(i, getString(R.string.share_via)));
                } catch (ActivityNotFoundException e) {
                    showToast(getString(R.string.no_app_for_link));
                }
            });
        }

        /**
         * 单文件授权写不回去。这里就地补一次文件夹授权，
         * 用户不必退出去、从文件夹重新打开一遍。
         */
        @JavascriptInterface
        public void requestWriteAccess() {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
                try {
                    startActivityForResult(i, REQ_TREE);
                } catch (Exception e) {
                    showToast(getString(R.string.read_failed));
                }
            });
        }

        /**
         * 没有文件夹授权就返回空串，页面便不会把相对路径重写掉。
         * 重写前缀由原生给出，页面不需要知道安卓这侧的细节。
         */
        @JavascriptInterface
        public String localPrefix() {
            return treeUri != null ? Docs.LOCAL_PREFIX : "";
        }

        @JavascriptInterface
        public void requestResolvedTheme() {
            runOnUiThread(ReaderActivity.this::applyThemeToPage);
        }

        @JavascriptInterface
        public void back() {
            runOnUiThread(ReaderActivity.this::finish);
        }

        @JavascriptInterface
        public void openExternal(String url) {
            if (url == null) return;
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (ActivityNotFoundException | SecurityException e) {
                    showToast(getString(R.string.no_app_for_link));
                }
            });
        }

        /** 正文里指向另一个 md 的相对链接，就地再开一个阅读页。 */
        @JavascriptInterface
        public void openRelative(String href) {
            if (href == null) return;
            runOnUiThread(() -> {
                String path = href;
                int cut = path.indexOf('#');
                if (cut >= 0) path = path.substring(0, cut);
                if (!Docs.isMarkdown(path)) return;
                if (treeUri == null) {
                    showToast(getString(R.string.need_folder));
                    return;
                }
                // 链接同样是相对当前文档那一层的，先拼再规范化
                String rel = Docs.normalizePath(Docs.joinPath(basePath, path));
                Uri target = Docs.resolveInTree(ReaderActivity.this, treeUri, rel);
                if (target == null) {
                    showToast(getString(R.string.read_failed));
                    return;
                }
                String name = Docs.displayName(ReaderActivity.this, target);
                Recents.add(ReaderActivity.this, target.toString(), name);

                Intent i = new Intent(ReaderActivity.this, ReaderActivity.class);
                i.putExtra(EXTRA_URI, target);
                i.putExtra(EXTRA_TREE, treeUri);
                i.putExtra(EXTRA_NAME, name);
                // 跳到的那份文档可能在别的目录，层级要跟着换
                i.putExtra(EXTRA_BASE, Docs.parentOf(rel));
                startActivity(i);
            });
        }

        /** WebView 里的 navigator.clipboard 常因权限不可用，剪贴板走原生最稳。 */
        @JavascriptInterface
        public void copyText(String text) {
            if (text == null) return;
            runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("墨读", text));
                showToast(getString(R.string.copied));
            });
        }

        @JavascriptInterface
        public void toast(String msg) {
            if (msg == null) return;
            runOnUiThread(() -> showToast(msg));
        }
    }

    private boolean isWritable() {
        if (docUri == null || inlineText != null) return false;
        return Docs.canWrite(this, docUri, treeUri);
    }

    /* ------------------------------------------------------------------ *
     * 补授权
     * ------------------------------------------------------------------ */

    @SuppressWarnings("deprecation")
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_TREE) return;

        Uri picked = (resultCode == RESULT_OK && data != null) ? data.getData() : null;
        if (picked == null) {
            notifyWriteAccess(false);
            return;
        }
        Docs.takePersistable(this, picked, data.getFlags());

        // 光授权还不够——选的目录得真的罩得住这份文档
        if (!Docs.canWrite(this, docUri, picked)) {
            notifyWriteAccess(false);
            return;
        }
        treeUri = picked;
        Recents.setFolder(this, picked.toString(), Docs.displayName(this, picked));
        notifyWriteAccess(true);
    }

    private void notifyWriteAccess(boolean ok) {
        if (web == null) return;
        if (ok) {
            // 前缀是在页面加载时定下的，补了授权之后要一并更新，
            // 否则刚获得的图片访问能力要等下次打开才生效。
            web.evaluateJavascript(
                    "window.MDR && MDR.setLocalPrefix && MDR.setLocalPrefix("
                            + JSONObject.quote(Docs.LOCAL_PREFIX) + ")", null);
        }
        web.evaluateJavascript(
                "window.MDR && MDR.writeAccessResult && MDR.writeAccessResult(" + ok + ")", null);
    }

    private void showToast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    /* ------------------------------------------------------------------ *
     * 生命周期
     * ------------------------------------------------------------------ */

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("MDRNative");
            web.setWebViewClient(null);
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
