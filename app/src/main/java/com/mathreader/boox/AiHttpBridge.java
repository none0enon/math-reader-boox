package com.mathreader.boox;

import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Executes AI POST requests outside WebView so browser CORS does not alter the request path. */
public final class AiHttpBridge {
    private static final int CONNECT_TIMEOUT_MS = 30_000;
    private static final int READ_TIMEOUT_MS = 12 * 60_000;
    private static final int MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

    private final WebView webView;
    private final ExecutorService executor = Executors.newFixedThreadPool(2);

    public AiHttpBridge(WebView webView) {
        this.webView = webView;
    }

    @JavascriptInterface
    public void post(String requestId, String url, String headersJson, String body) {
        executor.execute(() -> execute(requestId, url, headersJson, body));
    }

    public void shutdown() {
        executor.shutdownNow();
    }

    private void execute(String requestId, String url, String headersJson, String body) {
        HttpURLConnection connection = null;
        JSONObject result = new JSONObject();
        try {
            URL target = new URL(url);
            String protocol = target.getProtocol();
            if (!"https".equalsIgnoreCase(protocol) && !"http".equalsIgnoreCase(protocol)) {
                throw new IllegalArgumentException("Unsupported URL scheme");
            }

            connection = (HttpURLConnection) target.openConnection();
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);

            JSONObject headers = new JSONObject(headersJson == null ? "{}" : headersJson);
            Iterator<String> names = headers.keys();
            while (names.hasNext()) {
                String name = names.next();
                connection.setRequestProperty(name, headers.optString(name, ""));
            }

            byte[] requestBytes = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(requestBytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(requestBytes);
            }

            int status = connection.getResponseCode();
            InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            result.put("status", status);
            result.put("body", input == null ? "" : readBody(input));
        } catch (Throwable error) {
            try {
                result.put("error", error.getMessage() == null
                        ? error.getClass().getSimpleName() : error.getMessage());
            } catch (Exception ignored) {}
        } finally {
            if (connection != null) connection.disconnect();
        }
        complete(requestId, result);
    }

    private static String readBody(InputStream input) throws Exception {
        try (InputStream source = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int count;
            while ((count = source.read(buffer)) != -1) {
                total += count;
                if (total > MAX_RESPONSE_BYTES) throw new IllegalStateException("AI response too large");
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private void complete(String requestId, JSONObject result) {
        String script = "window.__booxAiHttpComplete&&window.__booxAiHttpComplete(" +
                JSONObject.quote(requestId == null ? "" : requestId) + "," +
                JSONObject.quote(result.toString()) + ");";
        webView.post(() -> webView.evaluateJavascript(script, null));
    }
}
