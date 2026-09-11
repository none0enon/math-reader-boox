import com.mathreader.boox.RawDataBackup;
import java.io.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.zip.*;

public class RawDataBackupCheck {
    private static byte[] hash(InputStream in) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[64 * 1024];
        int count;
        while ((count = in.read(buffer)) != -1) digest.update(buffer, 0, count);
        return digest.digest();
    }
    public static void main(String[] args) throws Exception {
        Path tmp = Files.createTempDirectory("raw-data-check-");
        try {
            Path root = Files.createDirectories(tmp.resolve("private"));
            Path db = Files.createDirectories(root.resolve("app_webview/Default/IndexedDB"));
            Files.writeString(db.resolve("CURRENT"), "MANIFEST-000001\n");
            Files.writeString(db.resolve("MANIFEST-000001"), "raw database manifest");
            Files.writeString(Files.createDirectories(root.resolve("shared_prefs")).resolve("设置.xml"), "本地设置");
            Files.writeString(Files.createDirectories(root.resolve("cache")).resolve("recoverable"), "preserved");
            Files.createDirectories(root.resolve("lib"));
            Files.writeString(root.resolve("lib/generated"), "not user data");
            Path recording = Files.createDirectories(root.resolve("no_backup/recordings/id")).resolve("data.bin");
            try (OutputStream out = Files.newOutputStream(recording)) {
                byte[] chunk = new byte[128 * 1024];
                new Random(3).nextBytes(chunk);
                for (int i = 0; i < 512; i++) out.write(chunk);
            }
            Path zipPath = tmp.resolve("snapshot.zip");
            long[] totals;
            try (OutputStream out = Files.newOutputStream(zipPath)) {
                totals = RawDataBackup.write(root, out, (files, bytes) -> {});
            }
            assert totals[0] == 5 && totals[1] > 64L * 1024 * 1024 && totals[2] == 0;
            int entries = 0;
            try (ZipInputStream zip = new ZipInputStream(Files.newInputStream(zipPath))) {
                ZipEntry entry;
                while ((entry = zip.getNextEntry()) != null) {
                    entries++;
                    if (entry.getName().startsWith("private/")) {
                        try (InputStream in = Files.newInputStream(root.resolve(entry.getName().substring(8)))) {
                            assert Arrays.equals(hash(in), hash(zip)) : entry.getName();
                        }
                    } else {
                        assert entry.getName().equals("recovery-info.txt");
                        assert new String(zip.readAllBytes()).contains("errors=0");
                    }
                    zip.closeEntry();
                }
            }
            assert entries == 6;
            assert Files.readString(db.resolve("CURRENT")).equals("MANIFEST-000001\n");
            Files.createSymbolicLink(root.resolve("outside"), tmp);
            long[] partial = RawDataBackup.write(root, OutputStream.nullOutputStream(), (files, bytes) -> {});
            assert partial[2] == 1 : "special sources must be explicitly reported";
            boolean failed = false;
            try {
                RawDataBackup.write(root, new OutputStream() {
                    public void write(int value) throws IOException { throw new IOException("disk full"); }
                }, (files, bytes) -> {});
            } catch (IOException expected) { failed = true; }
            assert failed : "destination failure must never report success";
            System.out.println("Raw recovery: 64 MiB source under 32 MiB heap, source hashes, CRC, error reporting and write failures passed");
        } finally {
            try (var paths = Files.walk(tmp)) {
                for (Path p : paths.sorted(Comparator.reverseOrder()).toArray(Path[]::new)) Files.delete(p);
            }
        }
    }
}
