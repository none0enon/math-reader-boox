package com.mathreader.boox;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BiConsumer;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Cold-start copy: never opens a database or loads WebView. */
public final class RawDataBackup {
    private RawDataBackup() {}

    public static long[] write(Path root, OutputStream output,
                               BiConsumer<Long, Long> progress) throws IOException {
        if (!Files.isDirectory(root.resolve("app_webview"))) {
            throw new IOException("没有找到本机 WebView 数据，已停止导出");
        }
        long[] totals = {0, 0, 0};
        List<String> errors = new ArrayList<>();
        byte[] buffer = new byte[128 * 1024];
        try (ZipOutputStream zip = new ZipOutputStream(output)) {
            // Streaming level 0 supports unknown sizes and ZIP64 without rereading sources.
            zip.setLevel(0);
            Files.walkFileTree(root, new SimpleFileVisitor<Path>() {
                @Override
                public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                    return root.relativize(dir).toString().equals("lib")
                            ? FileVisitResult.SKIP_SUBTREE : FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes before) throws IOException {
                    String relative = root.relativize(file).toString();
                    if (relative.equals("lib")) return FileVisitResult.CONTINUE;
                    if (!before.isRegularFile()) {
                        errors.add(relative + ": 非普通文件，未跟随链接");
                        return FileVisitResult.CONTINUE;
                    }
                    InputStream input;
                    try { input = Files.newInputStream(file); }
                    catch (IOException e) {
                        errors.add(relative + ": " + e);
                        return FileVisitResult.CONTINUE;
                    }
                    long copied = 0;
                    try {
                        ZipEntry entry = new ZipEntry("private/" + relative.replace('\\', '/'));
                        entry.setTime(before.lastModifiedTime().toMillis());
                        zip.putNextEntry(entry);
                        while (true) {
                            int count;
                            try { count = input.read(buffer); }
                            catch (IOException e) { errors.add(relative + ": " + e); break; }
                            if (count == -1) break;
                            zip.write(buffer, 0, count);
                            copied += count;
                            totals[1] += count;
                            progress.accept(totals[0], totals[1]);
                        }
                        zip.closeEntry();
                    } finally {
                        try { input.close(); }
                        catch (IOException e) { errors.add(relative + ": " + e); }
                    }
                    try {
                        BasicFileAttributes after = Files.readAttributes(file, BasicFileAttributes.class);
                        if (copied != before.size() || copied != after.size() ||
                                !before.lastModifiedTime().equals(after.lastModifiedTime())) {
                            errors.add(relative + ": 复制期间文件变化或未读完整，已复制 " + copied + "/" + before.size());
                        }
                    } catch (IOException e) { errors.add(relative + ": " + e); }
                    totals[0]++;
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFileFailed(Path file, IOException error) {
                    errors.add(root.relativize(file) + ": " + error);
                    return FileVisitResult.CONTINUE;
                }
            });
            if (totals[0] == 0) throw new IOException("没有读到本机文件");
            zip.putNextEntry(new ZipEntry("recovery-info.txt"));
            String info = "format=math-reader-raw-local-v1\nfiles=" + totals[0] + "\nbytes=" + totals[1]
                    + "\nerrors=" + errors.size()
                    + "\nRaw private files for recovery; not a normal in-app import ZIP.\n"
                    + "Excluded installed native library directory: lib.\n";
            zip.write(info.getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
            if (!errors.isEmpty()) {
                zip.putNextEntry(new ZipEntry("recovery-errors.txt"));
                zip.write(String.join("\n", errors).getBytes(StandardCharsets.UTF_8));
                zip.closeEntry();
            }
            totals[2] = errors.size();
        }
        return totals;
    }
}
