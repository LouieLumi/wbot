package local.nilabot.wechathook;

import android.app.Application;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.app.AndroidAppHelper;
import de.robv.android.xposed.IXposedHookLoadPackage;
import de.robv.android.xposed.IXposedHookZygoteInit;
import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XC_MethodReplacement;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage;
import org.json.JSONObject;
import java.lang.reflect.Field;

/** Version-gated entry point for the authenticated, allowlisted local text bridge. */
public final class HookEntry implements IXposedHookLoadPackage, IXposedHookZygoteInit {
    private static volatile boolean inspected = false;
    private static String modulePath;
    @Override public void initZygote(StartupParam startup) { modulePath = startup.modulePath; }
    @Override public void handleLoadPackage(final XC_LoadPackage.LoadPackageParam load) throws Throwable {
        if ("local.nilabot.hookprobe".equals(load.packageName)) {
            XposedHelpers.findAndHookMethod("local.nilabot.hookprobe.ProbeActivity", load.classLoader,
                "hookTarget", XC_MethodReplacement.returnConstant("hooked-by-nila"));
            return;
        }
        if (!"com.tencent.mm".equals(load.packageName) || !"com.tencent.mm".equals(load.processName)) return;
        Log.i("NilaWeChatHook", "module_loaded_version_check_pending");
        XposedHelpers.findAndHookMethod(Application.class, "attach", Context.class, new XC_MethodHook() {
            @Override protected void afterHookedMethod(MethodHookParam param) {
                Context context = (Context) param.args[0];
                inspect(context, context.getClassLoader());
            }
        });
        // LSPatch may notify a module after Application.attach has already run.
        // Retry read-only reflection on the main looper once the application exists.
        final Handler handler = new Handler(Looper.getMainLooper());
        handler.postDelayed(new Runnable() {
            private int attempts = 0;
            @Override public void run() {
                if (inspected) return;
                Application application = AndroidAppHelper.currentApplication();
                if (application != null) inspect(application, application.getClassLoader());
                if (!inspected && ++attempts < 15) handler.postDelayed(this, 2000);
                else if (!inspected) Log.w("NilaWeChatHook", "structure_check_not_completed_after_startup");
            }
        }, 1000);
    }

    private static void inspect(Context context, ClassLoader loader) {
        if (inspected) return;
        String stage = "version";
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            if (!"8.0.79".equals(info.versionName) || info.getLongVersionCode() != 3200L) {
                Log.w("NilaWeChatHook", "unsupported_version_diagnostic_stopped");
                return;
            }
            stage = "wcdb_class";
            Class<?> database = Class.forName("com.tencent.wcdb.database.SQLiteDatabase", false, loader);
            stage = "wcdb_method";
            database.getDeclaredMethod("insertWithOnConflict", String.class, String.class, ContentValues.class, int.class);
            stage = "send_event";
            Class<?> event = Class.forName("com.tencent.mm.autogen.events.SendMsgEvent", false, loader);
            Field payload = event.getDeclaredField("g");
            Class<?> args = payload.getType();
            boolean shape = args.getDeclaredField("a").getType() == String.class
                && args.getDeclaredField("b").getType() == String.class
                && args.getDeclaredField("c").getType() == int.class
                && args.getDeclaredField("d").getType() == int.class
                && event.getMethod("e").getReturnType() == boolean.class;
            // Reflection checks only: neither constructs nor publishes an event.
            Log.i("NilaWeChatHook", new JSONObject().put("phase", "structure_check_before_transport")
                .put("version", info.versionName).put("wcdb_insert_present", true)
                .put("send_event_shape_matches", shape).put("capture_enabled", false)
                .put("send_enabled", false).toString());
            inspected = true;
            if (shape) LocalBridge.start(context, loader, database, modulePath);
        } catch (Throwable error) {
            Log.w("NilaWeChatHook", "structure_check_failed:" + stage + ":" + error.getClass().getSimpleName());
        }
    }
}
