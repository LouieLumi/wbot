package local.nilabot.companion;

import android.accessibilityservice.AccessibilityService;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import org.json.*;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Read-only structural probe. No screenshots, chat text storage, clicks, or typing. */
public class WeChatAccessibility extends AccessibilityService {
    private long last = 0;
    public void onInterrupt() {}
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (System.currentTimeMillis() - last < 500) return;
        last = System.currentTimeMillis();
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return;
        if (!"com.tencent.mm".contentEquals(root.getPackageName() == null ? "" : root.getPackageName())) { root.recycle(); return; }
        int count = 0, text = 0, editable = 0, clickable = 0;
        TreeSet<String> ids = new TreeSet<>();
        ArrayDeque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        queue.add(root);
        while (!queue.isEmpty() && count < 2000) {
            AccessibilityNodeInfo n = queue.remove(); count++;
            if (n.getText() != null && n.getText().length() > 0) text++;
            if (n.isEditable()) editable++;
            if (n.isClickable()) clickable++;
            if (n.getViewIdResourceName() != null) ids.add(n.getViewIdResourceName());
            for (int i = 0; i < n.getChildCount(); i++) {
                AccessibilityNodeInfo child = n.getChild(i);
                if (child != null) queue.add(child);
            }
            n.recycle();
        }
        for (AccessibilityNodeInfo n : queue) n.recycle();
        try (FileOutputStream output = openFileOutput("accessibility-probe.json", MODE_PRIVATE)) {
            output.write(new JSONObject().put("at", last).put("node_count", count).put("text_nodes", text)
                .put("editable_nodes", editable).put("clickable_nodes", clickable).put("resource_ids", new JSONArray(ids))
                .toString(2).getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {}
    }
}
