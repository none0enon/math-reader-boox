package com.mathreader.boox;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.util.Log;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.webkit.WebViewAssetLoader;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends AppCompatActivity {
    private static final String TAG = "MainActivity";
    // https 同源加载，localStorage / IndexedDB / ServiceWorker 才能正常持久化
    private static final String START_URL = "https://appassets.androidplatform.net/www/index.html";
    private static final int REQUEST_FILE_CHOOSER = 1001;
    private static final int REQUEST_RECORD_AUDIO = 1002;

    private WebView webView;
    private BooxPenBridge penBridge;
    private DownloadBridge downloadBridge;
    private RecordingBridge recordingBridge;
    private ValueCallback<Uri[]> filePathCallback;
    private PermissionRequest pendingWebPermission;
    private String adapterJs;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 重写 dispatchTouchEvent，在事件派发给页面前记录工具类型（手指/触控笔），
        // 供阅读界面区分"手指翻页"与"触控笔套索/书写"。
        webView = new WebView(this) {
            @Override
            public boolean dispatchTouchEvent(android.view.MotionEvent event) {
                if (penBridge != null) {
                    penBridge.onWebViewTouchEvent(event);
                }
                return super.dispatchTouchEvent(event);
            }
        };
        setContentView(webView);

        // 通过版本化入口 URL 与 no-cache 响应头加载 APK 内的新资源，
        // 不主动清理 WebView 缓存，避免误删可用于本地数据恢复的缓存内容。

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        // APK 内置页面升级后不能继续使用 WebView 的旧 HTTP 缓存。
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        // 系统字体缩放会破坏 PWA 布局
        settings.setTextZoom(100);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (recordingBridge != null && "appassets.androidplatform.net".equals(uri.getHost()) &&
                        uri.getPath() != null && uri.getPath().startsWith("/native-ai-segments/")) {
                    java.util.List<String> parts = uri.getPathSegments();
                    if (parts.size() == 3 && "native-ai-segments".equals(parts.get(0))) {
                        try {
                            int index = Integer.parseInt(parts.get(2));
                            long offset = parseLongQuery(uri, "offset", 0L);
                            long length = parseLongQuery(uri, "length", -1L);
                            WebResourceResponse segment = recordingBridge.openAiSegment(
                                    parts.get(1), index, offset, length);
                            if (segment != null) return segment;
                        } catch (NumberFormatException ignored) {}
                    }
                }
                if (recordingBridge != null && "appassets.androidplatform.net".equals(uri.getHost()) &&
                        uri.getPath() != null && uri.getPath().startsWith("/native-recordings/")) {
                    long offset = parseLongQuery(uri, "offset", 0L);
                    long length = parseLongQuery(uri, "length", -1L);
                    WebResourceResponse recording = recordingBridge.openRecording(uri.getLastPathSegment(), offset, length);
                    if (recording != null) return recording;
                }
                WebResourceResponse response = assetLoader.shouldInterceptRequest(request.getUrl());
                if (response != null) {
                    Map<String, String> headers = new HashMap<>();
                    if (response.getResponseHeaders() != null) {
                        headers.putAll(response.getResponseHeaders());
                    }
                    headers.put("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
                    headers.put("Pragma", "no-cache");
                    headers.put("Expires", "0");
                    response.setResponseHeaders(headers);
                }
                return response;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("appassets.androidplatform.net".equals(uri.getHost())) {
                    return false;
                }
                // 站外链接交给系统浏览器
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception e) {
                    Log.w(TAG, "open external url failed: " + uri, e);
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                injectAdapter();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQUEST_FILE_CHOOSER);
                } catch (Exception e) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                for (String res : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) {
                        if (ContextCompat.checkSelfPermission(MainActivity.this,
                                Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                        } else {
                            pendingWebPermission = request;
                            ActivityCompat.requestPermissions(MainActivity.this,
                                    new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_RECORD_AUDIO);
                        }
                        return;
                    }
                }
                super.onPermissionRequest(request);
            }
        });

        downloadBridge = new DownloadBridge(this);
        recordingBridge = new RecordingBridge(getApplicationContext());
        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            if (url.startsWith("data:")) {
                downloadBridge.saveDataUrl(url);
            } else if (url.startsWith("http://") || url.startsWith("https://")) {
                try {
                    DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                    request.setMimeType(mimetype);
                    request.setNotificationVisibility(
                            DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                            URLUtil.guessFileName(url, contentDisposition, mimetype));
                    DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    dm.enqueue(request);
                    Toast.makeText(this, "开始下载", Toast.LENGTH_SHORT).show();
                } catch (Exception e) {
                    Log.w(TAG, "download failed: " + url, e);
                }
            }
            // blob: URL 由 boox-pen.js 拦截走 DownloadBridge.saveBase64
        });

        penBridge = new BooxPenBridge(this, webView);
        webView.addJavascriptInterface(penBridge, "BooxPenNative");
        webView.addJavascriptInterface(downloadBridge, "BooxDownloadNative");
        webView.addJavascriptInterface(recordingBridge, "BooxRecordingNative");

        webView.loadUrl(buildStartUrl());
    }


    private String buildStartUrl() {
        return START_URL + "?v=" + getCurrentVersionCode();
    }

    private int getCurrentVersionCode() {
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                return (int) getPackageManager().getPackageInfo(getPackageName(), 0).getLongVersionCode();
            }
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
        } catch (Exception e) {
            Log.w(TAG, "read package version failed", e);
            return 0;
        }
    }

    private static long parseLongQuery(Uri uri, String key, long fallback) {
        try {
            String value = uri.getQueryParameter(key);
            return value == null ? fallback : Long.parseLong(value);
        } catch (Exception ignored) {
            return fallback;
        }
    }

    private void injectAdapter() {
        if (adapterJs == null) {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                    getAssets().open("boox-pen.js"), StandardCharsets.UTF_8))) {
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    sb.append(line).append('\n');
                }
                adapterJs = sb.toString();
            } catch (Exception e) {
                Log.e(TAG, "read boox-pen.js failed", e);
                return;
            }
        }
        webView.evaluateJavascript(adapterJs, null);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_FILE_CHOOSER && filePathCallback != null) {
            filePathCallback.onReceiveValue(
                    WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            filePathCallback = null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions,
                                           @NonNull int[] grantResults) {
        if (requestCode == REQUEST_RECORD_AUDIO && pendingWebPermission != null) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                pendingWebPermission.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            } else {
                pendingWebPermission.deny();
            }
            pendingWebPermission = null;
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (penBridge != null) {
            penBridge.onResume();
        }
    }

    @Override
    protected void onPause() {
        if (penBridge != null) {
            penBridge.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (penBridge != null) {
            penBridge.onDestroy();
        }
        super.onDestroy();
    }
}
