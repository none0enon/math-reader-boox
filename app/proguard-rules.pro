# 保留 Onyx SDK
-keep class com.onyx.** { *; }
-dontwarn com.onyx.**

# JS 桥接接口
-keepclassmembers class com.mathreader.boox.BooxPenBridge { @android.webkit.JavascriptInterface <methods>; }
-keepclassmembers class com.mathreader.boox.DownloadBridge { @android.webkit.JavascriptInterface <methods>; }
