package com.raidenkl.majiang;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 *  電脳麻将 Android 壳 —— 手写 WebView，零第三方依赖。
 *
 *  两个入口都由内置的 assets/launcher.html 提供：
 *    1. 单机对局    → file:///android_asset/www/index.html   （完全离线）
 *    2. 局域网联机  → http://<主机IP>:8080/                  （顶层导航过去）
 *
 *  为什么联机必须「顶层导航」而不是「本地资源直接请求主机」：
 *  服务端 socket 握手依赖 session cookie
 *  （server/index.js: `sock.request.session.user`，没有就直接回 HELLO null），
 *  而该 cookie 是 SameSite=Lax —— 本地资源跨站请求主机时浏览器不会带上它。
 *  想让跨站带上 cookie 只能改 SameSite=None，而 None 强制要求 Secure，
 *  局域网又是纯 HTTP（给主机配证书得让每台手机装根证书，不可接受）。
 *  导航过去之后 origin 就是主机本身，登录 / socket.io / 302 跳转 / 断线重连
 *  全部按原样工作，Web 端与服务端都不需要改。
 *
 *  为什么本地资源用 file:// 而不是 androidx 的 WebViewAssetLoader：
 *  后者需要靠 shouldInterceptRequest 提供资源，而 Chromium 的 <audio> 请求
 *  不一定走该回调，会导致役种语音不出声。file:// 直接交给系统 WebView 的内存
 *  文件加载，最稳。（音频是本项目的重点，不能冒险。）
 */
public class MainActivity extends Activity {

    private static final String LAUNCHER = "file:///android_asset/launcher.html";

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        web = new WebView(this);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                     // localStorage：音效开关、上次的主机地址
        s.setMediaPlaybackRequiresUserGesture(false);     // 役种语音需要无手势也能出声
        s.setUseWideViewPort(true);                       // 页面用 <meta viewport content="width=800">
        s.setLoadWithOverviewMode(true);                  // 配合上面，把 800px 画布缩放到屏幕
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setAllowFileAccess(true);                       // 本地资源是 file:///android_asset/
        s.setAllowContentAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setBackgroundColor(0xFF000000);               // 与棋盘底色一致，避免闪白
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            /** 主文档加载失败（多半是主机地址写错 / 主机没开局域网）→ 提示并退回启动页 */
            @Override
            public void onReceivedError(WebView v, WebResourceRequest req,
                                        WebResourceError err) {
                if (! req.isForMainFrame()) return;
                if (req.getUrl().toString().startsWith("file://")) return;
                Toast.makeText(MainActivity.this,
                        "连不上主机：" + err.getDescription()
                                + "\n请检查地址，以及主机是否已开启「局域网联机」",
                        Toast.LENGTH_LONG).show();
                v.postDelayed(() -> v.loadUrl(LAUNCHER), 1200);
            }
        });

        /* 启动页用它读写「上次的主机地址」（file:// 下拿 SharedPreferences 更可靠） */
        web.addJavascriptInterface(new HostStore(this), "MajiangHost");

        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        if (saved == null) web.loadUrl(LAUNCHER);
        else               web.restoreState(saved);       // 切到后台再回来保留当前页面
    }

    /** 全屏主题下仍会被系统栏遮挡，重新获得焦点时再隐藏一次 */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (! hasFocus) return;
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    /** 返回键：能回退就回退，否则回启动页；已经在启动页就退出 */
    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
            return;
        }
        String url = web.getUrl();
        if (url != null && ! url.startsWith(LAUNCHER)) {
            web.loadUrl(LAUNCHER);
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /** 给启动页用的主机地址存储 */
    public static class HostStore {

        private final SharedPreferences pref;

        HostStore(Context c) {
            pref = c.getSharedPreferences("majiang", Context.MODE_PRIVATE);
        }

        @JavascriptInterface
        public String getHost() {
            return pref.getString("host", "");
        }

        @JavascriptInterface
        public void setHost(String host) {
            pref.edit().putString("host", host == null ? "" : host).apply();
        }
    }
}
