package com.mathreader.boox;

import android.app.Application;
import android.os.Build;
import android.util.Log;

import com.onyx.android.sdk.rx.RxBaseAction;
import com.onyx.android.sdk.utils.ResManager;

import org.lsposed.hiddenapibypass.HiddenApiBypass;

/**
 * 初始化 Onyx SDK 运行环境，流程与官方 OnyxPenDemo 的 DemoApplication 一致。
 * 在非 Boox 设备上初始化失败时静默降级为普通 WebView 应用。
 */
public class MainApp extends Application {
    private static final String TAG = "MainApp";

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            ResManager.init(this);
            RxBaseAction.init(this);
        } catch (Throwable t) {
            Log.w(TAG, "Onyx SDK init failed (non-Boox device?)", t);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                HiddenApiBypass.addHiddenApiExemptions("");
            } catch (Throwable t) {
                Log.w(TAG, "HiddenApiBypass failed", t);
            }
        }
    }
}
