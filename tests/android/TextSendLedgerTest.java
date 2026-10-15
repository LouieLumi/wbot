package local.nilabot.wechathook;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;

public final class TextSendLedgerTest {
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static void rejected(Checked action) throws Exception {
        try { action.run(); } catch (IOException expected) { return; }
        throw new AssertionError("Expected receipt operation to fail closed");
    }

    interface Checked { void run() throws Exception; }

    public static void main(String[] args) throws Exception {
        Path root = new File(args[0]).toPath();
        File directory = root.resolve("receipts").toFile();
        TextSendLedger ledger = new TextSendLedger(directory);
        for (int i = 0; i < 250; i++) {
            String id = "message:" + i;
            check(ledger.reserve(id, "group-a", "你好" + i).created, "Send beyond 100 must be accepted");
            ledger.finish(id, "group-a", "你好" + i, "sent", "wechat_server_ack");
        }
        TextSendLedger.Receipt oldest = ledger.reserve("message:0", "group-a", "你好0");
        check(!oldest.created && "sent".equals(oldest.state), "Old receipts must not be evicted");
        System.out.println("PASS 250 sends and earliest receipt retained");

        ledger.reserve("interrupted:1", "group-a", "pending");
        ledger.reserve("failed:01", "group-a", "failed");
        ledger.finish("failed:01", "group-a", "failed", "failed", "wechat_send_failed");
        TextSendLedger restarted = new TextSendLedger(directory);
        check(!restarted.reserve("message:0", "group-a", "你好0").created, "Restart must retain sent receipt");
        TextSendLedger.Receipt pending = restarted.reserve("interrupted:1", "group-a", "pending");
        check(!pending.created && "uncertain".equals(pending.state), "Interrupted send must not replay");
        check(!restarted.reserve("failed:01", "group-a", "failed").created, "Failed send must not replay");
        System.out.println("PASS restart preserves sent, uncertain and failed receipts");

        rejected(() -> restarted.reserve("message:0", "group-b", "你好0"));
        rejected(() -> restarted.reserve("message:0", "group-a", "different"));
        rejected(() -> restarted.finish("message:0", "group-b", "你好0", "sent", "wechat_server_ack"));
        System.out.println("PASS IDs are bound to group and content");

        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            List<Future<Boolean>> attempts = new ArrayList<>();
            for (int i = 0; i < 30; i++) attempts.add(pool.submit(() -> restarted.reserve("concurrent:1", "group-a", "once").created));
            int created = 0;
            for (Future<Boolean> attempt : attempts) if (attempt.get()) created++;
            check(created == 1, "Concurrent requests must reserve once");
        } finally { pool.shutdownNow(); }
        System.out.println("PASS concurrent duplicate requests reserve once");

        File broken = root.resolve("broken").toFile();
        TextSendLedger corrupt = new TextSendLedger(broken);
        corrupt.reserve("corrupt:1", "group-a", "private message");
        Path receipt;
        try (java.util.stream.Stream<Path> paths = Files.walk(broken.toPath())) {
            receipt = paths.filter(p -> p.toString().endsWith(".properties")).findFirst().get();
        }
        check(!new String(Files.readAllBytes(receipt), StandardCharsets.UTF_8).contains("private message"), "Do not persist plaintext");
        Files.write(receipt, "state=sent\n".getBytes(StandardCharsets.UTF_8));
        rejected(() -> corrupt.reserve("corrupt:1", "group-a", "private message"));
        System.out.println("PASS corrupt receipt fails closed; no message plaintext");

        File unwritable = root.resolve("unwritable").toFile();
        TextSendLedger unavailable = new TextSendLedger(unwritable);
        check(unwritable.delete(), "Remove empty test directory");
        Files.write(unwritable.toPath(), new byte[]{1});
        rejected(() -> unavailable.reserve("storage:1", "group-a", "never publish"));
        System.out.println("PASS storage failure prevents reservation");

        File finishFailure = root.resolve("finish-failure").toFile();
        TextSendLedger updating = new TextSendLedger(finishFailure);
        updating.reserve("finish:01", "group-a", "pending");
        rejected(() -> updating.finish("finish:01", "group-a", "pending", "invalid", "bad_result"));
        check(!new TextSendLedger(finishFailure).reserve("finish:01", "group-a", "pending").created,
                "Failed update must leave the original reservation");
        System.out.println("PASS failed update retains reservation");
    }
}
