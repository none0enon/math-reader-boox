package com.mathreader.boox;

import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Sends the existing AI POST request outside WebView's CORS layer. */
public final class AiHttpBridge {
    private static final int CONNECT_TIMEOUT_MS = 30_000;
    private static final int READ_TIMEOUT_MS = 10 * 60_000;

    private final WebView webView;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private volatile boolean destroyed;

    public AiHttpBridge(WebView webView) {
        this.webView = webView;
    }

    @JavascriptInterface
    public void postJson(String requestId, String url, String headersJson, String body) {
        if (!destroyed) executor.execute(() -> executePost(requestId, url, headersJson, body));
    }

    public void onDestroy() {
        destroyed = true;
        executor.shutdownNow();
    }

    private void executePost(String requestId, String urlString, String headersJson, String body) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(urlString);
            String protocol = url.getProtocol();
            if (!"https".equalsIgnoreCase(protocol) && !"http".equalsIgnoreCase(protocol)) {
                throw new IllegalArgumentException("Only HTTP(S) AI endpoints are supported");
            }

            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setDoOutput(true);

            JSONObject headers = new JSONObject(headersJson == null ? "{}" : headersJson);
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String name = keys.next();
                connection.setRequestProperty(name, headers.optString(name, ""));
            }

            byte[] payload = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(payload);
            }

            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            complete(requestId, status, readFully(stream), "");
        } catch (Exception error) {
            complete(requestId, 0, "", error.getMessage() == null
                    ? error.getClass().getSimpleName() : error.getMessage());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readFully(InputStream stream) throws Exception {
        if (stream == null) return "";
        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            char[] buffer = new char[8192];
            int count;
            while ((count = reader.read(buffer)) != -1) {
                result.append(buffer, 0, count);
            }
        }
        return result.toString();
    }

    private void complete(String requestId, int status, String responseBody, String error) {
        if (destroyed) return;
        String script = "window.__completeBooxAiRequest(" +
                JSONObject.quote(requestId == null ? "" : requestId) + "," + status + "," +
                JSONObject.quote(responseBody == null ? "" : responseBody) + "," +
                JSONObject.quote(error == null ? "" : error) + ");";
        webView.post(() -> {
            if (!destroyed) webView.evaluateJavascript(script, null);
        });
    }
}
