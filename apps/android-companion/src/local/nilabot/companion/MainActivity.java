package local.nilabot.companion;

import android.app.Activity;
import android.os.Bundle;
import android.content.Intent;
import android.provider.Settings;
import android.widget.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

public class MainActivity extends Activity {
    private TextView status;
    public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(32, 48, 32, 32);
        TextView title = new TextView(this);
        title.setText("Nila 群聊桥接 · 能力诊断");
        title.setTextSize(24);
        box.addView(title);
        TextView info = new TextView(this);
        info.setText("通过 Android 通知接口检查微信是否提供群消息正文和直接回复能力。此版本不发送消息，也不联网。仅在本机保存两个已授权群的通知诊断，其他应用通知直接忽略。\n\n请保持微信在后台，再从另一个账号发送群测试消息。\n");
        box.addView(info);
        Button permission = new Button(this);
        permission.setText("打开通知使用权设置");
        permission.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)));
        box.addView(permission);
        Button refresh = new Button(this);
        refresh.setText("刷新诊断");
        refresh.setOnClickListener(v -> refresh());
        box.addView(refresh);
        status = new TextView(this);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(status);
        box.addView(scroll);
        setContentView(box);
    }
    public void onResume() { super.onResume(); refresh(); }
    private void refresh() {
        try { status.setText(new String(Files.readAllBytes(getFileStreamPath("probe.json").toPath()), StandardCharsets.UTF_8)); }
        catch (Exception e) { status.setText("尚无通知数据。请开启通知使用权并发送测试消息。"); }
    }
}
