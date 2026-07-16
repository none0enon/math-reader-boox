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
import java.util.Locale;

/**
 * PWA 通过 blob URL + a[download] 导出文件（PDF/JSON），WebView 不支持 blob 下载，
 * boox-pen.js 拦截后把内容转 base64 经此桥接保存到系统下载目录。
 */
public class DownloadBridge {
    private static final String TAG = "DownloadBridge";

    private final Activity activity;

    public DownloadBridge(Activity activity) {
        this.activity = activity;
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

    private String save(String name, String mime, byte[] data) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, mime);
            Uri uri = activity.getContentResolver()
                    .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                throw new IllegalStateException("MediaStore insert failed");
            }
            try (OutputStream os = activity.getContentResolver().openOutputStream(uri)) {
                os.write(data);
            }
            return "下载/" + name;
        }
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null || !(dir.isDirectory() || dir.mkdirs()) || !dir.canWrite()) {
            // 公共目录不可写（缺存储权限）时退到应用私有目录
            dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        }
        File out = new File(dir, name);
        try (FileOutputStream fos = new FileOutputStream(out)) {
            fos.write(data);
        }
        return out.getAbsolutePath();
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
