package com.mathreader.boox;

import android.app.Activity;
import android.content.ContentValues;
import android.database.Cursor;
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
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.UUID;

import org.json.JSONObject;

/**
 * PWA 通过 blob URL + a[download] 导出文件（PDF/JSON），WebView 不支持 blob 下载，
 * boox-pen.js 拦截后分块传输，经此桥接流式保存到系统下载目录。
 */
public class DownloadBridge {
    private static final String TAG = "DownloadBridge";

    private final Activity activity;
    // ponytail: one export at a time; use a session map only if concurrent exports are needed.
    private SaveSession activeSave;

    private static final class SaveSession {
        final String id = UUID.randomUUID().toString();
        final long expectedBytes;
        long writtenBytes;
        OutputStream stream;
        Uri uri;
        File partial;
        String name;

        SaveSession(long expectedBytes) {
            this.expectedBytes = expectedBytes;
        }
    }

    public DownloadBridge(Activity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public synchronized String beginSave(String fileName, String mimeType, long expectedBytes) {
        if (activeSave != null) return result("error", "已有文件正在导出，请稍后重试");
        if (expectedBytes < 0) return result("error", "无效的文件长度");
        try {
            startSave(fileName, mimeType, expectedBytes);
            return result("id", activeSave.id);
        } catch (Exception e) {
            discardSave();
            return result("error", errorMessage(e));
        }
    }

    @JavascriptInterface
    public synchronized String appendBase64(String id, String base64) {
        if (activeSave == null || !activeSave.id.equals(id)) return "导出会话已失效";
        try {
            if (base64 == null || base64.length() > 350000) {
                throw new IllegalArgumentException("导出数据块过大或无效");
            }
            byte[] data = Base64.decode(base64, Base64.DEFAULT);
            if (data.length > activeSave.expectedBytes - activeSave.writtenBytes) {
                throw new IllegalStateException("导出数据超出预期长度");
            }
            activeSave.stream.write(data);
            activeSave.writtenBytes += data.length;
            return "";
        } catch (Exception e) {
            discardSave();
            return errorMessage(e);
        }
    }

    @JavascriptInterface
    public synchronized String finishSave(String id) {
        if (activeSave == null || !activeSave.id.equals(id)) {
            return result("error", "导出会话已失效");
        }
        try {
            return result("location", completeSave());
        } catch (Exception e) {
            discardSave();
            return result("error", errorMessage(e));
        }
    }

    @JavascriptInterface
    public synchronized void abortSave(String id) {
        if (activeSave != null && activeSave.id.equals(id)) discardSave();
    }

    public synchronized void onDestroy() {
        discardSave();
    }

    @JavascriptInterface
    public void saveBase64(String fileName, String mimeType, String base64) {
        try {
            byte[] data = Base64.decode(base64, Base64.DEFAULT);
            String name = sanitizeName(fileName);
            String mime = (mimeType == null || mimeType.trim().isEmpty())
                    ? "application/octet-stream" : mimeType.trim();
            String location = save(name, mime, data);
            toast("已保存到 " + location);
        } catch (Throwable t) {
            Log.w(TAG, "saveBase64 failed", t);
            toast("保存失败: " + t.getMessage());
        }
    }

    /** DownloadListener 收到 data: URL 时调用 */
    public void saveDataUrl(String dataUrl) {
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
            String location = save(name, mime, data);
            toast("已保存到 " + location);
        } catch (Throwable t) {
            Log.w(TAG, "saveDataUrl failed", t);
            toast("保存失败: " + t.getMessage());
        }
    }

    private synchronized String save(String name, String mime, byte[] data) throws Exception {
        if (activeSave != null) throw new IllegalStateException("已有文件正在导出，请稍后重试");
        try {
            startSave(name, mime, data.length);
            activeSave.stream.write(data);
            activeSave.writtenBytes = data.length;
            return completeSave();
        } catch (Exception e) {
            discardSave();
            throw e;
        }
    }

    private void startSave(String name, String mime, long expectedBytes) throws Exception {
        SaveSession session = new SaveSession(expectedBytes);
        activeSave = session;
        session.name = sanitizeName(name);
        mime = mime == null || mime.trim().isEmpty() ? "application/octet-stream" : mime.trim();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, session.name);
            values.put(MediaStore.Downloads.MIME_TYPE, mime);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            session.uri = activity.getContentResolver()
                    .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (session.uri == null) {
                throw new IllegalStateException("MediaStore insert failed");
            }
            session.stream = activity.getContentResolver().openOutputStream(session.uri);
            if (session.stream == null) throw new IllegalStateException("无法打开下载文件");
            return;
        }
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null || !(dir.isDirectory() || dir.mkdirs()) || !dir.canWrite()) {
            // 公共目录不可写（缺存储权限）时退到应用私有目录
            dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        }
        if (dir == null || !(dir.isDirectory() || dir.mkdirs()) || !dir.canWrite()) {
            throw new IllegalStateException("下载目录不可写");
        }
        session.partial = File.createTempFile(".mathreader-", ".part", dir);
        session.stream = new FileOutputStream(session.partial);
    }

    private String completeSave() throws Exception {
        SaveSession session = activeSave;
        if (session.writtenBytes != session.expectedBytes) {
            throw new IllegalStateException("导出文件不完整: " + session.writtenBytes + "/" + session.expectedBytes);
        }
        session.stream.close();
        session.stream = null;
        String location;
        if (session.uri != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // Query the provider's name: duplicate exports may have been renamed.
            location = session.uri.toString();
            try (Cursor cursor = activity.getContentResolver().query(session.uri,
                    new String[]{MediaStore.Downloads.DISPLAY_NAME}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst() && cursor.getString(0) != null) {
                    location = "下载/" + cursor.getString(0);
                }
            } catch (Exception e) {
                Log.w(TAG, "download name unavailable", e);
            }
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            if (activity.getContentResolver().update(session.uri, values, null, null) != 1) {
                throw new IllegalStateException("无法完成下载文件");
            }
        } else {
            File out = new File(session.partial.getParentFile(), session.name);
            if (out.exists()) {
                int dot = session.name.lastIndexOf('.');
                String stem = dot > 0 ? session.name.substring(0, dot) : session.name;
                String ext = dot > 0 ? session.name.substring(dot) : "";
                out = new File(session.partial.getParentFile(), stem + "-" + session.id + ext);
            }
            // No REPLACE_EXISTING: a previous backup must never be overwritten.
            Files.move(session.partial.toPath(), out.toPath());
            location = out.getAbsolutePath();
        }
        activeSave = null;
        return location;
    }

    private void discardSave() {
        SaveSession session = activeSave;
        activeSave = null;
        if (session == null) return;
        if (session.stream != null) {
            try { session.stream.close(); } catch (Exception e) { Log.w(TAG, "close partial download failed", e); }
        }
        try {
            if (session.uri != null) activity.getContentResolver().delete(session.uri, null, null);
            if (session.partial != null && !session.partial.delete()) Log.w(TAG, "partial download could not be deleted");
        } catch (Exception e) {
            Log.w(TAG, "delete partial download failed", e);
        }
    }

    private static String errorMessage(Exception e) {
        Log.w(TAG, "download failed", e);
        String message = e.getMessage();
        return message == null || message.isEmpty() ? e.getClass().getSimpleName() : message;
    }

    private static String result(String key, String value) {
        return "{" + JSONObject.quote(key) + ":" + JSONObject.quote(value) + "}";
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
