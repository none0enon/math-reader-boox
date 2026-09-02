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
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
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
import androidx.core.content.FileProvider;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.webkit.WebViewAssetLoader;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

public class MainActivity extends AppCompatActivity {
    private static final String TAG = "MainActivity";
    // https 同源加载，localStorage / IndexedDB / ServiceWorker 才能正常持久化
    private static final String START_URL = "https://appassets.androidplatform.net/www/index.html";
    private static final int REQUEST_FILE_CHOOSER = 1001;
    private static final int REQUEST_WEB_PERMISSION = 1002;
    private static final int REQUEST_CAMERA_CAPTURE = 1003;
    private static final int REQUEST_CAMERA_PERMISSION = 1004;
    private static final String CAMERA_CACHE_DIR = "camera";

    private WebView webView;
    private BooxPenBridge penBridge;
    private DownloadBridge downloadBridge;
    private RecordingBridge recordingBridge;
    private ValueCallback<Uri[]> filePathCallback;
    private PermissionRequest pendingWebPermission;
    /** 等待 CAMERA 运行时授权期间暂存的文件选择参数（授权失败时退回文件选择器） */
    private WebChromeClient.FileChooserParams pendingChooserParams;
    /** 正在拍摄的照片输出 URI（FileProvider） */
    private Uri cameraOutputUri;
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

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // Android terminates the whole app when this callback is left
                // unhandled. Treat a killed/crashed renderer as recoverable: the
                // WebView itself cannot be reused, so detach it and recreate the
                // activity on the bookshelf instead of letting the process exit.
                Log.e(TAG, "WebView renderer gone; didCrash=" + detail.didCrash()
                        + ", priority=" + detail.rendererPriorityAtExit());
                if (penBridge != null) {
                    penBridge.onDestroy();
                    penBridge = null;
                }
                if (filePathCallback != null) {
                    try {
                        filePathCallback.onReceiveValue(null);
                    } catch (Throwable ignored) {}
                    filePathCallback = null;
                }
                pendingWebPermission = null;
                pendingChooserParams = null;
                cameraOutputUri = null;
                if (view.getParent() instanceof ViewGroup) {
                    ((ViewGroup) view.getParent()).removeView(view);
                }
                view.destroy();
                if (webView == view) {
                    webView = null;
                }
                Toast.makeText(MainActivity.this, R.string.reader_process_restarted,
                        Toast.LENGTH_LONG).show();
                if (!isFinishing() && !isDestroyed()) {
                    new Handler(Looper.getMainLooper()).post(MainActivity.this::recreate);
                }
                return true;
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
                pendingChooserParams = null;
                if (wantsImageCapture(params)) {
                    // 课堂「拍照」按钮对应 <input accept="image/*" capture>。params.createIntent()
                    // 只会打开文件选择器（仅能上传已有照片）；这里改为启动系统相机。声明了
                    // CAMERA 权限的应用必须先取得运行时授权，否则相机 Intent 会被拒绝。
                    if (ContextCompat.checkSelfPermission(MainActivity.this,
                            Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        if (launchCamera()) {
                            return true;
                        }
                        Toast.makeText(MainActivity.this, R.string.camera_unavailable,
                                Toast.LENGTH_SHORT).show();
                    } else {
                        pendingChooserParams = params;
                        ActivityCompat.requestPermissions(MainActivity.this,
                                new String[]{Manifest.permission.CAMERA}, REQUEST_CAMERA_PERMISSION);
                        return true;
                    }
                }
                if (launchFileChooser(params)) {
                    return true;
                }
                filePathCallback = null;
                return false;
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // 页面 getUserMedia：麦克风（课堂录音）与摄像头分别映射到 RECORD_AUDIO / CAMERA
                List<String> missing = new ArrayList<>();
                boolean supported = false;
                for (String res : request.getResources()) {
                    String permission = androidPermissionFor(res);
                    if (permission == null) {
                        continue;
                    }
                    supported = true;
                    if (ContextCompat.checkSelfPermission(MainActivity.this, permission)
                            != PackageManager.PERMISSION_GRANTED) {
                        missing.add(permission);
                    }
                }
                if (!supported) {
                    super.onPermissionRequest(request);
                    return;
                }
                if (missing.isEmpty()) {
                    request.grant(grantableWebResources(request));
                    return;
                }
                pendingWebPermission = request;
                ActivityCompat.requestPermissions(MainActivity.this,
                        missing.toArray(new String[0]), REQUEST_WEB_PERMISSION);
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

    /** 页面权限资源 → Android 运行时权限；不支持的资源返回 null。 */
    private static String androidPermissionFor(String resource) {
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
            return Manifest.permission.RECORD_AUDIO;
        }
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
            return Manifest.permission.CAMERA;
        }
        return null;
    }

    /** 请求中已经取得对应 Android 权限、可以授予页面的资源。 */
    private String[] grantableWebResources(PermissionRequest request) {
        List<String> granted = new ArrayList<>();
        for (String res : request.getResources()) {
            String permission = androidPermissionFor(res);
            if (permission != null && ContextCompat.checkSelfPermission(this, permission)
                    == PackageManager.PERMISSION_GRANTED) {
                granted.add(res);
            }
        }
        return granted.toArray(new String[0]);
    }

    /** &lt;input type="file" accept="image/*" capture&gt;：页面要求直接拍照。 */
    private static boolean wantsImageCapture(WebChromeClient.FileChooserParams params) {
        if (params == null || !params.isCaptureEnabled()) {
            return false;
        }
        String[] types = params.getAcceptTypes();
        if (types == null || types.length == 0) {
            return true;
        }
        for (String type : types) {
            String t = type == null ? "" : type.trim();
            if (t.isEmpty() || t.startsWith("image/")) {
                return true;
            }
        }
        return false;
    }

    private boolean launchFileChooser(WebChromeClient.FileChooserParams params) {
        try {
            startActivityForResult(params.createIntent(), REQUEST_FILE_CHOOSER);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "open file chooser failed", e);
            Toast.makeText(this, R.string.file_chooser_unavailable, Toast.LENGTH_SHORT).show();
            return false;
        }
    }

    /** 启动系统相机，照片写入应用缓存目录并经 FileProvider 授权；成功返回 true。 */
    private boolean launchCamera() {
        try {
            File dir = new File(getCacheDir(), CAMERA_CACHE_DIR);
            if (!dir.isDirectory() && !dir.mkdirs()) {
                return false;
            }
            cleanupCameraCache(dir);
            File photo = new File(dir, "IMG_"
                    + new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date()) + ".jpg");
            Uri output = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", photo);
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, output);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            cameraOutputUri = output;
            startActivityForResult(intent, REQUEST_CAMERA_CAPTURE);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "launch camera failed", e);
            cameraOutputUri = null;
            return false;
        }
    }

    /** 页面读取完照片后文件仍留在缓存目录；启动相机前清掉一天前的旧照片。 */
    private static void cleanupCameraCache(File dir) {
        File[] files = dir.listFiles();
        if (files == null) {
            return;
        }
        long cutoff = System.currentTimeMillis() - 24L * 60 * 60 * 1000;
        for (File f : files) {
            if (f.isFile() && f.lastModified() < cutoff && !f.delete()) {
                Log.w(TAG, "could not delete stale camera file " + f);
            }
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
            return;
        }
        if (requestCode == REQUEST_CAMERA_CAPTURE) {
            Uri[] result = (resultCode == RESULT_OK && cameraOutputUri != null)
                    ? new Uri[]{cameraOutputUri} : null;
            cameraOutputUri = null;
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(result);
                filePathCallback = null;
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions,
                                           @NonNull int[] grantResults) {
        if (requestCode == REQUEST_WEB_PERMISSION && pendingWebPermission != null) {
            PermissionRequest request = pendingWebPermission;
            pendingWebPermission = null;
            String[] grantable = grantableWebResources(request);
            if (grantable.length > 0) {
                request.grant(grantable);
            } else {
                request.deny();
            }
            return;
        }
        if (requestCode == REQUEST_CAMERA_PERMISSION) {
            WebChromeClient.FileChooserParams params = pendingChooserParams;
            pendingChooserParams = null;
            if (filePathCallback == null) {
                return;
            }
            boolean granted = grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (granted && launchCamera()) {
                return;
            }
            Toast.makeText(this, granted ? R.string.camera_unavailable : R.string.camera_permission_denied,
                    Toast.LENGTH_LONG).show();
            // 未授权或无法启动相机：退回系统文件选择器，仍可上传已有照片
            if (params == null || !launchFileChooser(params)) {
                filePathCallback.onReceiveValue(null);
                filePathCallback = null;
            }
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
