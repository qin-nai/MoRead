package com.moread;

import android.content.Context;
import android.content.Intent;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import androidx.documentfile.provider.DocumentFile;

import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Calendar;
import java.util.Locale;

/** 文件读取、写入与 SAF 相关的小工具。 */
public final class Docs {

    /**
     * 页面里相对资源的重写前缀。
     * 用自定义 scheme 而不是 https，是为了让"这个应用不联网"成为一件可验证的事：
     * 自定义 scheme 根本不会走网络栈，所以也不需要 INTERNET 权限。
     * 由 ReaderActivity.shouldInterceptRequest 接住。
     */
    public static final String LOCAL_PREFIX = "mdr-file://local/?p=";

    private Docs() {
    }

    /** 取文件的显示名，拿不到就退回路径末段。 */
    public static String displayName(Context ctx, Uri uri) {
        if (uri == null) return "未命名.md";
        String name = null;
        if ("content".equals(uri.getScheme())) {
            Cursor c = null;
            try {
                c = ctx.getContentResolver().query(
                        uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
                if (c != null && c.moveToFirst()) {
                    int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (idx >= 0) name = c.getString(idx);
                }
            } catch (Exception ignored) {
                // 某些 provider 不支持查询，退回路径末段即可
            } finally {
                if (c != null) c.close();
            }
        }
        if (name == null || name.isEmpty()) name = uri.getLastPathSegment();
        return (name == null || name.isEmpty()) ? "未命名.md" : name;
    }

    /** 整份读成文本。统一按 UTF-8 解码，并跳过 BOM。 */
    public static String readText(Context ctx, Uri uri) throws IOException {
        if (uri == null) throw new IOException("uri 为空");
        InputStream in = ctx.getContentResolver().openInputStream(uri);
        if (in == null) throw new IOException("打不开 " + uri);
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
            byte[] bytes = bos.toByteArray();
            int offset = 0;
            if (bytes.length >= 3
                    && (bytes[0] & 0xFF) == 0xEF
                    && (bytes[1] & 0xFF) == 0xBB
                    && (bytes[2] & 0xFF) == 0xBF) {
                offset = 3;
            }
            return new String(bytes, offset, bytes.length - offset, StandardCharsets.UTF_8);
        } finally {
            try {
                in.close();
            } catch (IOException ignored) {
                // 关闭失败不影响已读到的内容
            }
        }
    }

    /** 按扩展名判断 MIME，供 WebView 渲染图片用。 */
    public static String mimeOf(String name) {
        String lower = name == null ? "" : name.toLowerCase();
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".bmp")) return "image/bmp";
        if (lower.endsWith(".avif")) return "image/avif";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        String ext = MimeTypeMap.getFileExtensionFromUrl(lower);
        String mime = ext.isEmpty() ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return mime != null ? mime : "application/octet-stream";
    }

    /**
     * 把这次拿到的授权变成长期有效。
     *
     * 读和写分开试：有的 provider 只给读，一次要两个模式会整个失败，
     * 那样连读都存不下来。先要读+写，不行就退回只要读。
     * 有些来源（例如其他应用直接分享过来的 URI）根本不允许持久化，
     * 这时忽略即可——本次会话内照样能用。
     */
    public static void takePersistable(Context ctx, Uri uri, int flags) {
        if (uri == null) return;
        int want = 0;
        if ((flags & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0) want |= Intent.FLAG_GRANT_READ_URI_PERMISSION;
        if ((flags & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0) want |= Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        if (want == 0) want = Intent.FLAG_GRANT_READ_URI_PERMISSION;

        try {
            ctx.getContentResolver().takePersistableUriPermission(uri, want);
        } catch (Exception e) {
            if (want == Intent.FLAG_GRANT_READ_URI_PERMISSION) return;
            try {
                ctx.getContentResolver().takePersistableUriPermission(
                        uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {
                // 见上
            }
        }
    }

    /**
     * 把 Markdown 里的相对路径解析成可读的 content URI。
     *
     * 只有拿到了文件夹（树）授权才可能成功：SAF 的单文件授权管不到同目录的兄弟文件，
     * 所以"打开单个文件"那条路径上，文档旁边的图片是显示不出来的，
     * 想要图片正常显示就得走"选择文件夹"。
     */
    public static Uri resolveInTree(Context ctx, Uri treeUri, String relativePath) {
        if (treeUri == null || relativePath == null) return null;

        String rel = relativePath.trim().replace('\\', '/');
        if (rel.isEmpty()) return null;
        // 去掉查询串与锚点
        int cut = rel.indexOf('?');
        if (cut >= 0) rel = rel.substring(0, cut);
        cut = rel.indexOf('#');
        if (cut >= 0) rel = rel.substring(0, cut);
        while (rel.startsWith("./")) rel = rel.substring(2);
        while (rel.startsWith("/")) rel = rel.substring(1);

        DocumentFile cur;
        try {
            cur = DocumentFile.fromTreeUri(ctx, treeUri);
        } catch (Exception e) {
            return null;
        }
        if (cur == null) return null;

        for (String part : rel.split("/")) {
            if (part.isEmpty() || ".".equals(part)) continue;
            if ("..".equals(part)) {
                cur = cur.getParentFile();
            } else {
                cur = cur.findFile(part);
            }
            if (cur == null) return null;
        }
        return cur.isFile() ? cur.getUri() : null;
    }

    /* ------------------------------------------------------------------ *
     * 写入
     * ------------------------------------------------------------------ */

    /**
     * 现在能不能往这个文件里写。
     *
     * 判断依据是系统记着的持久化授权，不去试探性地打开文件——那种探法在有写权限
     * 但 provider 不认 "rw" 模式时会误报成不可写。SAF 的树授权覆盖其下所有文件，
     * 单文件授权则只覆盖它自己。
     */
    public static boolean canWrite(Context ctx, Uri uri, Uri treeUri) {
        if (uri == null) return false;
        String target = uri.toString();
        if (treeUri != null && target.startsWith(treeUri.toString())) return true;
        try {
            for (UriPermission p : ctx.getContentResolver().getPersistedUriPermissions()) {
                if (!p.isWritePermission()) continue;
                String granted = p.getUri().toString();
                if (target.equals(granted) || target.startsWith(granted)) return true;
            }
        } catch (Exception ignored) {
            // 拿不到授权列表就当不可写，页面会给出补授权的入口
        }
        return false;
    }

    /**
     * 写回整个文件。
     *
     * @return "ok"；"denied" 表示没有写权限（页面据此引导用户补一次文件夹授权）；
     * 其余字符串是给人看的失败原因。
     */
    public static String writeText(Context ctx, Uri uri, String text) {
        if (uri == null) return "没有可写入的文件";
        OutputStream out;
        try {
            // "wt" 是截断写，不加这个标志会在原内容后面续着写
            out = ctx.getContentResolver().openOutputStream(uri, "wt");
        } catch (SecurityException e) {
            return "denied";
        } catch (FileNotFoundException e) {
            String m = e.getMessage();
            return (m != null && m.contains("Permission")) ? "denied" : "文件已不存在";
        } catch (Exception e) {
            return "打不开这个位置";
        }
        if (out == null) return "denied";

        try {
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.flush();
            return "ok";
        } catch (IOException e) {
            return "写入失败";
        } finally {
            try {
                out.close();
            } catch (IOException ignored) {
                // 已经写完了，关不上不影响结果
            }
        }
    }

    /* ------------------------------------------------------------------ *
     * 新建与整理
     * ------------------------------------------------------------------ */

    /** 目录里能不能放新文件。 */
    public static DocumentFile writableDir(Context ctx, Uri treeUri) {
        if (treeUri == null) return null;
        try {
            DocumentFile dir = DocumentFile.fromTreeUri(ctx, treeUri);
            return (dir != null && dir.isDirectory() && dir.canWrite()) ? dir : null;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 在授权目录里建一个新的 .md。
     *
     * 文件名要留神：createFile 交给 provider 之后，有的实现会按 MIME 再补一次后缀，
     * 于是 "笔记.md" 变成 "笔记.md.md"。所以建完核对一遍，名字对不上就改回来。
     *
     * @return 建好的文件；失败返回 null（多半是目录没有写权限）。
     */
    public static DocumentFile createMarkdown(Context ctx, Uri treeUri, String wanted) {
        DocumentFile dir = writableDir(ctx, treeUri);
        if (dir == null) return null;

        String name = sanitizeName(wanted);
        if (name.isEmpty()) return null;
        if (!name.toLowerCase(Locale.US).endsWith(".md")) name = name + ".md";

        DocumentFile made;
        try {
            made = dir.createFile("text/markdown", name);
        } catch (Exception e) {
            return null;
        }
        if (made == null) return null;

        String actual = made.getName();
        if (actual != null && !name.equals(actual)) {
            try {
                if (made.renameTo(name)) made = dir.findFile(name);
            } catch (Exception ignored) {
                // 改不回来也还能用，只是名字难看一点
            }
        }
        return made;
    }

    /** 去掉文件名里不能用的字符。返回空串表示这个名字没法用。 */
    public static String sanitizeName(String raw) {
        if (raw == null) return "";
        String s = raw.trim();
        // 路径分隔符和各系统保留字符，外加控制字符
        s = s.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "").trim();
        // 结尾的点在部分文件系统上是非法的
        while (s.endsWith(".")) s = s.substring(0, s.length() - 1);
        if (s.isEmpty() || ".".equals(s) || "..".equals(s)) return "";
        return s;
    }

    /**
     * 改名和删除。
     *
     * 这两个动作本来走 DocumentFile 更顺手，但首页那棵树现在只留 URI、不留
     * DocumentFile（见 MainActivity.walk），所以直接调 DocumentsContract——
     * DocumentFile.renameTo / delete 底下也就是这两句，绕它一趟还得先造一个对象。
     */
    public static boolean rename(Context ctx, Uri uri, String name) {
        try {
            return DocumentsContract.renameDocument(ctx.getContentResolver(), uri, name) != null;
        } catch (Exception e) {
            return false;
        }
    }

    public static boolean delete(Context ctx, Uri uri) {
        try {
            return DocumentsContract.deleteDocument(ctx.getContentResolver(), uri);
        } catch (Exception e) {
            return false;
        }
    }

    public static boolean isMarkdown(String name) {
        if (name == null) return false;
        String n = name.toLowerCase(Locale.US);
        return n.endsWith(".md") || n.endsWith(".markdown") || n.endsWith(".mdown");
    }

    /**
     * 拼出相对于树根的路径。
     *
     * 文档可能在子目录里，此时文档里写的 `./img/a.png` 是相对于**它自己那一层**的，
     * 不是相对于树根。所以打开文档时要把"它所在的相对目录"一起带着走，
     * 解析相对路径时先拼上这个前缀。
     */
    public static String joinPath(String base, String rel) {
        String b = base == null ? "" : base.trim();
        String r = rel == null ? "" : rel.trim();
        if (b.isEmpty()) return r;
        if (r.isEmpty()) return b;
        while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
        while (r.startsWith("/")) r = r.substring(1);
        return b + "/" + r;
    }

    /** 去掉 "." 与 ".."，免得把未规范化的路径交给 SAF 去猜。 */
    public static String normalizePath(String path) {
        if (path == null || path.isEmpty()) return "";
        String[] parts = path.replace('\\', '/').split("/");
        java.util.List<String> out = new java.util.ArrayList<>();
        for (String p : parts) {
            if (p.isEmpty() || ".".equals(p)) continue;
            if ("..".equals(p)) {
                if (!out.isEmpty()) out.remove(out.size() - 1);
            } else {
                out.add(p);
            }
        }
        StringBuilder sb = new StringBuilder();
        for (String p : out) {
            if (sb.length() > 0) sb.append('/');
            sb.append(p);
        }
        return sb.toString();
    }

    public static String parentOf(String relPath) {
        if (relPath == null) return "";
        int cut = relPath.lastIndexOf('/');
        return cut < 0 ? "" : relPath.substring(0, cut);
    }

    /* ------------------------------------------------------------------ *
     * 显示用的小格式化
     * ------------------------------------------------------------------ */

    public static String formatSize(long bytes) {
        if (bytes < 0) return "";
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format(Locale.US, "%.1f KB", bytes / 1024.0);
        return String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0));
    }

    /** 今天/昨天给"今天 23:13"这种更好读的说法，更早的退回日期。 */
    public static String formatTime(long millis) {
        if (millis <= 0) return "";
        Calendar now = Calendar.getInstance();
        Calendar t = Calendar.getInstance();
        t.setTimeInMillis(millis);

        String hm = String.format(Locale.US, "%02d:%02d",
                t.get(Calendar.HOUR_OF_DAY), t.get(Calendar.MINUTE));

        Calendar midnight = Calendar.getInstance();
        midnight.set(Calendar.HOUR_OF_DAY, 0);
        midnight.set(Calendar.MINUTE, 0);
        midnight.set(Calendar.SECOND, 0);
        midnight.set(Calendar.MILLISECOND, 0);
        long todayStart = midnight.getTimeInMillis();
        long day = 24L * 60 * 60 * 1000;

        if (millis >= todayStart) return "今天 " + hm;
        if (millis >= todayStart - day) return "昨天 " + hm;

        int month = t.get(Calendar.MONTH) + 1;
        int date = t.get(Calendar.DAY_OF_MONTH);
        if (now.get(Calendar.YEAR) == t.get(Calendar.YEAR)) {
            return month + "月" + date + "日";
        }
        return t.get(Calendar.YEAR) + "年" + month + "月" + date + "日";
    }
}
