package com.mathreader.boox;

import android.app.Activity;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * PWA 通过 blob URL + a[download] 导出文件（PDF / 数据备份 ZIP / JSON），WebView 不支持
 * blob 下载，boox-pen.js 拦截后经此桥接保存到系统下载目录。
 *
 * 小文件可一次 {@link #saveBase64}。完整数据备份 ZIP 常有几十到几百 MB，整体 base64 会
 * 超出 JS 字符串长度与 JS 桥单次消息的上限而静默失败，因此 boox-pen.js 以分片流式写入：
 * {@link #beginSave} → {@link #appendBase64}… → {@link #finishSave}。两条路径最终都经由
 * 同一个 {@link #open}，保证 ZIP 与导出的 PDF 落在完全相同的位置（Android 10+ 为系统
 * 下载目录 Download/，旧系统为公共下载目录，不可写时退到应用私有下载目录）。
 */
public class DownloadBridge {
    private static final String TAG = "DownloadBridge";

    private final Activity activity;
    private final Map<String, PendingSave> pending = new HashMap<>();

    /** 一次进行中的写入：Android 10+ 对应 MediaStore 条目，旧系统对应直接文件。 */
    private static final class PendingSave {
        final String name;
        final OutputStream stream;
        final Uri mediaUri;
        final File file;
        final String location;
        long bytes;

        PendingSave(String name, OutputStream stream, Uri mediaUri, File file, String location) {
            this.name = name;
            this.stream = stream;
            this.mediaUri = mediaUri;
            this.file = file;
            this.location = location;
        }
    }

    public DownloadBridge(Activity activity) {
        this.activity = activity;
    }

    /** 小文件一次写入（PDF、JSON 等）。 */
    @JavascriptInterface
    public void saveBase64(String fileName, String mimeType, String base64) {
        PendingSave save = null;
        try {
            byte[] data = Base64.decode(base64, Base64.DEFAULT);
            save = open(sanitizeName(fileName), normalizeMime(mimeType));
            save.stream.write(data);
            save.bytes += data.length;
            complete(save);
        } catch (Throwable t) {
            Log.w(TAG, "saveBase64 failed", t);
            if (save != null) {
                discard(save);
            }
            toast("保存失败: " + t.getMessage());
        }
    }

    /** 分片写入：打开目标文件并返回会话 token，失败返回空串。 */
    @JavascriptInterface
    public String beginSave(String fileName, String mimeType) {
        try {
            PendingSave save = open(sanitizeName(fileName), normalizeMime(mimeType));
            String token = UUID.randomUUID().toString();
            synchronized (pending) {
                pending.put(token, save);
            }
            return token;
        } catch (Throwable t) {
            Log.w(TAG, "beginSave failed", t);
            toast("保存失败: " + t.getMessage());
            return "";
        }
    }

    /** 追加一个 base64 分片（每片独立解码，分片边界无需按 3 字节对齐）。 */
    @JavascriptInterface
    public boolean appendBase64(String token, String base64) {
        PendingSave save;
        synchronized (pending) {
            save = pending.get(token);
        }
        if (save == null) {
            return false;
        }
        try {
            byte[] data = Base64.decode(base64, Base64.DEFAULT);
            save.stream.write(data);
            save.bytes += data.length;
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "appendBase64 failed", t);
            abortSave(token, t.getMessage());
            return false;
        }
    }

    /** 全部分片写完：关闭流并发布文件。 */
    @JavascriptInterface
    public boolean finishSave(String token) {
        PendingSave save;
        synchronized (pending) {
            save = pending.remove(token);
        }
        if (save == null) {
            return false;
        }
        try {
            complete(save);
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "finishSave failed", t);
            discard(save);
            toast("保存失败: " + t.getMessage());
            return false;
        }
    }

    /** 中止分片写入并删除半成品。 */
    @JavascriptInterface
    public void abortSave(String token, String reason) {
        PendingSave save;
        synchronized (pending) {
            save = pending.remove(token);
        }
        if (save == null) {
            return;
        }
        discard(save);
        toast("保存失败: " + (reason == null || reason.trim().isEmpty() ? save.name : reason));
    }

    /** DownloadListener 收到 data: URL 时调用 */
    public void saveDataUrl(String dataUrl) {
        PendingSave save = null;
        try {
            int comma = dataUrl.indexOf(',');
            if (comma < 0) {
                return;
            }
            String header = dataUrl.substring(5, comma); // 去掉 "data:"
            String payload = dataUrl.substring(comma + 1);
            String mime = header.split(";")[0];
            if (mime.isEmpty()) {
                mime = "application/octet-stream";
            }
            byte[] data;
            if (header.contains("base64")) {
                data = Base64.decode(payload, Base64.DEFAULT);
            } else {
                data = Uri.decode(payload).getBytes("UTF-8");
            }
            String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
            String name = "download_" + new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date())
                    + (ext != null ? "." + ext : ".bin");
            save = open(name, mime);
            save.stream.write(data);
            save.bytes += data.length;
            complete(save);
        } catch (Throwable t) {
            Log.w(TAG, "saveDataUrl failed", t);
            if (save != null) {
                discard(save);
            }
            toast("保存失败: " + t.getMessage());
        }
    }

    /** 所有导出（PDF、ZIP、JSON）共用的目标位置：系统下载目录。 */
    private PendingSave open(String name, String mime) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, mime);
            // 写入期间标记为 pending，写完再发布，避免半成品出现在下载列表里
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri uri = activity.getContentResolver()
                    .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                throw new IllegalStateException("MediaStore insert failed");
            }
            OutputStream os = activity.getContentResolver().openOutputStream(uri);
            if (os == null) {
                activity.getContentResolver().delete(uri, null, null);
                throw new IllegalStateException("MediaStore open failed");
            }
            return new PendingSave(name, os, uri, null, "下载/" + name);
        }
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null || !(dir.isDirectory() || dir.mkdirs()) || !dir.canWrite()) {
            // 公共目录不可写（缺存储权限）时退到应用私有目录
            dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        }
        if (dir == null || !(dir.isDirectory() || dir.mkdirs())) {
            throw new IllegalStateException("no writable download directory");
        }
        File out = uniqueFile(dir, name);
        return new PendingSave(name, new FileOutputStream(out), null, out, out.getAbsolutePath());
    }

    private void complete(PendingSave save) throws Exception {
        save.stream.flush();
        save.stream.close();
        if (save.mediaUri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            activity.getContentResolver().update(save.mediaUri, values, null, null);
        }
        Log.i(TAG, "saved " + save.name + " (" + save.bytes + " bytes) to " + save.location);
        toast("已保存到 " + save.location);
    }

    private void discard(PendingSave save) {
        try {
            save.stream.close();
        } catch (Throwable ignored) {
        }
        try {
            if (save.mediaUri != null) {
                activity.getContentResolver().delete(save.mediaUri, null, null);
            } else if (save.file != null && save.file.exists() && !save.file.delete()) {
                Log.w(TAG, "could not delete partial file " + save.file);
            }
        } catch (Throwable t) {
            Log.w(TAG, "discard failed", t);
        }
    }

    /** 同名文件已存在时追加序号，避免同一天的多次导出互相覆盖。 */
    private static File uniqueFile(File dir, String name) {
        File out = new File(dir, name);
        if (!out.exists()) {
            return out;
        }
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            File candidate = new File(dir, base + " (" + i + ")" + ext);
            if (!candidate.exists()) {
                return candidate;
            }
        }
        return new File(dir, base + "-" + System.currentTimeMillis() + ext);
    }

    private static String normalizeMime(String mimeType) {
        return (mimeType == null || mimeType.trim().isEmpty())
                ? "application/octet-stream" : mimeType.trim();
    }

    private static String sanitizeName(String fileName) {
        String name = fileName == null ? "" : fileName.trim();
        if (name.isEmpty()) {
            name = "download_" + new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date()) + ".bin";
        }
        return name.replaceAll("[\\\\/:*?\"<>|]", "_");
    }

    private void toast(final String msg) {
        activity.runOnUiThread(() -> Toast.makeText(activity, msg, Toast.LENGTH_LONG).show());
    }
}
