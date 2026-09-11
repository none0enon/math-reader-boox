package com.mathreader.boox;

import android.app.Activity;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.UUID;

/** Emergency-only launcher. The manifest deliberately does not register MainActivity. */
public final class RawRecoveryActivity extends Activity {
    private TextView status;
    private Button export;
    private volatile boolean exporting;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (24 * getResources().getDisplayMetrics().density);
        layout.setPadding(padding, padding, padding, padding);
        status = new TextView(this);
        status.setTextSize(20);
        status.setText("Math Reader 本机数据抢救\n\n保持设备断网。点击下方按钮后，请留在此页面，等待提示完成。\n\n本页面直接复制本机原始文件，不加载阅读器，不修改原始数据。");
        layout.addView(status);
        export = new Button(this);
        export.setText("导出本机原始数据");
        export.setOnClickListener(v -> startExport());
        layout.addView(export);
        setContentView(layout);
    }

    private void startExport() {
        if (exporting) return;
        exporting = true;
        export.setEnabled(false);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        status.setText("正在复制本机原始数据，请保持此页面打开…");
        new Thread(() -> {
            Uri uri = null;
            File partial = null;
            String name = "math-reader-raw-recovery-" +
                    new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date()) +
                    "-" + UUID.randomUUID().toString().substring(0, 8) + ".zip";
            try {
                OutputStream output;
                String location;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    values.put(MediaStore.Downloads.MIME_TYPE, "application/zip");
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    values.put(MediaStore.Downloads.IS_PENDING, 1);
                    uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) throw new IOException("无法创建下载文件");
                    output = getContentResolver().openOutputStream(uri);
                    location = "Download/" + name;
                } else {
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir == null || !(dir.isDirectory() || dir.mkdirs())) {
                        throw new IOException("无法创建下载目录");
                    }
                    partial = File.createTempFile(".recovery-", ".part", dir);
                    output = new FileOutputStream(partial);
                    location = new File(dir, name).getAbsolutePath();
                }
                if (output == null) throw new IOException("无法写入下载文件");
                long[] lastUpdate = {0};
                long[] totals;
                try (OutputStream buffered = new BufferedOutputStream(output, 256 * 1024)) {
                    totals = RawDataBackup.write(new File(getApplicationInfo().dataDir).toPath(), buffered,
                            (files, bytes) -> {
                        long now = SystemClock.elapsedRealtime();
                        if (now - lastUpdate[0] < 500) return;
                        lastUpdate[0] = now;
                        runOnUiThread(() -> status.setText("正在复制：" + files + " 个文件，" +
                                (bytes / 1024 / 1024) + " MB\n请保持此页面打开…"));
                    });
                }
                if (uri != null) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.IS_PENDING, 0);
                    if (getContentResolver().update(uri, values, null, null) != 1) {
                        throw new IOException("无法完成下载文件");
                    }
                } else {
                    java.nio.file.Files.move(partial.toPath(), new File(location).toPath());
                }
                String message = (totals[2] == 0 ? "原始数据复制完成\n" : "可读取部分已复制，存在 " + totals[2] + " 项读取异常（详见 ZIP 内清单）\n") + totals[0] + " 个文件，" +
                        (totals[1] / 1024 / 1024) + " MB\n\n" + location +
                        "\n\n保持断网，通过 USB 复制到电脑后校验。这个原始快照不能直接用于应用内导入。";
                runOnUiThread(() -> status.setText(message));
            } catch (Exception e) {
                try {
                    if (uri != null) getContentResolver().delete(uri, null, null);
                    if (partial != null) partial.delete();
                } catch (Exception ignored) { /* never touch source files */ }
                runOnUiThread(() -> status.setText("导出未完成：" + e.getMessage() + "\n原始数据未修改。"));
            } finally {
                exporting = false;
                runOnUiThread(() -> {
                    export.setEnabled(true);
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                });
            }
        }, "raw-local-recovery").start();
    }

    @Override
    public void onBackPressed() {
        if (!exporting) super.onBackPressed();
    }
}
