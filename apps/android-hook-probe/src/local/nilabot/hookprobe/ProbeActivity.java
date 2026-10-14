package local.nilabot.hookprobe;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.widget.TextView;
import org.json.JSONObject;
import java.io.FileOutputStream;

public final class ProbeActivity extends Activity {
    // Deliberately invoked through reflection to avoid compile-time inlining.
    public static String hookTarget() { return "original"; }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        TextView view = new TextView(this);
        view.setPadding(40, 60, 40, 40);
        try {
            String value = (String) ProbeActivity.class.getDeclaredMethod("hookTarget").invoke(null);
            JSONObject result = new JSONObject().put("test", "local_method_hook")
                .put("value", value).put("passed", "hooked-by-nila".equals(value))
                .put("timestamp_ms", System.currentTimeMillis());
            try (FileOutputStream out = openFileOutput("result.json", MODE_PRIVATE)) {
                out.write(result.toString().getBytes("UTF-8"));
            }
            Log.i("NilaHookProbe", result.toString());
            view.setText("Nila 免 Root 模块测试\n\n" + ("hooked-by-nila".equals(value) ? "模块加载及方法 Hook 成功" : "原始 App，尚未加载模块")
                + "\n\n此测试不访问微信、不联网、不读取聊天。");
        } catch (Throwable error) {
            Log.e("NilaHookProbe", "probe_failed:" + error.getClass().getSimpleName());
            view.setText("测试失败：" + error.getClass().getSimpleName());
        }
        setContentView(view);
    }
}
