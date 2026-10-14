package local.nilabot.companion;

import android.app.Notification;
import android.app.RemoteInput;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import org.json.*;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Capability probe only: no networking, PendingIntent execution, or automatic replies. */
public class WeChatNotifications extends NotificationListenerService {
    private final JSONArray recent = new JSONArray();
    private int observed = 0;
    private boolean connected = false;
    // Diagnostic only: explicitly configure test group names before building.
    private static final String[] GROUPS = {};

    public void onListenerConnected() {
        connected = true;
        save();
        StatusBarNotification[] active = getActiveNotifications();
        if (active != null) for (StatusBarNotification sbn : active) record(sbn, true);
    }
    public void onListenerDisconnected() { connected = false; save(); }
    public void onNotificationPosted(StatusBarNotification sbn) { record(sbn, false); }
    private boolean authorized(String title) {
        for (String group : GROUPS) if (title.equals(group) || title.matches(java.util.regex.Pattern.quote(group) + "[（(]\\d+[)）]")) return true;
        return false;
    }
    private JSONArray actions(Notification.Action[] actions) throws JSONException {
        JSONArray result = new JSONArray();
        if (actions == null) return result;
        for (Notification.Action a : actions) {
            JSONArray inputs = new JSONArray();
            if (a.getRemoteInputs() != null) for (RemoteInput input : a.getRemoteInputs()) {
                inputs.put(new JSONObject().put("key", input.getResultKey()).put("free_form", input.getAllowFreeFormInput()));
            }
            result.put(new JSONObject().put("title", String.valueOf(a.title)).put("remote_inputs", inputs).put("has_intent", a.actionIntent != null));
        }
        return result;
    }
    private void record(StatusBarNotification sbn, boolean existing) {
        if (!"com.tencent.mm".equals(sbn.getPackageName())) return;
        observed++;
        try {
            Notification n = sbn.getNotification();
            Bundle e = n.extras;
            String title = String.valueOf(e.getCharSequence(Notification.EXTRA_TITLE, ""));
            boolean allowed = authorized(title);
            // Notification bodies outside the two authorized groups are never persisted.
            JSONObject event = new JSONObject().put("at", sbn.getPostTime()).put("existing", existing)
                .put("allowed_group", allowed).put("actions", actions(n.actions))
                .put("wearable_actions", actions(new Notification.WearableExtender(n).getActions().toArray(new Notification.Action[0])))
                .put("has_content_intent", n.contentIntent != null)
                .put("summary", (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0)
                .put("extra_keys", new JSONArray(new TreeSet<String>(e.keySet())));
            if (allowed) {
                event.put("title", title).put("text", String.valueOf(e.getCharSequence(Notification.EXTRA_TEXT, "")))
                    .put("big_text", String.valueOf(e.getCharSequence(Notification.EXTRA_BIG_TEXT, "")));
                JSONArray lines = new JSONArray();
                CharSequence[] raw = e.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
                if (raw != null) for (CharSequence line : raw) lines.put(String.valueOf(line));
                event.put("lines", lines);
            }
            if (recent.length() >= 30) recent.remove(0);
            recent.put(event);
        } catch (Exception ignored) { /* No raw chat data in logs. */ }
        save();
    }
    private void save() {
        try (FileOutputStream output = openFileOutput("probe.json", MODE_PRIVATE)) {
            output.write(new JSONObject().put("notification_listener_connected", connected).put("wechat_notifications_observed", observed)
                .put("mode", "diagnostic_only_no_sends").put("recent", recent).toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {}
    }
}
