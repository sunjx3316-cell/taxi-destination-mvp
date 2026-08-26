package com.daonaer.destination;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.content.pm.PackageManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Opens a map URI through Android instead of inside the in-app WebView. */
@CapacitorPlugin(name = "Navigation")
public class NavigationPlugin extends Plugin {
    private boolean isPackageInstalled(String packageName) {
        try {
            getContext().getPackageManager().getApplicationInfo(packageName, 0);
            return true;
        } catch (PackageManager.NameNotFoundException error) {
            return false;
        }
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        String packageName = call.getString("packageName");
        String appName = call.getString("appName", "导航应用");
        if (url == null || url.isEmpty()) {
            call.reject("Missing destination URL");
            return;
        }
        // Check the Android package before creating an Intent. In particular, this
        // prevents Harmony's Android compatibility layer from opening AppGallery search.
        if (packageName != null && !packageName.isEmpty() && !isPackageInstalled(packageName)) {
            call.reject("未检测到 Android 版" + appName + "。不会跳转到应用市场，请选择已安装的地图。", "APP_NOT_INSTALLED");
            return;
        }
        if (getActivity() == null) {
            call.reject("当前页面无法打开导航应用。");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                intent.addCategory(Intent.CATEGORY_DEFAULT);
                // Explicit package prevents Android/Harmony from routing a map URI through a browser.
                if (packageName != null && !packageName.isEmpty()) intent.setPackage(packageName);
                getActivity().startActivity(intent);
                call.resolve();
            } catch (ActivityNotFoundException error) {
                call.reject(appName + "未安装，或当前版本不支持直接导航。请安装后重试，或选择其他地图。", "APP_NOT_AVAILABLE");
            }
        });
    }
}
