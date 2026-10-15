package local.nilabot.wechathook;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Properties;

/** Private on-device receipts. One bridge instance owns this directory.
 * Reserve on disk before publishing; an uncertain receipt must never be replayed.
 * Receipts contain a content hash, not message text, and have no session count cap.
 */
final class TextSendLedger {
    private final File directory;

    static final class Receipt {
        final boolean created;
        final String state;
        final String reason;

        Receipt(boolean created, String state, String reason) {
            this.created = created;
            this.state = state;
            this.reason = reason;
        }
    }

    TextSendLedger(File directory) throws IOException {
        this.directory = directory;
        ensureDirectory(directory);
    }

    synchronized Receipt reserve(String id, String chat, String content) throws IOException {
        File file = receiptFile(id);
        if (file.exists()) {
            Properties saved = read(file, chat, content);
            return new Receipt(false, saved.getProperty("state"), saved.getProperty("reason"));
        }
        Properties saved = new Properties();
        saved.setProperty("chat", chat);
        saved.setProperty("content_sha256", hash(content));
        saved.setProperty("state", "uncertain");
        saved.setProperty("reason", "no_server_ack_yet");
        write(file, saved);
        return new Receipt(true, "uncertain", "no_server_ack_yet");
    }

    synchronized void finish(String id, String chat, String content, String state, String reason) throws IOException {
        validateResult(state, reason);
        File file = receiptFile(id);
        Properties saved = read(file, chat, content);
        saved.setProperty("state", state);
        saved.setProperty("reason", reason);
        write(file, saved);
    }

    private File receiptFile(String id) throws IOException {
        if (id == null || !id.matches("[A-Za-z0-9_:.\\-]{8,150}")) {
            throw new IllegalArgumentException("invalid_send_id");
        }
        String key = hash(id);
        File shard = new File(directory, key.substring(0, 2));
        ensureDirectory(shard);
        return new File(shard, key + ".properties");
    }

    private static Properties read(File file, String chat, String content) throws IOException {
        if (!file.isFile() || file.length() < 1 || file.length() > 4096) {
            throw new IOException("invalid_text_receipt");
        }
        Properties saved = new Properties();
        try (InputStream input = new FileInputStream(file)) {
            saved.load(input);
        } catch (IllegalArgumentException error) {
            throw new IOException("invalid_text_receipt", error);
        }
        validateResult(saved.getProperty("state"), saved.getProperty("reason"));
        if (!chat.equals(saved.getProperty("chat")) || !hash(content).equals(saved.getProperty("content_sha256"))) {
            throw new IOException("idempotency_conflict");
        }
        return saved;
    }

    private static void validateResult(String state, String reason) throws IOException {
        if (!("sent".equals(state) || "failed".equals(state) || "uncertain".equals(state))
                || reason == null || !reason.matches("[A-Za-z0-9_]{1,128}")) {
            throw new IOException("invalid_text_receipt");
        }
    }

    private static void write(File file, Properties saved) throws IOException {
        File temporary = File.createTempFile("receipt-", ".tmp", file.getParentFile());
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                saved.store(output, null);
                output.getFD().sync();
            }
            // Android API 26+ and the host tests support atomic replacement.
            Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING);
        } finally {
            temporary.delete();
        }
    }

    private static void ensureDirectory(File directory) throws IOException {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("text_receipt_directory");
    }

    private static String hash(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            char[] hex = "0123456789abcdef".toCharArray();
            StringBuilder result = new StringBuilder(64);
            for (byte b : bytes) result.append(hex[(b & 255) >>> 4]).append(hex[b & 15]);
            return result.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new AssertionError(impossible);
        }
    }
}
