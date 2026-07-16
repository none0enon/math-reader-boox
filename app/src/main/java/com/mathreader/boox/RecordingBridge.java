package com.mathreader.boox;

import android.content.ContentValues;
import android.content.Context;
import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.os.StatFs;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.util.AtomicFile;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceResponse;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Durable, append-only spool for WebView MediaRecorder chunks.
 *
 * Every successful append has been written and fsynced, and its sequence/length has been
 * atomically committed to manifest.json. The spool lives in no-backup app storage so a WebView
 * crash, activity recreation, or app upgrade cannot remove already acknowledged chunks.
 */
public final class RecordingBridge {
    private static final String TAG = "RecordingBridge";
    private static final Pattern SAFE_ID = Pattern.compile("[A-Za-z0-9_-]{8,160}");
    private static final int MAX_CONTEXT_BYTES = 8 * 1024;
    private static final int MAX_CHUNK_BYTES = 4 * 1024 * 1024;
    private static final int MAX_BASE64_CHARS = ((MAX_CHUNK_BYTES + 2) / 3) * 4 + 16;
    private static final long RESERVED_FREE_BYTES = 32L * 1024L * 1024L;
    private static final long MIN_AI_SEGMENT_DURATION_MS = 1000L;
    private static final long MIN_AI_SEGMENT_BYTES = 1024L * 1024L;
    private static final long AI_SEGMENT_TTL_MS = 24L * 60L * 60L * 1000L;
    private static final int MAX_AI_SEGMENTS = 10000;
    private static final int AI_SAMPLE_BUFFER_BYTES = 4 * 1024 * 1024;
    private static final int WAV_HEADER_BYTES = 44;
    private static final int WAV_WRITE_BUFFER_BYTES = 64 * 1024;
    private static final long MAX_WAV_DATA_BYTES = 0xffff_ffffL - 36L;
    private static final long DECODER_STALL_TIMEOUT_MS = 30_000L;
    private static final long CODEC_DEQUEUE_TIMEOUT_US = 10_000L;

    private final Context context;
    private final File root;
    private final File aiSegmentsRoot;

    public RecordingBridge(Context context) {
        this.context = context.getApplicationContext();
        this.root = new File(this.context.getNoBackupFilesDir(), "recordings");
        if (!root.isDirectory() && !root.mkdirs()) {
            Log.w(TAG, "Unable to create recording spool: " + root);
        }
        this.aiSegmentsRoot = new File(root, ".ai-segments");
        if (!aiSegmentsRoot.isDirectory() && !aiSegmentsRoot.mkdirs()) {
            Log.w(TAG, "Unable to create AI segment spool: " + aiSegmentsRoot);
        }
        cleanupExpiredAiSegments();
    }

    @JavascriptInterface
    public synchronized String begin(String id, String fileName, String mimeType, String contextJson) {
        try {
            File dir = requireDir(id, true);
            JSONObject existing = readManifest(dir);
            if (existing != null && !"DELETING".equals(existing.optString("status"))) {
                existing = reconcile(dir, existing);
                return ok(existing, "ALREADY_EXISTS").toString();
            }
            if (contextJson == null) contextJson = "{}";
            if (contextJson.getBytes(StandardCharsets.UTF_8).length > MAX_CONTEXT_BYTES) {
                return error(id, "CONTEXT_TOO_LARGE", false, null).toString();
            }
            JSONObject manifest = new JSONObject();
            manifest.put("version", 1);
            manifest.put("id", id);
            manifest.put("fileName", sanitizeName(fileName));
            manifest.put("mimeType", normalizeMime(mimeType));
            manifest.put("context", new JSONObject(contextJson));
            manifest.put("status", "OPEN");
            manifest.put("nextSeq", 0);
            manifest.put("committedBytes", 0L);
            manifest.put("durationMs", 0L);
            manifest.put("startedAt", System.currentTimeMillis());
            manifest.put("updatedAt", System.currentTimeMillis());
            writeManifest(dir, manifest);
            return ok(manifest, "OK").toString();
        } catch (Throwable t) {
            Log.w(TAG, "begin failed", t);
            return error(id, "IO_ERROR", true, t).toString();
        }
    }

    @JavascriptInterface
    public synchronized String append(String id, int seq, String rawBase64, int declaredBytes) {
        byte[] data = null;
        try {
            File dir = requireDir(id, false);
            JSONObject manifest = requireManifest(dir);
            manifest = reconcile(dir, manifest);
            if (!"OPEN".equals(manifest.optString("status")) &&
                    !"RECOVERABLE".equals(manifest.optString("status"))) {
                return error(id, "BAD_STATE", false, null).toString();
            }
            if (declaredBytes < 0 || declaredBytes > MAX_CHUNK_BYTES) {
                return error(id, "CHUNK_TOO_LARGE", false, null).toString();
            }
            if (rawBase64 == null || rawBase64.length() > MAX_BASE64_CHARS) {
                return error(id, "CHUNK_TOO_LARGE", false, null).toString();
            }
            data = Base64.decode(rawBase64 == null ? "" : rawBase64, Base64.DEFAULT);
            if (data.length != declaredBytes) {
                return error(id, "SIZE_MISMATCH", false, null).toString();
            }
            int nextSeq = manifest.optInt("nextSeq", 0);
            String hash = sha256(data);
            if (seq == nextSeq - 1 && hash.equals(manifest.optString("lastChunkSha256"))) {
                return ok(manifest, "ALREADY_COMMITTED").toString();
            }
            if (seq != nextSeq) return error(id, "OUT_OF_ORDER", true, null).toString();

            long available = new StatFs(root.getAbsolutePath()).getAvailableBytes();
            if (available - data.length < RESERVED_FREE_BYTES) {
                return error(id, "NO_SPACE", false, null).toString();
            }

            File partial = partialFile(dir);
            long offset = manifest.optLong("committedBytes", 0L);
            JSONObject pending = new JSONObject();
            pending.put("seq", seq);
            pending.put("offset", offset);
            pending.put("length", data.length);
            pending.put("sha256", hash);
            manifest.put("pending", pending);
            manifest.put("updatedAt", System.currentTimeMillis());
            writeManifest(dir, manifest);

            try (RandomAccessFile raf = new RandomAccessFile(partial, "rw")) {
                raf.seek(offset);
                raf.write(data);
                raf.setLength(offset + data.length);
                raf.getFD().sync();
            }

            manifest.remove("pending");
            manifest.put("nextSeq", seq + 1);
            manifest.put("committedBytes", offset + data.length);
            manifest.put("lastChunkSha256", hash);
            manifest.put("status", "OPEN");
            manifest.put("updatedAt", System.currentTimeMillis());
            writeManifest(dir, manifest);
            return ok(manifest, "OK").toString();
        } catch (IllegalArgumentException e) {
            return error(id, "BAD_BASE64", false, e).toString();
        } catch (Throwable t) {
            Log.w(TAG, "append failed", t);
            return error(id, "IO_ERROR", true, t).toString();
        } finally {
            data = null;
        }
    }

    @JavascriptInterface
    public synchronized String finish(String id, int expectedNextSeq, String expectedBytes, long durationMs) {
        try {
            File dir = requireDir(id, false);
            JSONObject manifest = reconcile(dir, requireManifest(dir));
            if ("COMPLETE".equals(manifest.optString("status"))) return ok(manifest, "ALREADY_COMMITTED").toString();
            long bytes = Long.parseLong(expectedBytes);
            if (manifest.optInt("nextSeq") != expectedNextSeq || manifest.optLong("committedBytes") != bytes) {
                return error(id, "SIZE_MISMATCH", true, null).toString();
            }
            File partial = partialFile(dir);
            try (RandomAccessFile raf = new RandomAccessFile(partial, "rw")) {
                raf.getFD().sync();
            }
            File completed = completedFile(dir);
            if (completed.exists() && !completed.delete()) throw new IllegalStateException("Cannot replace completed recording");
            if (!partial.renameTo(completed)) throw new IllegalStateException("Atomic recording rename failed");
            manifest.put("status", "COMPLETE");
            manifest.put("durationMs", Math.max(0L, durationMs));
            manifest.put("updatedAt", System.currentTimeMillis());
            writeManifest(dir, manifest);
            return ok(manifest, "OK").toString();
        } catch (Throwable t) {
            Log.w(TAG, "finish failed", t);
            return error(id, "IO_ERROR", true, t).toString();
        }
    }

    @JavascriptInterface
    public synchronized String markFailed(String id, String reason) {
        try {
            File dir = requireDir(id, false);
            JSONObject manifest = reconcile(dir, requireManifest(dir));
            if (!"COMPLETE".equals(manifest.optString("status"))) manifest.put("status", "RECOVERABLE");
            manifest.put("failureReason", reason == null ? "UNKNOWN" : reason);
            manifest.put("updatedAt", System.currentTimeMillis());
            writeManifest(dir, manifest);
            return ok(manifest, "OK").toString();
        } catch (Throwable t) {
            return error(id, "IO_ERROR", true, t).toString();
        }
    }

    @JavascriptInterface
    public synchronized String status(String id) {
        try {
            File dir = requireDir(id, false);
            return ok(reconcile(dir, requireManifest(dir)), "OK").toString();
        } catch (Throwable t) {
            return error(id, "NOT_FOUND", false, t).toString();
        }
    }

    @JavascriptInterface
    public synchronized String listRecoverable() {
        JSONObject result = new JSONObject();
        JSONArray items = new JSONArray();
        try {
            File[] dirs = root.listFiles(File::isDirectory);
            if (dirs != null) {
                for (File dir : dirs) {
                    try {
                        JSONObject manifest = readManifest(dir);
                        if (manifest == null || "DELETING".equals(manifest.optString("status"))) continue;
                        if (isAiTemporaryRecording(manifest)) continue;
                        manifest = reconcile(dir, manifest);
                        if (manifest.optLong("committedBytes", 0L) > 0) items.put(publicManifest(manifest));
                    } catch (Throwable t) {
                        Log.w(TAG, "Skipping corrupt recording spool: " + dir, t);
                    }
                }
            }
            result.put("ok", true);
            result.put("items", items);
        } catch (Throwable t) {
            try { result.put("ok", false).put("code", "IO_ERROR").put("items", items); } catch (Exception ignored) {}
        }
        return result.toString();
    }

    @JavascriptInterface
    public synchronized String deleteRecording(String id) {
        try {
            File dir = requireDir(id, false);
            JSONObject manifest = requireManifest(dir);
            manifest.put("status", "DELETING");
            writeManifest(dir, manifest);
            deleteTree(dir);
            return new JSONObject().put("ok", true).put("id", id).put("code", "OK").toString();
        } catch (Throwable t) {
            return error(id, "IO_ERROR", true, t).toString();
        }
    }

    @JavascriptInterface
    public synchronized String exportRecording(String id, String requestedName) {
        Uri inserted = null;
        try {
            File dir = requireDir(id, false);
            JSONObject manifest = reconcile(dir, requireManifest(dir));
            File source = recordingFile(dir, manifest);
            if (!source.isFile() || source.length() < 1) return error(id, "NOT_FOUND", false, null).toString();
            String name = sanitizeName(requestedName);
            String mime = normalizeMime(manifest.optString("mimeType"));
            String location;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                values.put(MediaStore.Downloads.MIME_TYPE, mime);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                inserted = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (inserted == null) throw new IllegalStateException("MediaStore insert failed");
                try (ParcelFileDescriptor pfd = context.getContentResolver().openFileDescriptor(inserted, "w");
                     FileInputStream in = new FileInputStream(source);
                     FileOutputStream out = new FileOutputStream(pfd.getFileDescriptor())) {
                    copy(in, out);
                    out.flush();
                    out.getFD().sync();
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.Downloads.IS_PENDING, 0);
                context.getContentResolver().update(inserted, done, null, null);
                location = "下载/" + name;
            } else {
                File dirOut = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dirOut == null && (dirOut = context.getFilesDir()) == null) throw new IllegalStateException("No export directory");
                if (!dirOut.isDirectory() && !dirOut.mkdirs()) throw new IllegalStateException("Cannot create export directory");
                File outFile = new File(dirOut, name);
                try (FileInputStream in = new FileInputStream(source); FileOutputStream out = new FileOutputStream(outFile)) {
                    copy(in, out);
                    out.flush();
                    out.getFD().sync();
                }
                location = outFile.getAbsolutePath();
            }
            return ok(manifest, "OK").put("location", location).toString();
        } catch (Throwable t) {
            if (inserted != null) try { context.getContentResolver().delete(inserted, null, null); } catch (Throwable ignored) {}
            Log.w(TAG, "export failed", t);
            return error(id, "IO_ERROR", true, t).toString();
        }
    }

    /**
     * Produces independently decodable, bounded audio files. Encoded-sample remuxing is the
     * preferred fast path. If the framework muxer cannot accept the source codec (notably Opus
     * on Android 8/9), the source is streamed through MediaCodec and committed as mono PCM16 WAV
     * segments instead. At no point is the whole recording or decoded PCM held in memory.
     */
    @JavascriptInterface
    public String prepareAiSegments(String sourceId, long maxDurationMs, long maxBytes) {
        File jobDir = null;
        String jobId = "";
        try {
            if (!SAFE_ID.matcher(sourceId == null ? "" : sourceId).matches()) {
                throw new AiSegmentException("INVALID_ID", "Invalid recording id");
            }
            if (maxDurationMs < MIN_AI_SEGMENT_DURATION_MS) {
                throw new AiSegmentException("INVALID_DURATION_LIMIT",
                        "maxDurationMs must be at least " + MIN_AI_SEGMENT_DURATION_MS);
            }
            if (maxBytes < MIN_AI_SEGMENT_BYTES) {
                throw new AiSegmentException("INVALID_BYTE_LIMIT",
                        "maxBytes must be at least " + MIN_AI_SEGMENT_BYTES);
            }

            final File source;
            synchronized (this) {
                File sourceDir = new File(root, sourceId);
                if (!sourceDir.isDirectory()) {
                    throw new AiSegmentException("SOURCE_NOT_FOUND", "Recording spool was not found");
                }
                JSONObject storedManifest = readManifest(sourceDir);
                if (storedManifest == null) {
                    throw new AiSegmentException("SOURCE_NOT_FOUND", "Recording manifest was not found");
                }
                JSONObject sourceManifest = reconcile(sourceDir, storedManifest);
                if (!"COMPLETE".equals(sourceManifest.optString("status"))) {
                    throw new AiSegmentException("SOURCE_NOT_COMPLETE",
                            "Recording must be complete before it can be segmented");
                }
                source = recordingFile(sourceDir, sourceManifest);
            }
            if (!source.isFile() || source.length() < 1L) {
                throw new AiSegmentException("SOURCE_NOT_FOUND", "Recording bytes are missing");
            }

            long estimatedOutputBytes = source.length() + Math.max(1024L * 1024L, source.length() / 20L);
            long availableBytes = new StatFs(aiSegmentsRoot.getAbsolutePath()).getAvailableBytes();
            if (estimatedOutputBytes > availableBytes - RESERVED_FREE_BYTES) {
                throw new AiSegmentException("NO_SPACE", "Not enough free space for AI audio segments");
            }

            AudioTrackInfo inspectedTrack = inspectAudioTrack(source);
            String codecMime = inspectedTrack.mimeType;
            jobId = "aijob_" + Long.toString(System.currentTimeMillis(), 36) + "_" +
                    UUID.randomUUID().toString().replace("-", "").substring(0, 12);
            jobDir = requireAiJobDir(jobId, true);

            AiPreparedSegments prepared = null;
            String fallbackReason = "";
            try {
                AiMuxTarget target = AiMuxTarget.forCodec(codecMime);
                prepared = prepareRemuxSegments(source, jobDir, jobId, target,
                        maxDurationMs, maxBytes);
            } catch (AiSegmentException remuxError) {
                if (!shouldUsePcmFallback(remuxError.code)) throw remuxError;
                fallbackReason = remuxError.code;
                Log.i(TAG, "Falling back to PCM WAV segmentation: " + remuxError.code);
            }

            if (prepared == null) {
                // A failed mux can leave already-fsynced segment files. Remove the entire
                // unpublished generation before decoding so the final manifest is all-or-none.
                deleteTree(jobDir);
                jobDir = requireAiJobDir(jobId, true);
                prepared = preparePcmWavSegments(source, jobDir, jobId,
                        maxDurationMs, maxBytes);
            }

            long createdAt = System.currentTimeMillis();
            JSONObject jobManifest = new JSONObject();
            jobManifest.put("version", 1);
            jobManifest.put("jobId", jobId);
            jobManifest.put("sourceId", sourceId);
            jobManifest.put("sourceBytes", source.length());
            jobManifest.put("codecMime", codecMime == null ? "" : codecMime);
            jobManifest.put("outputMimeType", prepared.outputMimeType);
            jobManifest.put("preparationMode", prepared.mode);
            if (!fallbackReason.isEmpty()) jobManifest.put("fallbackReason", fallbackReason);
            if (prepared.outputSampleRate > 0) {
                jobManifest.put("outputSampleRate", prepared.outputSampleRate);
                jobManifest.put("outputChannelCount", 1);
            }
            jobManifest.put("maxDurationMs", maxDurationMs);
            jobManifest.put("maxBytes", maxBytes);
            jobManifest.put("createdAt", createdAt);
            jobManifest.put("segments", prepared.segments);
            // Keep the bridge contract names used by the classroom page while retaining the
            // descriptive aliases for diagnostics and future callers.
            jobManifest.put("generation", jobId);
            jobManifest.put("items", prepared.segments);
            writeManifest(jobDir, jobManifest);

            JSONObject result = new JSONObject(jobManifest.toString());
            result.put("ok", true);
            result.put("code", "OK");
            result.put("segmentCount", prepared.segments.length());
            return result.toString();
        } catch (ArithmeticException e) {
            deleteTreeQuietly(jobDir);
            return aiSegmentError(sourceId, jobId, "INVALID_DURATION_LIMIT", false, e).toString();
        } catch (AiSegmentException e) {
            deleteTreeQuietly(jobDir);
            return aiSegmentError(sourceId, jobId, e.code, e.retryable, e).toString();
        } catch (IllegalArgumentException e) {
            deleteTreeQuietly(jobDir);
            return aiSegmentError(sourceId, jobId, "UNSUPPORTED_CONTAINER", false, e).toString();
        } catch (Throwable t) {
            deleteTreeQuietly(jobDir);
            Log.w(TAG, "prepareAiSegments failed", t);
            return aiSegmentError(sourceId, jobId, "AI_SEGMENT_IO_ERROR", true, t).toString();
        }
    }

    private static boolean shouldUsePcmFallback(String code) {
        return "OPUS_MUX_REQUIRES_API_29".equals(code) ||
                "UNSUPPORTED_CODEC".equals(code) ||
                "REMUX_FAILED".equals(code) ||
                "EMPTY_SEGMENT_FILE".equals(code) ||
                "SEGMENT_TOO_LARGE".equals(code) ||
                "SAMPLE_TOO_LARGE".equals(code);
    }

    private AiPreparedSegments prepareRemuxSegments(File source, File jobDir, String jobId,
                                                     AiMuxTarget target, long maxDurationMs,
                                                     long maxBytes) throws AiSegmentException {
        MediaExtractor extractor = null;
        AiSegmentWriter writer = null;
        try {
            extractor = openExtractor(source);
            AudioTrackInfo track = findAudioTrack(extractor);
            extractor.selectTrack(track.index);

            long containerReserve = Math.max(256L * 1024L,
                    Math.min(2L * 1024L * 1024L, maxBytes / 20L));
            long maxEncodedSampleBytes = maxBytes - containerReserve;
            if (maxEncodedSampleBytes < 1L) {
                throw new AiSegmentException("INVALID_BYTE_LIMIT",
                        "maxBytes leaves no room for a container header");
            }
            long maxDurationUs = Math.multiplyExact(maxDurationMs, 1000L);
            ByteBuffer sampleBuffer = ByteBuffer.allocateDirect(AI_SAMPLE_BUFFER_BYTES);
            MediaCodec.BufferInfo sampleInfo = new MediaCodec.BufferInfo();
            JSONArray segments = new JSONArray();
            long sourceFirstPtsUs = -1L;
            int segmentIndex = 0;

            while (true) {
                sampleBuffer.clear();
                int sampleSize = extractor.readSampleData(sampleBuffer, 0);
                if (sampleSize < 0) break;
                if (sampleSize > AI_SAMPLE_BUFFER_BYTES) {
                    throw new AiSegmentException("SAMPLE_TOO_LARGE",
                            "Encoded audio sample exceeds the native buffer limit");
                }
                long samplePtsUs = extractor.getSampleTime();
                if (samplePtsUs < 0L) break;
                if (sourceFirstPtsUs < 0L) sourceFirstPtsUs = samplePtsUs;

                boolean durationLimitReached = writer != null && writer.sampleCount > 0 &&
                        samplePtsUs - writer.startPtsUs >= maxDurationUs;
                boolean byteLimitReached = writer != null && writer.sampleCount > 0 &&
                        writer.encodedSampleBytes + sampleSize > maxEncodedSampleBytes;
                if (durationLimitReached || byteLimitReached) {
                    segments.put(writer.finish(samplePtsUs, sourceFirstPtsUs, maxBytes));
                    writer = null;
                    segmentIndex++;
                    if (segmentIndex >= MAX_AI_SEGMENTS) {
                        throw new AiSegmentException("TOO_MANY_SEGMENTS",
                                "Recording requires too many segments");
                    }
                }

                if (sampleSize > maxEncodedSampleBytes) {
                    throw new AiSegmentException("SAMPLE_TOO_LARGE",
                            "One encoded audio sample is larger than maxBytes");
                }
                if (writer == null) {
                    writer = new AiSegmentWriter(jobDir, jobId, segmentIndex, target,
                            track.format, samplePtsUs);
                }

                sampleBuffer.position(0);
                sampleBuffer.limit(sampleSize);
                int extractorFlags = extractor.getSampleFlags();
                if ((extractorFlags & MediaExtractor.SAMPLE_FLAG_ENCRYPTED) != 0) {
                    throw new AiSegmentException("ENCRYPTED_AUDIO_UNSUPPORTED",
                            "Encrypted audio cannot be prepared for AI processing");
                }
                int muxerFlags = (extractorFlags & MediaExtractor.SAMPLE_FLAG_SYNC) != 0
                        ? MediaCodec.BUFFER_FLAG_KEY_FRAME : 0;
                sampleInfo.set(0, sampleSize, Math.max(0L, samplePtsUs - writer.startPtsUs),
                        muxerFlags);
                writer.write(sampleBuffer, sampleInfo, samplePtsUs);
                extractor.advance();
            }

            if (writer != null && writer.sampleCount > 0) {
                long lastFrameUs = writer.lastSampleDeltaUs > 0L
                        ? writer.lastSampleDeltaUs : 20_000L;
                long endPtsUs = writer.lastPtsUs + lastFrameUs;
                segments.put(writer.finish(endPtsUs, sourceFirstPtsUs, maxBytes));
                writer = null;
            }
            if (segments.length() == 0) {
                throw new AiSegmentException("NO_AUDIO_SAMPLES",
                        "The audio track contains no samples");
            }
            return new AiPreparedSegments(segments, target.mimeType, "remux", 0);
        } catch (AiSegmentException e) {
            throw e;
        } catch (Throwable t) {
            throw new AiSegmentException("REMUX_FAILED",
                    "Framework audio remuxing failed", false, t);
        } finally {
            if (writer != null) writer.abort();
            if (extractor != null) {
                try { extractor.release(); } catch (Throwable ignored) {}
            }
        }
    }

    private AiPreparedSegments preparePcmWavSegments(File source, File jobDir, String jobId,
                                                      long maxDurationMs, long maxBytes)
            throws AiSegmentException {
        MediaExtractor extractor = null;
        MediaCodec decoder = null;
        boolean decoderStarted = false;
        PcmFrameProcessor processor = null;
        try {
            extractor = openExtractor(source);
            AudioTrackInfo track = findAudioTrack(extractor);
            extractor.selectTrack(track.index);
            if (track.format.containsKey(MediaFormat.KEY_CHANNEL_COUNT) &&
                    track.format.getInteger(MediaFormat.KEY_CHANNEL_COUNT) > 2) {
                throw new AiSegmentException("UNSUPPORTED_CHANNEL_COUNT",
                        "PCM fallback supports mono or stereo audio only");
            }
            // Do not add decoder-output-only keys to the compressed input format: older vendor
            // codecs sometimes reject them during configure(). Android decoders normally emit
            // PCM16; the actual output format is verified below and float PCM is converted.
            try {
                decoder = MediaCodec.createDecoderByType(track.mimeType);
                decoder.configure(track.format, null, null, 0);
                decoder.start();
                decoderStarted = true;
            } catch (Throwable t) {
                throw new AiSegmentException("DECODER_UNAVAILABLE",
                        "Android cannot decode this audio codec", false, t);
            }

            long sourceDurationUs = track.format.containsKey(MediaFormat.KEY_DURATION)
                    ? Math.max(0L, track.format.getLong(MediaFormat.KEY_DURATION)) : 0L;
            MediaCodec.BufferInfo outputInfo = new MediaCodec.BufferInfo();
            boolean inputEos = false;
            boolean outputEos = false;
            long lastInputPtsUs = 0L;
            long lastProgressMs = SystemClock.elapsedRealtime();

            while (!outputEos) {
                boolean progressed = false;
                if (!inputEos) {
                    int inputIndex = decoder.dequeueInputBuffer(CODEC_DEQUEUE_TIMEOUT_US);
                    if (inputIndex >= 0) {
                        ByteBuffer inputBuffer = decoder.getInputBuffer(inputIndex);
                        if (inputBuffer == null) {
                            throw new AiSegmentException("DECODER_FAILED",
                                    "Decoder returned a null input buffer", true);
                        }
                        inputBuffer.clear();
                        int sampleSize = extractor.readSampleData(inputBuffer, 0);
                        if (sampleSize < 0) {
                            decoder.queueInputBuffer(inputIndex, 0, 0, lastInputPtsUs,
                                    MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputEos = true;
                        } else {
                            int extractorFlags = extractor.getSampleFlags();
                            if ((extractorFlags & MediaExtractor.SAMPLE_FLAG_ENCRYPTED) != 0) {
                                throw new AiSegmentException("ENCRYPTED_AUDIO_UNSUPPORTED",
                                        "Encrypted audio cannot be decoded for AI processing");
                            }
                            if (sampleSize > inputBuffer.capacity()) {
                                throw new AiSegmentException("DECODER_INPUT_TOO_SMALL",
                                        "Encoded sample exceeds the decoder input buffer");
                            }
                            long samplePtsUs = Math.max(0L, extractor.getSampleTime());
                            lastInputPtsUs = samplePtsUs;
                            decoder.queueInputBuffer(inputIndex, 0, sampleSize, samplePtsUs, 0);
                            extractor.advance();
                        }
                        progressed = true;
                    }
                }

                int outputIndex = decoder.dequeueOutputBuffer(outputInfo, CODEC_DEQUEUE_TIMEOUT_US);
                if (outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    processor = ensurePcmProcessor(processor, decoder.getOutputFormat(),
                            jobDir, jobId, maxDurationMs, maxBytes, sourceDurationUs);
                    progressed = true;
                } else if (outputIndex == MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED) {
                    progressed = true;
                } else if (outputIndex >= 0) {
                    try {
                        if (processor == null) {
                            processor = ensurePcmProcessor(null, decoder.getOutputFormat(outputIndex),
                                    jobDir, jobId, maxDurationMs, maxBytes, sourceDurationUs);
                        }
                        if (outputInfo.size > 0 &&
                                (outputInfo.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                            ByteBuffer outputBuffer = decoder.getOutputBuffer(outputIndex);
                            if (outputBuffer == null) {
                                throw new AiSegmentException("DECODER_FAILED",
                                        "Decoder returned a null output buffer", true);
                            }
                            long end = (long) outputInfo.offset + outputInfo.size;
                            if (outputInfo.offset < 0 || outputInfo.size < 0 ||
                                    end > outputBuffer.capacity()) {
                                throw new AiSegmentException("DECODER_FAILED",
                                        "Decoder returned invalid PCM buffer bounds", true);
                            }
                            ByteBuffer pcm = outputBuffer.duplicate().order(ByteOrder.nativeOrder());
                            pcm.position(outputInfo.offset);
                            pcm.limit((int) end);
                            processor.consume(pcm.slice().order(ByteOrder.nativeOrder()));
                        }
                        outputEos = (outputInfo.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                    } finally {
                        decoder.releaseOutputBuffer(outputIndex, false);
                    }
                    progressed = true;
                }

                if (progressed) {
                    lastProgressMs = SystemClock.elapsedRealtime();
                } else if (SystemClock.elapsedRealtime() - lastProgressMs > DECODER_STALL_TIMEOUT_MS) {
                    throw new AiSegmentException("DECODER_TIMEOUT",
                            "Audio decoder stopped making progress", true);
                }
            }

            if (processor == null) {
                throw new AiSegmentException("NO_AUDIO_SAMPLES",
                        "The decoder produced no PCM output");
            }
            JSONArray segments = processor.finish();
            return new AiPreparedSegments(segments, "audio/wav", "pcm16-wav",
                    processor.outputSampleRate);
        } catch (AiSegmentException e) {
            throw e;
        } catch (Throwable t) {
            throw new AiSegmentException("DECODER_FAILED",
                    "PCM WAV fallback failed", true, t);
        } finally {
            if (processor != null) processor.abort();
            if (decoder != null) {
                if (decoderStarted) {
                    try { decoder.stop(); } catch (Throwable ignored) {}
                }
                try { decoder.release(); } catch (Throwable ignored) {}
            }
            if (extractor != null) {
                try { extractor.release(); } catch (Throwable ignored) {}
            }
        }
    }

    private PcmFrameProcessor ensurePcmProcessor(PcmFrameProcessor existing,
                                                 MediaFormat outputFormat, File jobDir,
                                                 String jobId, long maxDurationMs,
                                                 long maxBytes, long sourceDurationUs)
            throws AiSegmentException {
        int channelCount = requiredPositiveFormatInt(outputFormat,
                MediaFormat.KEY_CHANNEL_COUNT, "INVALID_CHANNEL_COUNT");
        if (channelCount > 2) {
            throw new AiSegmentException("UNSUPPORTED_CHANNEL_COUNT",
                    "PCM fallback supports mono or stereo audio only");
        }
        int sampleRate = requiredPositiveFormatInt(outputFormat,
                MediaFormat.KEY_SAMPLE_RATE, "INVALID_SAMPLE_RATE");
        int pcmEncoding = outputFormat.containsKey(MediaFormat.KEY_PCM_ENCODING)
                ? outputFormat.getInteger(MediaFormat.KEY_PCM_ENCODING)
                : AudioFormat.ENCODING_PCM_16BIT;
        if (pcmEncoding != AudioFormat.ENCODING_PCM_16BIT &&
                pcmEncoding != AudioFormat.ENCODING_PCM_FLOAT) {
            throw new AiSegmentException("UNSUPPORTED_PCM_ENCODING",
                    "Decoder output is not PCM16 or float PCM: " + pcmEncoding);
        }
        if (existing != null) {
            existing.requireSameFormat(sampleRate, channelCount, pcmEncoding);
            return existing;
        }
        return new PcmFrameProcessor(jobDir, jobId, sampleRate, channelCount, pcmEncoding,
                maxDurationMs, maxBytes, sourceDurationUs);
    }

    private static int requiredPositiveFormatInt(MediaFormat format, String key, String code)
            throws AiSegmentException {
        if (format == null || !format.containsKey(key)) {
            throw new AiSegmentException(code, "Decoder output format is missing " + key);
        }
        int value = format.getInteger(key);
        if (value <= 0) throw new AiSegmentException(code, "Invalid " + key + ": " + value);
        return value;
    }

    private AudioTrackInfo inspectAudioTrack(File source) throws AiSegmentException {
        MediaExtractor extractor = null;
        try {
            extractor = openExtractor(source);
            return findAudioTrack(extractor);
        } catch (AiSegmentException e) {
            throw e;
        } catch (Throwable t) {
            throw new AiSegmentException("UNSUPPORTED_CONTAINER",
                    "Cannot inspect the recording container", false, t);
        } finally {
            if (extractor != null) {
                try { extractor.release(); } catch (Throwable ignored) {}
            }
        }
    }

    private static MediaExtractor openExtractor(File source) throws IOException {
        MediaExtractor extractor = new MediaExtractor();
        try (FileInputStream input = new FileInputStream(source)) {
            extractor.setDataSource(input.getFD());
            return extractor;
        } catch (Throwable t) {
            try { extractor.release(); } catch (Throwable ignored) {}
            if (t instanceof IOException) throw (IOException) t;
            if (t instanceof RuntimeException) throw (RuntimeException) t;
            if (t instanceof Error) throw (Error) t;
            throw new IOException("Cannot open media extractor", t);
        }
    }

    private static AudioTrackInfo findAudioTrack(MediaExtractor extractor)
            throws AiSegmentException {
        for (int index = 0; index < extractor.getTrackCount(); index++) {
            MediaFormat candidate = extractor.getTrackFormat(index);
            String mime = candidate.getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.toLowerCase(Locale.US).startsWith("audio/")) {
                return new AudioTrackInfo(index, candidate, mime);
            }
        }
        throw new AiSegmentException("NO_AUDIO_TRACK",
                "No audio track was found in the recording");
    }

    /** Deletes all temporary files produced by prepareAiSegments. Idempotent. */
    @JavascriptInterface
    public String releaseAiSegments(String sourceId, String generation) {
        try {
            String jobId = generation;
            if (!SAFE_ID.matcher(sourceId == null ? "" : sourceId).matches()) {
                return aiSegmentError(sourceId, jobId, "INVALID_ID", false, null).toString();
            }
            if (!isSafeAiJobId(jobId)) {
                return aiSegmentError(sourceId, jobId, "INVALID_JOB_ID", false, null).toString();
            }
            File jobDir = new File(aiSegmentsRoot, jobId);
            if (!jobDir.isDirectory()) {
                return new JSONObject().put("ok", true).put("code", "ALREADY_RELEASED")
                        .put("jobId", jobId).toString();
            }
            JSONObject manifest = requireManifest(jobDir);
            if (!sourceId.equals(manifest.optString("sourceId"))) {
                return aiSegmentError(sourceId, jobId, "SOURCE_JOB_MISMATCH", false, null).toString();
            }
            deleteTree(jobDir);
            return new JSONObject().put("ok", true).put("code", "OK")
                    .put("jobId", jobId).toString();
        } catch (Throwable t) {
            return aiSegmentError(sourceId, generation, "AI_SEGMENT_CLEANUP_FAILED", true, t).toString();
        }
    }

    /** Called by MainActivity for /native-ai-segments/{jobId}/{index}. */
    public WebResourceResponse openAiSegment(String jobId, int index, long offset, long requestedLength) {
        FileInputStream input = null;
        try {
            if (!isSafeAiJobId(jobId) || index < 0) return null;
            File jobDir = requireAiJobDir(jobId, false);
            JSONObject manifest = requireManifest(jobDir);
            JSONArray segments = manifest.optJSONArray("segments");
            if (segments == null || index >= segments.length()) return null;
            JSONObject segment = segments.getJSONObject(index);
            if (segment.optInt("index", -1) != index) return null;
            String fileName = segment.optString("fileName", "");
            if (!isSafeAiSegmentFileName(fileName)) return null;
            File source = new File(jobDir, fileName);
            if (!source.isFile() || source.length() != segment.optLong("byteLength", -1L)) return null;
            long sourceLength = source.length();
            if (offset < 0L || offset > sourceLength) return null;
            long available = sourceLength - offset;
            long length = requestedLength < 0L ? available : Math.min(requestedLength, available);
            if (length < 0L) return null;
            input = new FileInputStream(source);
            input.getChannel().position(offset);
            WebResourceResponse response = new WebResourceResponse(
                    segment.optString("mimeType", "audio/webm"), null,
                    new BoundedInputStream(input, length));
            input = null; // The WebView now owns the bounded stream and closes it after reading.
            return response;
        } catch (Throwable t) {
            if (input != null) {
                try { input.close(); } catch (Throwable ignored) {}
            }
            return null;
        }
    }

    /** Called by MainActivity for https://appassets.androidplatform.net/native-recordings/{id}. */
    public synchronized WebResourceResponse openRecording(String id, long offset, long requestedLength) {
        try {
            File dir = requireDir(id, false);
            JSONObject manifest = reconcile(dir, requireManifest(dir));
            File source = recordingFile(dir, manifest);
            if (!source.isFile()) return null;
            long sourceLength = source.length();
            if (offset < 0L || offset > sourceLength) return null;
            long available = sourceLength - offset;
            long length = requestedLength < 0L ? available : Math.min(requestedLength, available);
            if (length < 0L) return null;
            FileInputStream input = new FileInputStream(source);
            input.getChannel().position(offset);
            return new WebResourceResponse(normalizeMime(manifest.optString("mimeType")), null,
                    new BoundedInputStream(input, length));
        } catch (Throwable t) {
            return null;
        }
    }

    private JSONObject reconcile(File dir, JSONObject manifest) throws Exception {
        // finish() renames the fully fsynced stream before committing COMPLETE to the
        // AtomicFile manifest. If the process dies between those two operations, the
        // completed file is already authoritative; recognize it instead of ever
        // recreating/truncating stream.partial on a later finish retry.
        File completed = completedFile(dir);
        long committedBytes = manifest.optLong("committedBytes", -1L);
        if (completed.isFile() && committedBytes >= 0L && completed.length() == committedBytes) {
            if (!"COMPLETE".equals(manifest.optString("status")) || manifest.has("pending")) {
                long recoveredDuration = Math.max(0L,
                        manifest.optLong("updatedAt", System.currentTimeMillis()) -
                        manifest.optLong("startedAt", System.currentTimeMillis()));
                manifest.put("durationMs", Math.max(manifest.optLong("durationMs", 0L), recoveredDuration));
                manifest.remove("pending");
                manifest.put("status", "COMPLETE");
                manifest.put("updatedAt", System.currentTimeMillis());
                writeManifest(dir, manifest);
            }
            return manifest;
        }

        JSONObject pending = manifest.optJSONObject("pending");
        if (pending == null) return manifest;
        File partial = partialFile(dir);
        long offset = pending.getLong("offset");
        int length = pending.getInt("length");
        boolean committed = partial.isFile() && partial.length() >= offset + length &&
                pending.getString("sha256").equals(sha256(partial, offset, length));
        if (committed) {
            try (RandomAccessFile raf = new RandomAccessFile(partial, "rw")) {
                raf.setLength(offset + length);
                raf.getFD().sync();
            }
            manifest.put("nextSeq", pending.getInt("seq") + 1);
            manifest.put("committedBytes", offset + length);
            manifest.put("lastChunkSha256", pending.getString("sha256"));
        } else if (partial.exists()) {
            try (RandomAccessFile raf = new RandomAccessFile(partial, "rw")) {
                raf.setLength(offset);
                raf.getFD().sync();
            }
            manifest.put("status", "RECOVERABLE");
        }
        manifest.remove("pending");
        manifest.put("updatedAt", System.currentTimeMillis());
        writeManifest(dir, manifest);
        return manifest;
    }

    private File requireDir(String id, boolean create) {
        if (!SAFE_ID.matcher(id == null ? "" : id).matches()) throw new IllegalArgumentException("Bad id");
        File dir = new File(root, id);
        if (create) {
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IllegalStateException("Cannot create spool directory");
        } else if (!dir.isDirectory()) throw new IllegalStateException("Recording not found");
        return dir;
    }

    private JSONObject requireManifest(File dir) throws Exception {
        JSONObject manifest = readManifest(dir);
        if (manifest == null) throw new IllegalStateException("Manifest not found");
        return manifest;
    }

    private JSONObject readManifest(File dir) throws Exception {
        File file = new File(dir, "manifest.json");
        if (!file.isFile()) return null;
        try (FileInputStream in = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
            return new JSONObject(out.toString(StandardCharsets.UTF_8.name()));
        }
    }

    private void writeManifest(File dir, JSONObject manifest) throws Exception {
        AtomicFile atomic = new AtomicFile(new File(dir, "manifest.json"));
        FileOutputStream out = null;
        try {
            out = atomic.startWrite();
            out.write(manifest.toString().getBytes(StandardCharsets.UTF_8));
            out.flush();
            out.getFD().sync();
            atomic.finishWrite(out);
        } catch (Throwable t) {
            if (out != null) atomic.failWrite(out);
            throw t;
        }
    }

    private JSONObject ok(JSONObject manifest, String code) throws Exception {
        JSONObject result = publicManifest(manifest);
        result.put("ok", true);
        result.put("code", code);
        return result;
    }

    private JSONObject publicManifest(JSONObject manifest) throws Exception {
        JSONObject result = new JSONObject();
        result.put("id", manifest.optString("id"));
        result.put("status", manifest.optString("status"));
        result.put("nextSeq", manifest.optInt("nextSeq"));
        result.put("committedBytes", manifest.optLong("committedBytes"));
        result.put("durationMs", manifest.optLong("durationMs"));
        result.put("mimeType", manifest.optString("mimeType"));
        result.put("fileName", manifest.optString("fileName"));
        result.put("startedAt", manifest.optLong("startedAt"));
        result.put("updatedAt", manifest.optLong("updatedAt"));
        result.put("context", manifest.optJSONObject("context") == null ? new JSONObject() : manifest.optJSONObject("context"));
        result.put("nativeUrl", "/native-recordings/" + manifest.optString("id"));
        return result;
    }

    private JSONObject error(String id, String code, boolean retryable, Throwable t) {
        JSONObject result = new JSONObject();
        try {
            result.put("ok", false);
            result.put("id", id == null ? "" : id);
            result.put("code", code);
            result.put("retryable", retryable);
            if (t != null && t.getMessage() != null) result.put("message", t.getMessage());
        } catch (Exception ignored) {}
        return result;
    }

    private JSONObject aiSegmentError(String sourceId, String jobId, String code,
                                      boolean retryable, Throwable t) {
        JSONObject result = error(sourceId, code, retryable, t);
        try { result.put("jobId", jobId == null ? "" : jobId); } catch (Exception ignored) {}
        return result;
    }

    private File requireAiJobDir(String jobId, boolean create) {
        if (!isSafeAiJobId(jobId)) throw new IllegalArgumentException("Bad AI segment job id");
        File dir = new File(aiSegmentsRoot, jobId);
        if (create) {
            if (!dir.isDirectory() && !dir.mkdirs()) {
                throw new IllegalStateException("Cannot create AI segment job directory");
            }
        } else if (!dir.isDirectory()) {
            throw new IllegalStateException("AI segment job not found");
        }
        return dir;
    }

    private static boolean isSafeAiJobId(String jobId) {
        return jobId != null && jobId.startsWith("aijob_") && SAFE_ID.matcher(jobId).matches();
    }

    private static boolean isSafeAiSegmentFileName(String fileName) {
        return fileName != null && fileName.matches("segment_[0-9]{5}\\.(webm|m4a|wav)");
    }

    private void cleanupExpiredAiSegments() {
        File[] jobs = aiSegmentsRoot.listFiles(File::isDirectory);
        long cutoff = System.currentTimeMillis() - AI_SEGMENT_TTL_MS;
        if (jobs != null) {
            for (File job : jobs) {
                try {
                    JSONObject manifest = readManifest(job);
                    long createdAt = manifest == null ? job.lastModified() :
                            manifest.optLong("createdAt", job.lastModified());
                    if (createdAt <= 0L || createdAt < cutoff) deleteTree(job);
                } catch (Throwable t) {
                    Log.w(TAG, "Unable to clean stale AI segment job: " + job, t);
                }
            }
        }

        // Imported recordings can be mirrored through begin/append/finish with
        // context.aiTemporary=true before prepareAiSegments is called. Keep those staging
        // spools out of crash recovery and reclaim them after an abandoned job.
        File[] recordingDirs = root.listFiles(File::isDirectory);
        if (recordingDirs != null) {
            for (File dir : recordingDirs) {
                if (dir.equals(aiSegmentsRoot)) continue;
                try {
                    JSONObject manifest = readManifest(dir);
                    if (manifest != null && isAiTemporaryRecording(manifest) &&
                            manifest.optLong("updatedAt", dir.lastModified()) < cutoff) {
                        deleteTree(dir);
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "Unable to clean stale AI source mirror: " + dir, t);
                }
            }
        }
    }

    private static boolean isAiTemporaryRecording(JSONObject manifest) {
        JSONObject context = manifest == null ? null : manifest.optJSONObject("context");
        return context != null && context.optBoolean("aiTemporary", false);
    }

    private static void deleteTreeQuietly(File file) {
        if (file == null || !file.exists()) return;
        try { deleteTree(file); } catch (Throwable ignored) {}
    }

    private File partialFile(File dir) { return new File(dir, "stream.partial"); }
    private File completedFile(File dir) { return new File(dir, "recording.bin"); }
    private File recordingFile(File dir, JSONObject manifest) {
        File completed = completedFile(dir);
        return completed.isFile() ? completed : partialFile(dir);
    }

    private String normalizeMime(String mime) {
        if (mime == null || !mime.toLowerCase(Locale.US).startsWith("audio/")) return "audio/webm";
        return mime.split(";", 2)[0].trim();
    }

    private String sanitizeName(String value) {
        String name = value == null ? "" : value.trim();
        if (name.isEmpty()) name = "recording.webm";
        return name.replaceAll("[\\\\/:*?\"<>|]", "_");
    }

    private static String sha256(byte[] data) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        return hex(digest.digest(data));
    }

    private static String sha256(File file, long offset, int length) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
            raf.seek(offset);
            byte[] buf = new byte[64 * 1024];
            int remaining = length;
            while (remaining > 0) {
                int n = raf.read(buf, 0, Math.min(buf.length, remaining));
                if (n < 0) break;
                digest.update(buf, 0, n);
                remaining -= n;
            }
            if (remaining != 0) return "";
        }
        return hex(digest.digest());
    }

    private static String hex(byte[] value) {
        StringBuilder out = new StringBuilder(value.length * 2);
        for (byte b : value) out.append(String.format(Locale.US, "%02x", b & 0xff));
        return out.toString();
    }

    private static void copy(FileInputStream in, FileOutputStream out) throws Exception {
        byte[] buf = new byte[256 * 1024];
        int n;
        while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
    }

    private static final class AiSegmentException extends Exception {
        final String code;
        final boolean retryable;

        AiSegmentException(String code, String message) {
            this(code, message, false);
        }

        AiSegmentException(String code, String message, boolean retryable) {
            super(message);
            this.code = code;
            this.retryable = retryable;
        }

        AiSegmentException(String code, String message, boolean retryable, Throwable cause) {
            super(message, cause);
            this.code = code;
            this.retryable = retryable;
        }
    }

    private static final class AudioTrackInfo {
        final int index;
        final MediaFormat format;
        final String mimeType;

        AudioTrackInfo(int index, MediaFormat format, String mimeType) {
            this.index = index;
            this.format = format;
            this.mimeType = mimeType;
        }
    }

    private static final class AiPreparedSegments {
        final JSONArray segments;
        final String outputMimeType;
        final String mode;
        final int outputSampleRate;

        AiPreparedSegments(JSONArray segments, String outputMimeType, String mode,
                           int outputSampleRate) {
            this.segments = segments;
            this.outputMimeType = outputMimeType;
            this.mode = mode;
            this.outputSampleRate = outputSampleRate;
        }
    }

    private static final class AiMuxTarget {
        final int muxerFormat;
        final String mimeType;
        final String extension;

        AiMuxTarget(int muxerFormat, String mimeType, String extension) {
            this.muxerFormat = muxerFormat;
            this.mimeType = mimeType;
            this.extension = extension;
        }

        static AiMuxTarget forCodec(String codecMime) throws AiSegmentException {
            String normalized = codecMime == null ? "" : codecMime.toLowerCase(Locale.US);
            if ("audio/opus".equals(normalized)) {
                // The WebM container exists from API 21, but framework MediaMuxer did not
                // accept Opus tracks until API 29. Fail explicitly on older firmware instead
                // of returning corrupt/empty files or a generic addTrack error.
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                    throw new AiSegmentException("OPUS_MUX_REQUIRES_API_29",
                            "Local Opus segmentation requires Android 10 or newer");
                }
                return new AiMuxTarget(MediaMuxer.OutputFormat.MUXER_OUTPUT_WEBM,
                        "audio/webm", "webm");
            }
            if ("audio/vorbis".equals(normalized)) {
                // Ogg/Vorbis samples can be remuxed as WebM from API 21. Ogg output itself is
                // API 29+, so WebM also keeps the app's minSdk 26 path available.
                return new AiMuxTarget(MediaMuxer.OutputFormat.MUXER_OUTPUT_WEBM,
                        "audio/webm", "webm");
            }
            if ("audio/mp4a-latm".equals(normalized) || "audio/aac".equals(normalized)) {
                return new AiMuxTarget(MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4,
                        "audio/mp4", "m4a");
            }
            throw new AiSegmentException("UNSUPPORTED_CODEC",
                    "Audio codec cannot be remuxed without transcoding: " + normalized);
        }
    }

    private static final class AiSegmentWriter {
        final String jobId;
        final int index;
        final AiMuxTarget target;
        final File partialFile;
        final File completedFile;
        final long startPtsUs;
        MediaMuxer muxer;
        int outputTrack;
        int sampleCount;
        long encodedSampleBytes;
        long lastPtsUs;
        long lastSampleDeltaUs;

        AiSegmentWriter(File jobDir, String jobId, int index, AiMuxTarget target,
                        MediaFormat audioFormat, long startPtsUs) throws IOException {
            this.jobId = jobId;
            this.index = index;
            this.target = target;
            this.startPtsUs = startPtsUs;
            String baseName = String.format(Locale.US, "segment_%05d", index);
            this.partialFile = new File(jobDir, baseName + ".partial");
            this.completedFile = new File(jobDir, baseName + "." + target.extension);
            try (RandomAccessFile output = new RandomAccessFile(partialFile, "rw")) {
                output.setLength(0L);
                // FileDescriptor constructor is available at this app's minSdk (26), and WebM
                // specifically requires a read-write descriptor.
                this.muxer = new MediaMuxer(output.getFD(), target.muxerFormat);
            }
            try {
                this.outputTrack = muxer.addTrack(audioFormat);
                muxer.start();
            } catch (Throwable t) {
                try { muxer.release(); } catch (Throwable ignored) {}
                muxer = null;
                deleteTreeQuietly(partialFile);
                if (t instanceof IOException) throw (IOException) t;
                if (t instanceof RuntimeException) throw (RuntimeException) t;
                if (t instanceof Error) throw (Error) t;
                throw new IOException("Cannot start AI segment muxer", t);
            }
        }

        void write(ByteBuffer sampleBuffer, MediaCodec.BufferInfo sampleInfo, long sourcePtsUs) {
            muxer.writeSampleData(outputTrack, sampleBuffer, sampleInfo);
            if (sampleCount > 0 && sourcePtsUs > lastPtsUs) {
                lastSampleDeltaUs = sourcePtsUs - lastPtsUs;
            }
            lastPtsUs = sourcePtsUs;
            sampleCount++;
            encodedSampleBytes += sampleInfo.size;
        }

        JSONObject finish(long endPtsUs, long sourceFirstPtsUs, long maxBytes) throws Exception {
            if (sampleCount < 1 || muxer == null) {
                throw new AiSegmentException("NO_AUDIO_SAMPLES", "Cannot finalize an empty audio segment");
            }
            MediaMuxer closing = muxer;
            muxer = null;
            try {
                closing.stop();
            } finally {
                closing.release();
            }
            try (RandomAccessFile raf = new RandomAccessFile(partialFile, "rw")) {
                raf.getFD().sync();
            }
            long byteLength = partialFile.length();
            if (byteLength < 1L) {
                throw new AiSegmentException("EMPTY_SEGMENT_FILE", "MediaMuxer produced an empty segment");
            }
            if (byteLength > maxBytes) {
                throw new AiSegmentException("SEGMENT_TOO_LARGE",
                        "Muxed segment exceeds maxBytes: " + byteLength + " > " + maxBytes);
            }
            if (completedFile.exists() && !completedFile.delete()) {
                throw new IOException("Cannot replace AI segment output");
            }
            if (!partialFile.renameTo(completedFile)) {
                throw new IOException("Cannot commit AI segment output");
            }

            long normalizedStartUs = Math.max(0L, startPtsUs - sourceFirstPtsUs);
            long normalizedEndUs = Math.max(normalizedStartUs + 1L, endPtsUs - sourceFirstPtsUs);
            JSONObject segment = new JSONObject();
            segment.put("index", index);
            segment.put("fileName", completedFile.getName());
            segment.put("mimeType", target.mimeType);
            segment.put("byteLength", byteLength);
            segment.put("startMs", normalizedStartUs / 1000L);
            segment.put("endMs", normalizedEndUs / 1000L);
            segment.put("durationMs", Math.max(1L, (endPtsUs - startPtsUs) / 1000L));
            segment.put("url", "/native-ai-segments/" + jobId + "/" + index);
            segment.put("nativeUrl", "/native-ai-segments/" + jobId + "/" + index);
            return segment;
        }

        void abort() {
            if (muxer != null) {
                MediaMuxer closing = muxer;
                muxer = null;
                try { closing.stop(); } catch (Throwable ignored) {}
                try { closing.release(); } catch (Throwable ignored) {}
            }
            deleteTreeQuietly(partialFile);
            deleteTreeQuietly(completedFile);
        }
    }

    /** Converts decoder-native PCM frames to mono and feeds bounded WAV files. */
    private static final class PcmFrameProcessor {
        final int inputSampleRate;
        final int channelCount;
        final int pcmEncoding;
        final int outputSampleRate;
        final int bytesPerChannelSample;
        final int frameBytes;
        final byte[] partialFrame;
        final PcmWavSegmenter segmenter;
        int partialFrameBytes;
        long downsampleAccumulator;
        int downsampleFrames;

        PcmFrameProcessor(File jobDir, String jobId, int inputSampleRate, int channelCount,
                          int pcmEncoding, long maxDurationMs, long maxBytes,
                          long sourceDurationUs) throws AiSegmentException {
            if (inputSampleRate <= 0 || inputSampleRate > 1_000_000) {
                throw new AiSegmentException("INVALID_SAMPLE_RATE",
                        "Unsupported decoder sample rate: " + inputSampleRate);
            }
            if (channelCount < 1 || channelCount > 2) {
                throw new AiSegmentException("UNSUPPORTED_CHANNEL_COUNT",
                        "PCM fallback supports mono or stereo audio only");
            }
            this.inputSampleRate = inputSampleRate;
            this.channelCount = channelCount;
            this.pcmEncoding = pcmEncoding;
            this.outputSampleRate = inputSampleRate == 48_000 ? 16_000 : inputSampleRate;
            this.bytesPerChannelSample = pcmEncoding == AudioFormat.ENCODING_PCM_FLOAT ? 4 : 2;
            this.frameBytes = bytesPerChannelSample * channelCount;
            this.partialFrame = new byte[frameBytes];
            this.segmenter = new PcmWavSegmenter(jobDir, jobId, outputSampleRate,
                    maxDurationMs, maxBytes, sourceDurationUs);
        }

        void requireSameFormat(int sampleRate, int channels, int encoding)
                throws AiSegmentException {
            if (sampleRate != inputSampleRate || channels != channelCount || encoding != pcmEncoding) {
                throw new AiSegmentException("PCM_FORMAT_CHANGED",
                        "Decoder changed PCM format after output began");
            }
        }

        void consume(ByteBuffer pcm) throws AiSegmentException {
            pcm.order(ByteOrder.nativeOrder());
            if (partialFrameBytes > 0) {
                int copy = Math.min(frameBytes - partialFrameBytes, pcm.remaining());
                pcm.get(partialFrame, partialFrameBytes, copy);
                partialFrameBytes += copy;
                if (partialFrameBytes == frameBytes) {
                    processFrame(ByteBuffer.wrap(partialFrame).order(ByteOrder.nativeOrder()));
                    partialFrameBytes = 0;
                }
            }

            int completeBytes = (pcm.remaining() / frameBytes) * frameBytes;
            if (completeBytes > 0) {
                ByteBuffer complete = pcm.slice().order(ByteOrder.nativeOrder());
                complete.limit(completeBytes);
                while (complete.remaining() >= frameBytes) processFrame(complete);
                pcm.position(pcm.position() + completeBytes);
            }
            if (pcm.hasRemaining()) {
                partialFrameBytes = pcm.remaining();
                pcm.get(partialFrame, 0, partialFrameBytes);
            }
        }

        private void processFrame(ByteBuffer frame) throws AiSegmentException {
            short mono;
            if (pcmEncoding == AudioFormat.ENCODING_PCM_FLOAT) {
                float first = frame.getFloat();
                float value = channelCount == 2 ? (first + frame.getFloat()) * 0.5f : first;
                mono = floatToPcm16(value);
            } else {
                int first = frame.getShort();
                int value = channelCount == 2 ? (first + (int) frame.getShort()) / 2 : first;
                mono = (short) value;
            }

            if (inputSampleRate == 48_000) {
                downsampleAccumulator += mono;
                downsampleFrames++;
                if (downsampleFrames == 3) {
                    segmenter.writeSample((short) (downsampleAccumulator / 3L));
                    downsampleAccumulator = 0L;
                    downsampleFrames = 0;
                }
            } else {
                segmenter.writeSample(mono);
            }
        }

        JSONArray finish() throws AiSegmentException {
            if (partialFrameBytes != 0) {
                throw new AiSegmentException("MALFORMED_PCM_FRAME",
                        "Decoder ended in the middle of a PCM frame");
            }
            if (downsampleFrames > 0) {
                segmenter.writeSample((short) (downsampleAccumulator / downsampleFrames));
                downsampleAccumulator = 0L;
                downsampleFrames = 0;
            }
            return segmenter.finish();
        }

        void abort() {
            segmenter.abort();
        }

        private static short floatToPcm16(float sample) {
            if (Float.isNaN(sample)) return 0;
            float clamped = Math.max(-1.0f, Math.min(1.0f, sample));
            int scaled = clamped < 0.0f
                    ? Math.round(clamped * 32768.0f)
                    : Math.round(clamped * 32767.0f);
            return (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, scaled));
        }
    }

    /** Splits a PCM16 mono stream at exact frame boundaries imposed by both limits. */
    private static final class PcmWavSegmenter {
        final File jobDir;
        final String jobId;
        final int sampleRate;
        final long maxFramesPerSegment;
        final long expectedMaxFileBytes;
        final JSONArray segments = new JSONArray();
        WavSegmentWriter writer;
        long totalFrames;
        int segmentIndex;

        PcmWavSegmenter(File jobDir, String jobId, int sampleRate, long maxDurationMs,
                        long maxBytes, long sourceDurationUs) throws AiSegmentException {
            this.jobDir = jobDir;
            this.jobId = jobId;
            this.sampleRate = sampleRate;
            try {
                long durationFrames = Math.multiplyExact((long) sampleRate, maxDurationMs) / 1000L;
                long boundedFileBytes = Math.min(maxBytes, MAX_WAV_DATA_BYTES + WAV_HEADER_BYTES);
                long byteFrames = (boundedFileBytes - WAV_HEADER_BYTES) / 2L;
                this.maxFramesPerSegment = Math.min(durationFrames, byteFrames);
                if (maxFramesPerSegment < 1L) {
                    throw new AiSegmentException("INVALID_BYTE_LIMIT",
                            "AI byte/duration limits cannot hold one WAV frame");
                }
                this.expectedMaxFileBytes = WAV_HEADER_BYTES + maxFramesPerSegment * 2L;

                if (sourceDurationUs > 0L) {
                    long expectedFrames = scaledFramesCeil(sourceDurationUs, sampleRate);
                    long expectedSegments = ceilDiv(expectedFrames, maxFramesPerSegment);
                    if (expectedSegments > MAX_AI_SEGMENTS) {
                        throw new AiSegmentException("TOO_MANY_SEGMENTS",
                                "Decoded recording requires too many WAV segments");
                    }
                    long expectedBytes = Math.addExact(Math.multiplyExact(expectedFrames, 2L),
                            Math.multiplyExact(expectedSegments, (long) WAV_HEADER_BYTES));
                    requireFreeSpace(jobDir, expectedBytes);
                } else {
                    requireFreeSpace(jobDir, expectedMaxFileBytes);
                }
            } catch (ArithmeticException e) {
                throw new AiSegmentException("INVALID_DURATION_LIMIT",
                        "PCM output size exceeds supported limits", false, e);
            }
        }

        void writeSample(short sample) throws AiSegmentException {
            if (writer == null) {
                if (segmentIndex >= MAX_AI_SEGMENTS) {
                    throw new AiSegmentException("TOO_MANY_SEGMENTS",
                            "Decoded recording requires too many WAV segments");
                }
                writer = new WavSegmentWriter(jobDir, jobId, segmentIndex, sampleRate,
                        totalFrames, expectedMaxFileBytes);
            }
            writer.writeSample(sample);
            totalFrames++;
            if (writer.frameCount >= maxFramesPerSegment) commitCurrent();
        }

        JSONArray finish() throws AiSegmentException {
            if (writer != null) commitCurrent();
            if (segments.length() == 0) {
                throw new AiSegmentException("NO_AUDIO_SAMPLES",
                        "The decoder produced no PCM samples");
            }
            return segments;
        }

        private void commitCurrent() throws AiSegmentException {
            WavSegmentWriter committing = writer;
            writer = null;
            segments.put(committing.finish());
            segmentIndex++;
        }

        void abort() {
            if (writer != null) {
                writer.abort();
                writer = null;
            }
        }

        private static long scaledFramesCeil(long durationUs, int sampleRate) {
            long seconds = durationUs / 1_000_000L;
            long remainderUs = durationUs % 1_000_000L;
            long wholeFrames = Math.multiplyExact(seconds, (long) sampleRate);
            long partialFrames = ceilDiv(Math.multiplyExact(remainderUs, (long) sampleRate),
                    1_000_000L);
            return Math.addExact(wholeFrames, partialFrames);
        }
    }

    /** A single unpublished .partial WAV that becomes visible only after header+data fsync. */
    private static final class WavSegmentWriter {
        final String jobId;
        final int index;
        final int sampleRate;
        final long startFrame;
        final File partialFile;
        final File completedFile;
        final byte[] writeBuffer = new byte[WAV_WRITE_BUFFER_BYTES];
        RandomAccessFile output;
        int bufferedBytes;
        long frameCount;

        WavSegmentWriter(File jobDir, String jobId, int index, int sampleRate,
                         long startFrame, long expectedMaxFileBytes)
                throws AiSegmentException {
            this.jobId = jobId;
            this.index = index;
            this.sampleRate = sampleRate;
            this.startFrame = startFrame;
            String baseName = String.format(Locale.US, "segment_%05d", index);
            this.partialFile = new File(jobDir, baseName + ".partial");
            this.completedFile = new File(jobDir, baseName + ".wav");
            try {
                // The segmenter already reserves the complete decoded size when duration is
                // known. For imprecise/absent container durations, reserve one write window and
                // re-check every flush; requiring a full final segment here would incorrectly
                // reject a short tail when exactly enough space remains for it.
                requireFreeSpace(jobDir, Math.min(expectedMaxFileBytes,
                        WAV_HEADER_BYTES + WAV_WRITE_BUFFER_BYTES));
                output = new RandomAccessFile(partialFile, "rw");
                output.setLength(0L);
                output.write(new byte[WAV_HEADER_BYTES]);
            } catch (AiSegmentException e) {
                abort();
                throw e;
            } catch (Throwable t) {
                abort();
                throw new AiSegmentException("WAV_WRITE_FAILED",
                        "Cannot create PCM WAV segment", true, t);
            }
        }

        void writeSample(short sample) throws AiSegmentException {
            if (bufferedBytes + 2 > writeBuffer.length) flushBuffer();
            writeBuffer[bufferedBytes++] = (byte) (sample & 0xff);
            writeBuffer[bufferedBytes++] = (byte) ((sample >>> 8) & 0xff);
            frameCount++;
        }

        JSONObject finish() throws AiSegmentException {
            try {
                if (frameCount < 1L || output == null) {
                    throw new AiSegmentException("NO_AUDIO_SAMPLES",
                            "Cannot finalize an empty WAV segment");
                }
                flushBuffer();
                long dataBytes = Math.multiplyExact(frameCount, 2L);
                if (dataBytes > MAX_WAV_DATA_BYTES) {
                    throw new AiSegmentException("SEGMENT_TOO_LARGE",
                            "PCM data exceeds the WAV RIFF limit");
                }
                output.seek(0L);
                writeWavHeader(output, sampleRate, dataBytes);
                output.setLength(WAV_HEADER_BYTES + dataBytes);
                output.getFD().sync();
                output.close();
                output = null;
                long byteLength = partialFile.length();
                if (byteLength != WAV_HEADER_BYTES + dataBytes) {
                    throw new IOException("WAV length changed before commit");
                }
                if (completedFile.exists() && !completedFile.delete()) {
                    throw new IOException("Cannot replace WAV segment output");
                }
                if (!partialFile.renameTo(completedFile)) {
                    throw new IOException("Cannot atomically commit WAV segment output");
                }

                long startMs = Math.multiplyExact(startFrame, 1000L) / sampleRate;
                long durationMs = ceilDiv(Math.multiplyExact(frameCount, 1000L), sampleRate);
                long endMs = ceilDiv(Math.multiplyExact(startFrame + frameCount, 1000L),
                        sampleRate);
                JSONObject segment = new JSONObject();
                segment.put("index", index);
                segment.put("fileName", completedFile.getName());
                segment.put("mimeType", "audio/wav");
                segment.put("byteLength", byteLength);
                segment.put("startMs", startMs);
                segment.put("endMs", endMs);
                segment.put("durationMs", Math.max(1L, durationMs));
                segment.put("sampleRate", sampleRate);
                segment.put("channelCount", 1);
                segment.put("url", "/native-ai-segments/" + jobId + "/" + index);
                segment.put("nativeUrl", "/native-ai-segments/" + jobId + "/" + index);
                return segment;
            } catch (AiSegmentException e) {
                abort();
                throw e;
            } catch (Throwable t) {
                abort();
                throw new AiSegmentException("WAV_WRITE_FAILED",
                        "Cannot finalize PCM WAV segment", true, t);
            }
        }

        private void flushBuffer() throws AiSegmentException {
            if (bufferedBytes < 1) return;
            try {
                requireFreeSpace(partialFile.getParentFile(), bufferedBytes);
                output.write(writeBuffer, 0, bufferedBytes);
                bufferedBytes = 0;
            } catch (AiSegmentException e) {
                throw e;
            } catch (Throwable t) {
                throw new AiSegmentException("WAV_WRITE_FAILED",
                        "Cannot write PCM WAV data", true, t);
            }
        }

        void abort() {
            if (output != null) {
                try { output.close(); } catch (Throwable ignored) {}
                output = null;
            }
            deleteTreeQuietly(partialFile);
            // A caller only invokes abort on an uncommitted writer. Defensive deletion keeps a
            // failed rename/JSON construction from exposing an orphaned file.
            deleteTreeQuietly(completedFile);
        }

        private static void writeWavHeader(RandomAccessFile output, int sampleRate,
                                           long dataBytes) throws IOException {
            output.writeBytes("RIFF");
            writeLittleEndianInt(output, 36L + dataBytes);
            output.writeBytes("WAVE");
            output.writeBytes("fmt ");
            writeLittleEndianInt(output, 16L);
            writeLittleEndianShort(output, 1); // PCM
            writeLittleEndianShort(output, 1); // mono
            writeLittleEndianInt(output, sampleRate);
            writeLittleEndianInt(output, (long) sampleRate * 2L);
            writeLittleEndianShort(output, 2); // block align
            writeLittleEndianShort(output, 16);
            output.writeBytes("data");
            writeLittleEndianInt(output, dataBytes);
        }

        private static void writeLittleEndianShort(RandomAccessFile output, int value)
                throws IOException {
            output.write(value & 0xff);
            output.write((value >>> 8) & 0xff);
        }

        private static void writeLittleEndianInt(RandomAccessFile output, long value)
                throws IOException {
            output.write((int) (value & 0xff));
            output.write((int) ((value >>> 8) & 0xff));
            output.write((int) ((value >>> 16) & 0xff));
            output.write((int) ((value >>> 24) & 0xff));
        }
    }

    private static long ceilDiv(long numerator, long denominator) {
        if (numerator <= 0L) return 0L;
        return 1L + (numerator - 1L) / denominator;
    }

    private static void requireFreeSpace(File directory, long additionalBytes)
            throws AiSegmentException {
        try {
            long available = new StatFs(directory.getAbsolutePath()).getAvailableBytes();
            if (additionalBytes < 0L || additionalBytes > available - RESERVED_FREE_BYTES) {
                throw new AiSegmentException("NO_SPACE",
                        "Not enough free space for decoded AI audio segments");
            }
        } catch (AiSegmentException e) {
            throw e;
        } catch (Throwable t) {
            throw new AiSegmentException("SPACE_CHECK_FAILED",
                    "Cannot verify free space for AI audio segments", true, t);
        }
    }

    private static final class BoundedInputStream extends FilterInputStream {
        private long remaining;

        BoundedInputStream(InputStream input, long remaining) {
            super(input);
            this.remaining = Math.max(0L, remaining);
        }

        @Override
        public int read() throws IOException {
            if (remaining <= 0L) return -1;
            int value = super.read();
            if (value >= 0) remaining--;
            return value;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            if (remaining <= 0L) return -1;
            int allowed = (int) Math.min((long) length, remaining);
            int count = super.read(buffer, offset, allowed);
            if (count > 0) remaining -= count;
            return count;
        }

        @Override
        public long skip(long count) throws IOException {
            long skipped = super.skip(Math.min(count, remaining));
            remaining -= skipped;
            return skipped;
        }

        @Override
        public int available() throws IOException {
            return (int) Math.min((long) super.available(), Math.min(remaining, Integer.MAX_VALUE));
        }
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        if (!file.delete() && file.exists()) throw new IllegalStateException("Cannot delete " + file);
    }
}
