package com.moread;

import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.animation.DecelerateInterpolator;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.documentfile.provider.DocumentFile;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * 首页：最近读过的文档，以及授权文件夹里的内容。
 *
 * 文件夹这一路不只是为了方便浏览——SAF 的单文件授权管不到同目录的兄弟文件，
 * 所以文档里引用的本地图片、以及新建和另存，都要先拿到文件夹（树）授权。
 * 文件夹里还可以继续往下走，浏览层级记在 browsePath 里。
 */
public class MainActivity extends Activity {

    private static final int REQ_OPEN_FILE = 1001;
    private static final int REQ_OPEN_TREE = 1002;

    private static final int SORT_NAME = 0;
    private static final int SORT_TIME = 1;

    /** 列表里的一行。目录和文档混在一起排，靠 isDir 区分。 */
    private static final class Item {
        final DocumentFile file;
        final String name;
        final String relPath;
        final boolean isDir;

        Item(DocumentFile file, String name, String relPath, boolean isDir) {
            this.file = file;
            this.name = name;
            this.relPath = relPath;
            this.isDir = isDir;
        }
    }

    private LinearLayout listRecent;
    private LinearLayout listFolder;
    private View sectionFolder;
    private View sectionRecent;
    private View empty;
    private TextView folderName;
    private TextView btnUp;
    private TextView btnSort;

    private Uri treeUri;
    /** 当前浏览到树根下面的哪一层，"" 表示根。 */
    private String browsePath = "";
    private int sortMode = SORT_TIME;
    /** 用户点了新建但还没有可写的文件夹，选完文件夹接着弹命名框。 */
    private boolean pendingNew;

    private final List<Recents.Entry> recents = new ArrayList<>();
    private final List<Item> folderItems = new ArrayList<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        listRecent = findViewById(R.id.listRecent);
        listFolder = findViewById(R.id.listFolder);
        sectionFolder = findViewById(R.id.sectionFolder);
        sectionRecent = findViewById(R.id.sectionRecent);
        empty = findViewById(R.id.empty);
        folderName = findViewById(R.id.folderName);
        btnUp = findViewById(R.id.btnUp);
        btnSort = findViewById(R.id.btnSort);

        sortMode = Recents.sortMode(this);

        findViewById(R.id.btnNew).setOnClickListener(v -> newDocument());
        findViewById(R.id.btnOpenFile).setOnClickListener(v -> pickFile());
        findViewById(R.id.btnOpenFolder).setOnClickListener(v -> pickFolder());
        findViewById(R.id.btnChangeFolder).setOnClickListener(v -> pickFolder());
        btnUp.setOnClickListener(v -> goUp());
        btnSort.setOnClickListener(v -> toggleSort());

        if (savedInstanceState == null) handleIntent(getIntent());

        registerBackHandler();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    /* ------------------------------------------------------------------ *
     * 返回键：在子目录里就先退回上一层
     * ------------------------------------------------------------------ */

    private void registerBackHandler() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
    }

    private void handleBack() {
        if (!browsePath.isEmpty()) {
            goUp();
            return;
        }
        finish();
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        handleBack();
    }

    /* ------------------------------------------------------------------ *
     * 从外部应用进来
     * ------------------------------------------------------------------ */

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();

        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            Uri uri = intent.getData();
            Docs.takePersistable(this, uri, intent.getFlags());
            openReader(uri, null, Docs.displayName(this, uri), null, "");

        } else if (Intent.ACTION_SEND.equals(action)) {
            // 有的应用分享文件，有的直接把文本塞进 EXTRA_TEXT
            Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (stream != null) {
                Docs.takePersistable(this, stream, intent.getFlags());
                openReader(stream, null, Docs.displayName(this, stream), null, "");
                return;
            }
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (text != null && !text.trim().isEmpty()) {
                openReader(null, null, "分享的文本.md", text, "");
            }
        }
    }

    /* ------------------------------------------------------------------ *
     * 选择器
     * ------------------------------------------------------------------ */

    private void pickFile() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        // 不少文件管理器把 .md 报成 text/plain，甚至 application/octet-stream
        i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "text/markdown", "text/x-markdown", "text/plain", "text/*", "application/octet-stream"
        });
        // 读+写都申请：这个应用自己会改文档，只有读权限的话"保存"会当场失败
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try {
            startActivityForResult(i, REQ_OPEN_FILE);
        } catch (Exception e) {
            toast(R.string.read_failed);
        }
    }

    private void pickFolder() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        try {
            startActivityForResult(i, REQ_OPEN_TREE);
        } catch (Exception e) {
            toast(R.string.read_failed);
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null) {
            pendingNew = false;
            return;
        }
        Uri uri = data.getData();
        if (uri == null) {
            pendingNew = false;
            return;
        }

        if (requestCode == REQ_OPEN_FILE) {
            Docs.takePersistable(this, uri, data.getFlags());
            openReader(uri, null, Docs.displayName(this, uri), null, "");

        } else if (requestCode == REQ_OPEN_TREE) {
            Docs.takePersistable(this, uri, data.getFlags());
            Recents.setFolder(this, uri.toString(), Docs.displayName(this, uri));
            treeUri = uri;
            browsePath = "";       // 换了根目录，层级得从头算
            refresh();
            // 是"点了新建才发现没文件夹"进来的，就接着把命名框弹出来
            if (pendingNew) {
                pendingNew = false;
                listFolder.post(this::askNewName);
            }
        }
    }

    /* ------------------------------------------------------------------ *
     * 新建
     * ------------------------------------------------------------------ */

    private void newDocument() {
        if (Docs.writableDir(this, treeUri) == null) {
            // 没有文件夹、或者拿到的是只读授权，都先补一次授权再说
            pendingNew = true;
            toast(R.string.pick_folder_first);
            pickFolder();
            return;
        }
        askNewName();
    }

    private void askNewName() {
        // 名字整段选中：多半是要直接改掉，省一次全删
        showInput(getString(R.string.sheet_title_new),
                getString(R.string.new_doc_hint), getString(R.string.new_doc),
                this::createDocument);
    }

    private void createDocument(String rawName) {
        DocumentFile made = Docs.createMarkdown(this, treeUri, rawName);
        if (made == null) {
            toast(R.string.create_failed);
            return;
        }
        Uri uri = made.getUri();
        String name = made.getName();
        if (name == null) name = "未命名.md";
        Recents.add(this, uri.toString(), name);

        // 新建出来是空的，直接进编辑，不用再点一下
        Intent i = new Intent(this, ReaderActivity.class);
        i.putExtra(ReaderActivity.EXTRA_URI, uri);
        i.putExtra(ReaderActivity.EXTRA_TREE, treeUri);
        i.putExtra(ReaderActivity.EXTRA_NAME, name);
        i.putExtra(ReaderActivity.EXTRA_BASE, browsePath);
        i.putExtra(ReaderActivity.EXTRA_EDIT, true);
        startActivity(i);
    }

    /* ------------------------------------------------------------------ *
     * 打开
     * ------------------------------------------------------------------ */

    private void openReader(Uri uri, Uri tree, String name, String inlineText, String base) {
        Intent i = new Intent(this, ReaderActivity.class);
        if (uri != null) i.putExtra(ReaderActivity.EXTRA_URI, uri);
        if (tree != null) i.putExtra(ReaderActivity.EXTRA_TREE, tree);
        if (inlineText != null) i.putExtra(ReaderActivity.EXTRA_TEXT, inlineText);
        i.putExtra(ReaderActivity.EXTRA_NAME, name);
        i.putExtra(ReaderActivity.EXTRA_BASE, base);
        startActivity(i);
        if (uri != null) Recents.add(this, uri.toString(), name);
    }

    /* ------------------------------------------------------------------ *
     * 目录浏览
     * ------------------------------------------------------------------ */

    private void goUp() {
        if (browsePath.isEmpty()) return;
        browsePath = Docs.parentOf(browsePath);
        refreshFolder();
    }

    private void toggleSort() {
        sortMode = (sortMode == SORT_TIME) ? SORT_NAME : SORT_TIME;
        Recents.setSortMode(this, sortMode);
        updateSortLabel();
        renderFolder();
    }

    private void updateSortLabel() {
        btnSort.setText(sortMode == SORT_NAME ? R.string.sort_by_name : R.string.sort_by_time);
    }

    private void refresh() {
        recents.clear();
        recents.addAll(Recents.load(this));
        Uri stored = Recents.folderUri(this);
        if (stored == null ? treeUri != null : !stored.equals(treeUri)) {
            browsePath = "";   // 换了根目录，层级得从头算
        }
        treeUri = stored;

        sectionFolder.setVisibility(treeUri != null ? View.VISIBLE : View.GONE);
        btnUp.setVisibility(browsePath.isEmpty() ? View.GONE : View.VISIBLE);
        updateSortLabel();
        updateBreadcrumb();

        renderRecents();
        refreshFolder();
    }

    private void updateBreadcrumb() {
        String root = Recents.folderName(this);
        if (root == null) root = "";
        String path = browsePath.replace("/", " / ");
        folderName.setText(path.isEmpty() ? root : (root + " / " + path));
    }

    /**
     * 列目录是 I/O，放到后台线程去；目录很大时不至于卡住界面。
     * 只列当前这一层，子目录作为可进入的条目出现。
     */
    private void refreshFolder() {
        listFolder.removeAllViews();
        folderItems.clear();
        updateBreadcrumb();
        btnUp.setVisibility(browsePath.isEmpty() ? View.GONE : View.VISIBLE);

        final Uri tree = treeUri;
        final String path = browsePath;
        if (tree == null) {
            updateEmpty();
            return;
        }

        new Thread(() -> {
            List<Item> found = new ArrayList<>();
            try {
                DocumentFile dir = dirAt(tree, path);
                if (dir != null) {
                    for (DocumentFile f : dir.listFiles()) {
                        String n = f.getName();
                        if (n == null || n.startsWith(".")) continue;
                        String rel = Docs.joinPath(path, n);
                        if (f.isDirectory()) found.add(new Item(f, n, rel, true));
                        else if (f.isFile() && Docs.isMarkdown(n)) found.add(new Item(f, n, rel, false));
                    }
                }
            } catch (Exception ignored) {
                // 授权可能已失效，当作空目录
            }
            // 目录永远排在文档前面；文档按当前规则排，同日再按名字
            Collections.sort(found, (a, b) -> {
                if (a.isDir != b.isDir) return a.isDir ? -1 : 1;
                if (sortMode == SORT_TIME && !a.isDir) {
                    int byTime = Long.compare(b.file.lastModified(), a.file.lastModified());
                    if (byTime != 0) return byTime;
                }
                return a.name.compareToIgnoreCase(b.name);
            });

            runOnUiThread(() -> {
                // 期间用户可能又换了目录，过期结果直接丢掉
                if (!tree.equals(treeUri) || !path.equals(browsePath)) return;
                folderItems.addAll(found);
                renderFolder();
                updateEmpty();
            });
        }, "moread-list").start();
    }

    private DocumentFile dirAt(Uri tree, String rel) {
        DocumentFile dir = DocumentFile.fromTreeUri(this, tree);
        if (dir == null || rel.isEmpty()) return dir;
        for (String part : rel.split("/")) {
            if (part.isEmpty()) continue;
            dir = dir.findFile(part);
            if (dir == null) return null;
        }
        return dir;
    }

    /** 进入子目录。 */
    private void enterDir(Item item) {
        browsePath = item.relPath;
        refreshFolder();
    }

    /* ------------------------------------------------------------------ *
     * 列表渲染
     * ------------------------------------------------------------------ */

    private void renderRecents() {
        listRecent.removeAllViews();
        for (Recents.Entry e : recents) {
            final String uri = e.uri;
            View row = row(listRecent, e.name, null, false,
                    v -> openReader(Uri.parse(uri), null, e.name, null, ""),
                    v -> { showRecentMenu(uri, e.name, v); return true; });
            listRecent.addView(row);
        }
        // 整节一起收起来，免得留下一个空标题
        sectionRecent.setVisibility(recents.isEmpty() ? View.GONE : View.VISIBLE);
        updateEmpty();
    }

    private void renderFolder() {
        listFolder.removeAllViews();
        if (folderItems.isEmpty()) {
            TextView hint = new TextView(this);
            hint.setText(R.string.folder_hint);
            hint.setTextSize(13f);
            hint.setTextColor(getColor(R.color.text_3));
            hint.setPadding(dp(12), dp(10), dp(12), dp(14));
            listFolder.addView(hint);
            return;
        }
        for (Item item : folderItems) {
            String meta;
            if (item.isDir) {
                meta = null;
            } else {
                long t = item.file.lastModified();
                String size = Docs.formatSize(item.file.length());
                String time = Docs.formatTime(t);
                meta = time.isEmpty() ? size : (time + " · " + size);
            }
            DocumentFile f = item.file;
            listFolder.addView(row(listFolder, item.name, meta, item.isDir,
                    v -> {
                        if (item.isDir) enterDir(item);
                        else openReader(f.getUri(), treeUri, item.name, null, browsePath);
                    },
                    v -> { showFileMenu(f, item, v); return true; }));
        }
    }

    private void updateEmpty() {
        empty.setVisibility(recents.isEmpty() && folderItems.isEmpty()
                ? View.VISIBLE : View.GONE);
    }

    /* ------------------------------------------------------------------ *
     * 长按菜单
     * ------------------------------------------------------------------ */

    /** 面板里的一行。icon 传 0 就是不显示图标。 */
    private static final class Row {
        final int icon;
        final String label;
        final boolean danger;
        final Runnable action;

        Row(int icon, String label, boolean danger, Runnable action) {
            this.icon = icon;
            this.label = label;
            this.danger = danger;
            this.action = action;
        }
    }

    private interface TextAction {
        void run(String text);
    }

    private void showFileMenu(DocumentFile file, Item item, View anchor) {
        List<Row> rows = new ArrayList<>();
        rows.add(new Row(R.drawable.ic_rename, getString(R.string.rename), false, () -> askRename(file)));
        rows.add(new Row(R.drawable.ic_share, getString(R.string.share), false,
                () -> shareDoc(file.getUri(), item.name)));

        // 目录不提供删除：这个应用是拿来读写文档的，不该顺手当文件管理器用
        if (!item.isDir) {
            rows.add(new Row(R.drawable.ic_delete, getString(R.string.delete), true,
                    () -> askDelete(file, item.name)));
        }
        showMenu(rows, anchor);
    }

    private void showRecentMenu(String uri, String name, View anchor) {
        List<Row> rows = new ArrayList<>();
        rows.add(new Row(R.drawable.ic_share, getString(R.string.share), false,
                () -> shareDoc(Uri.parse(uri), name)));
        rows.add(new Row(0, getString(R.string.remove_recent), false, () -> {
            Recents.remove(this, uri);
            refresh();
        }));
        showMenu(rows, anchor);
    }

    private void askRename(DocumentFile file) {
        String current = file.getName();
        if (current == null) return;
        // 扩展名不进输入框：用户改的是名字，格式不该被误删
        showInput(getString(R.string.sheet_title_rename),
                stripExtension(current), getString(R.string.rename),
                name -> renameTo(file, name));
    }

    private void renameTo(DocumentFile file, String rawName) {
        String name = Docs.sanitizeName(rawName);
        if (name.isEmpty()) {
            toast(R.string.rename_failed);
            return;
        }
        if (!name.toLowerCase(Locale.US).endsWith(".md")) name = name + ".md";
        if (name.equals(file.getName())) return;

        String oldUri = file.getUri().toString();
        if (file.renameTo(name)) {
            // 最近列表是按 URI 索引的，改名后 URI 变了，但也可能不变；
            // 两种都兜一下，免得列表里还挂着旧名字
            Recents.rename(this, oldUri, name);
            refresh();
        } else {
            toast(R.string.rename_failed);
        }
    }

    private void askDelete(DocumentFile file, String name) {
        List<Row> rows = new ArrayList<>();
        rows.add(new Row(R.drawable.ic_delete, getString(R.string.delete), true, () -> {
            // 文件可能已经在别处被删掉或改过，先确认拿到的是同一批数据
            boolean ok = file.exists() && file.delete();
            if (ok) {
                Recents.remove(this, file.getUri().toString());
                refresh();
            } else {
                toast(R.string.delete_failed);
            }
        }));
        showSheet(getString(R.string.sheet_title_delete), getString(R.string.delete_confirm, name), rows);
    }

    private void shareDoc(Uri uri, String name) {
        new Thread(() -> {
            String text;
            try {
                text = Docs.readText(this, uri);
            } catch (Exception e) {
                runOnUiThread(() -> toast(R.string.read_failed));
                return;
            }
            final String body = text;
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType("text/plain");
                i.putExtra(Intent.EXTRA_SUBJECT, name);
                i.putExtra(Intent.EXTRA_TEXT, body);
                try {
                    startActivity(Intent.createChooser(i, getString(R.string.share_via)));
                } catch (Exception e) {
                    toast(R.string.no_app_for_link);
                }
            });
        }, "moread-share").start();
    }

    /* ------------------------------------------------------------------ *
     * 视图工具
     * ------------------------------------------------------------------ */

    private View row(View parent, String name, String meta, boolean isDir,
                     View.OnClickListener click, View.OnLongClickListener longClick) {
        View v = LayoutInflater.from(this).inflate(R.layout.item_doc, (LinearLayout) parent, false);

        TextView nameView = v.findViewById(R.id.docName);
        TextView metaView = v.findViewById(R.id.docMeta);
        ImageView icon = v.findViewById(R.id.docIcon);

        nameView.setText(name);
        if (isDir) icon.setImageResource(R.drawable.ic_folder);

        if (meta == null || meta.isEmpty()) {
            metaView.setVisibility(View.GONE);
        } else {
            metaView.setText(meta);
            metaView.setVisibility(View.VISIBLE);
        }

        v.setOnClickListener(click);
        if (longClick != null) {
            // 只记落点，不吃事件：点击、长按、滑动的判定原样交给系统
            v.setOnTouchListener((view, ev) -> {
                if (ev.getActionMasked() == MotionEvent.ACTION_DOWN) {
                    view.setTag(new float[]{ev.getRawX(), ev.getRawY()});
                }
                return false;
            });
            v.setOnLongClickListener(longClick);
        }

        // 行与行之间留一点缝，列表才不显得挤
        if (v.getLayoutParams() instanceof LinearLayout.LayoutParams) {
            ((LinearLayout.LayoutParams) v.getLayoutParams()).bottomMargin = dp(2);
        }
        return v;
    }

    /* ------------------------------------------------------------------ *
     * 弹出层
     *
     * 两种，各管各的事，不要混：
     *
     * 悬浮卡片 —— 长按某个文件，"这几个动作你要哪个"。动作就两三个，
     *   出现在按住的地方，看完就点走。在屏幕底下滑出一大片，
     *   手指和眼睛都得多跑一趟，代价和收益不成比例。
     *
     * 底部面板 —— 输入名字、确认删除这种"停一下，做个决定"。
     *   要出键盘、要说清楚删的是哪个文件，都需要宽度和高度。
     *
     * 都不用 AlertDialog：它渲染的是 Material 的默认长相（白底直角、系统字体、
     * 系统蓝的高亮），和这个应用的纸白 / 雾蓝 / 苔绿格格不入。
     * ------------------------------------------------------------------ */

    private void showMenu(List<Row> rows, View anchor) {
        float[] point = pressPoint(anchor);

        View v = LayoutInflater.from(this).inflate(R.layout.dialog_menu, null, false);
        View card = v.findViewById(R.id.menuCard);
        View scrim = v.findViewById(R.id.menuScrim);
        View safe = v.findViewById(R.id.menuSafe);
        LinearLayout box = v.findViewById(R.id.menuRows);

        Dialog d = beginMenu(v);
        for (Row r : rows) box.addView(buildRow(box, r, d, R.layout.item_menu_row));
        scrim.setOnClickListener(x -> d.dismiss());

        // 宽度先定死。跟着文字长短忽宽忽窄的菜单不像卡片，像没对齐的浮层
        ViewGroup.LayoutParams lp = card.getLayoutParams();
        lp.width = Math.min(dp(188), getResources().getDisplayMetrics().widthPixels - dp(64));
        card.setLayoutParams(lp);

        d.show();

        // 位置要等卡片量出高矮才知道，所以卡片先透明着——窗口是全屏透明的，
        // 不藏着的话会看见它在左上角闪一下再跳到手指底下
        card.addOnLayoutChangeListener(new View.OnLayoutChangeListener() {
            @Override
            public void onLayoutChange(View view, int l, int t, int r, int b,
                                       int ol, int ot, int orr, int ob) {
                if (view.getWidth() == 0) return;
                // 位置算一次就够，算完摘掉，免得后面任何一次布局都把它挪回去
                view.removeOnLayoutChangeListener(this);

                int[] loc = new int[2];
                safe.getLocationOnScreen(loc);

                int pad = dp(8);   // 离屏幕边至少这么远
                int gap = dp(5);   // 手指和卡片之间留一点，别被指肚盖住
                int cw = view.getWidth();
                int ch = view.getHeight();

                // menuSafe 让出了系统栏的内边距，范围要按它自己的可用区算
                float minX = safe.getPaddingLeft() + pad;
                float minY = safe.getPaddingTop() + pad;
                float maxX = safe.getWidth() - safe.getPaddingRight() - cw - pad;
                float maxY = safe.getHeight() - safe.getPaddingBottom() - ch - pad;

                float px = point[0] - loc[0];
                float py = point[1] - loc[1];
                float x = px + gap;
                float y = py + gap;
                // 右边放不下就翻到手指左边，下面放不下就翻到上边
                if (x > maxX) x = px - cw - gap;
                if (y > maxY) y = py - ch - gap;
                x = Math.max(minX, Math.min(x, maxX));
                y = Math.max(minY, Math.min(y, maxY));

                view.setX(x);
                view.setY(y);

                // 从落点的方向长出来，比凭空出现更像"从这里弹出来的"
                view.setPivotX(Math.max(0, Math.min(px - x, cw)));
                view.setPivotY(Math.max(0, Math.min(py - y, ch)));
                view.setScaleX(.92f);
                view.setScaleY(.92f);
                view.animate().alpha(1f).scaleX(1f).scaleY(1f)
                        .setDuration(170)
                        .setInterpolator(new DecelerateInterpolator())
                        .start();
                scrim.animate().alpha(1f).setDuration(170).start();
            }
        });
    }

    /**
     * 长按的落点。OnLongClickListener 只给 View 不给坐标，所以在行的
     * ACTION_DOWN 上把位置存进 tag。走不到那一步的（无障碍服务直接触发长按）
     * 退回行中心——菜单落在别处比落在左上角强。
     */
    private static float[] pressPoint(View v) {
        Object tag = v.getTag();
        if (tag instanceof float[]) return (float[]) tag;
        int[] loc = new int[2];
        v.getLocationOnScreen(loc);
        return new float[]{loc[0] + v.getWidth() / 2f, loc[1] + v.getHeight() / 2f};
    }

    /** 弹出层里的一行。卡片和面板的行只是长短不同，排布规则得是同一条。 */
    private View buildRow(LinearLayout box, Row r, Dialog d, int layout) {
        View row = LayoutInflater.from(this).inflate(layout, box, false);
        ImageView icon = row.findViewById(R.id.rowIcon);
        TextView label = row.findViewById(R.id.rowLabel);

        if (r.icon == 0) {
            // 必须是 INVISIBLE 而不是 GONE：GONE 会把图标的宽度一起收掉，
            // 这行的文字就比上面几行少缩进一截，看着像没对齐
            icon.setVisibility(View.INVISIBLE);
        } else {
            icon.setImageResource(r.icon);
            icon.setImageTintList(ColorStateList.valueOf(
                    getColor(r.danger ? R.color.danger : R.color.text_2)));
        }
        label.setText(r.label);
        if (r.danger) label.setTextColor(getColor(R.color.danger));

        row.setOnClickListener(x -> {
            d.dismiss();
            if (r.action != null) r.action.run();
        });
        return row;
    }

    private void showSheet(String title, String msg, List<Row> rows) {
        View v = LayoutInflater.from(this).inflate(R.layout.dialog_sheet, null, false);
        ((TextView) v.findViewById(R.id.sheetTitle)).setText(title);

        TextView msgView = v.findViewById(R.id.sheetMsg);
        if (msg == null || msg.isEmpty()) {
            msgView.setVisibility(View.GONE);
        } else {
            msgView.setText(msg);
            msgView.setVisibility(View.VISIBLE);
        }

        Dialog d = beginSheet(v);
        LinearLayout box = v.findViewById(R.id.sheetRows);
        for (Row r : rows) box.addView(buildRow(box, r, d, R.layout.item_sheet_row));

        v.findViewById(R.id.sheetCancel).setOnClickListener(x -> d.dismiss());
        d.show();
    }

    private void showInput(String title, String initial, String okLabel, TextAction onOk) {
        View v = LayoutInflater.from(this).inflate(R.layout.dialog_sheet_input, null, false);
        ((TextView) v.findViewById(R.id.sheetTitle)).setText(title);

        final EditText input = v.findViewById(R.id.sheetInput);
        input.setHint(R.string.new_doc_hint);
        input.setText(initial);
        input.setSelection(input.getText().length());
        input.setSingleLine(true);

        Dialog d = beginSheet(v);
        TextView ok = v.findViewById(R.id.btnSheetOk);
        ok.setText(okLabel);

        v.findViewById(R.id.btnSheetCancel).setOnClickListener(x -> d.dismiss());
        ok.setOnClickListener(x -> {
            String text = input.getText().toString();
            d.dismiss();
            onOk.run(text);
        });
        // 名字里常见回车，但这里回车就是"确定"
        input.setOnEditorActionListener((tv, actionId, ev) -> {
            ok.performClick();
            return true;
        });

        d.getWindow().setSoftInputMode(
                WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                        | WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
        d.show();
        input.requestFocus();
    }

    /**
     * 悬浮卡片的窗口配置：铺满整屏、背景透明。
     *
     * 铺满是为了不用管坐标原点——压暗层要盖到状态栏上沿，卡片的落点又要能
     * 落在屏幕任何一个角落。窗口跟屏幕一样大，getLocationOnScreen 减一下就是
     * 落点，不用去猜系统栏占了多少。
     */
    private Dialog beginMenu(View content) {
        Dialog d = new Dialog(this, R.style.MenuDialog);
        d.requestWindowFeature(Window.FEATURE_NO_TITLE);
        d.setContentView(content);

        Window w = d.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        }
        return d;
    }

    /** 面板的窗口配置：贴底、全宽、背景透明（圆角是布局自己画的）。 */
    private Dialog beginSheet(View content) {
        Dialog d = new Dialog(this, R.style.SheetDialog);
        d.requestWindowFeature(Window.FEATURE_NO_TITLE);
        d.setContentView(content);

        Window w = d.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            w.setGravity(Gravity.BOTTOM);
            w.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        }
        return d;
    }

    private static String stripExtension(String name) {
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) : name;
    }

    private void toast(int res) {
        Toast.makeText(this, res, Toast.LENGTH_SHORT).show();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
