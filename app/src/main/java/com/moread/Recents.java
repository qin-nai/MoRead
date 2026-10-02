package com.moread;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 最近打开过的文档、用户选定的那个文件夹，以及每份文档读到哪儿了。
 * 用 SharedPreferences 存一段 JSON——这点数据量不值得上数据库。
 */
public final class Recents {

    private static final String PREF = "moread_state";
    private static final String K_ITEMS = "recent_items";
    private static final String K_TREE = "folder_uri";
    private static final String K_TREE_NAME = "folder_name";
    private static final String K_SORT = "sort_mode";
    private static final int MAX = 24;

    public static final class Entry {
        public final String uri;
        public final String name;
        /** 上次读到全篇的百分之几，0–1。用来在重开时回到原位。 */
        public float progress;

        Entry(String uri, String name, float progress) {
            this.uri = uri;
            this.name = name;
            this.progress = progress;
        }
    }

    private Recents() {
    }

    private static SharedPreferences sp(Context c) {
        return c.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    public static List<Entry> load(Context c) {
        List<Entry> out = new ArrayList<>();
        String raw = sp(c).getString(K_ITEMS, null);
        if (raw == null) return out;
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                String uri = o.optString("uri", null);
                String name = o.optString("name", null);
                if (uri != null && name != null) {
                    out.add(new Entry(uri, name, (float) o.optDouble("progress", 0)));
                }
            }
        } catch (JSONException ignored) {
            // 记录损坏就当没有，不影响使用
        }
        return out;
    }

    /** 同一个文件再次打开时挪到最前，而不是留下两条重复记录；阅读位置跟着走。 */
    public static void add(Context c, String uri, String name) {
        if (uri == null || name == null) return;
        List<Entry> items = load(c);
        float progress = 0;
        for (int i = items.size() - 1; i >= 0; i--) {
            if (uri.equals(items.get(i).uri)) {
                progress = items.get(i).progress;
                items.remove(i);
            }
        }
        items.add(0, new Entry(uri, name, progress));
        while (items.size() > MAX) items.remove(items.size() - 1);
        save(c, items);
    }

    public static void remove(Context c, String uri) {
        List<Entry> items = load(c);
        for (int i = items.size() - 1; i >= 0; i--) {
            if (items.get(i).uri.equals(uri)) items.remove(i);
        }
        save(c, items);
    }

    /** 换了名字的文件，把旧记录的名字一并改掉，免得最近列表里还是老名字。 */
    public static void rename(Context c, String uri, String newName) {
        if (uri == null || newName == null) return;
        List<Entry> items = load(c);
        boolean changed = false;
        for (int i = 0; i < items.size(); i++) {
            Entry e = items.get(i);
            if (uri.equals(e.uri)) {
                items.set(i, new Entry(e.uri, newName, e.progress));
                changed = true;
            }
        }
        if (changed) save(c, items);
    }

    public static float progress(Context c, String uri) {
        if (uri == null) return 0;
        for (Entry e : load(c)) {
            if (uri.equals(e.uri)) return e.progress;
        }
        return 0;
    }

    public static void setProgress(Context c, String uri, float p) {
        if (uri == null) return;
        p = Math.max(0, Math.min(1, p));
        List<Entry> items = load(c);
        for (int i = 0; i < items.size(); i++) {
            Entry e = items.get(i);
            if (uri.equals(e.uri)) {
                // 位置挪动不改变列表顺序，所以这里不走 add()
                if (Math.abs(e.progress - p) < 0.005f) return;
                items.set(i, new Entry(e.uri, e.name, p));
                save(c, items);
                return;
            }
        }
    }

    private static void save(Context c, List<Entry> items) {
        JSONArray arr = new JSONArray();
        for (Entry e : items) {
            JSONObject o = new JSONObject();
            try {
                o.put("uri", e.uri);
                o.put("name", e.name);
                if (e.progress > 0) o.put("progress", e.progress);
                arr.put(o);
            } catch (JSONException ignored) {
                // JSONObject.put 只在键为 null 时抛，这里键都是常量
            }
        }
        sp(c).edit().putString(K_ITEMS, arr.toString()).apply();
    }

    public static Uri folderUri(Context c) {
        String s = sp(c).getString(K_TREE, null);
        if (s == null) return null;
        try {
            return Uri.parse(s);
        } catch (Exception e) {
            return null;
        }
    }

    public static String folderName(Context c) {
        return sp(c).getString(K_TREE_NAME, null);
    }

    /** 0 = 按名称，1 = 按时间。默认按时间，刚写的东西应该在最上面。 */
    public static int sortMode(Context c) {
        return sp(c).getInt(K_SORT, 1);
    }

    public static void setSortMode(Context c, int mode) {
        sp(c).edit().putInt(K_SORT, mode).apply();
    }

    public static void setFolder(Context c, String uri, String name) {
        if (uri == null) {
            sp(c).edit().remove(K_TREE).remove(K_TREE_NAME).apply();
        } else {
            sp(c).edit().putString(K_TREE, uri).putString(K_TREE_NAME, name).apply();
        }
    }
}
