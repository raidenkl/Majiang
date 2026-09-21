# 電脳麻将 · Android 版（手写 WebView 壳）

把 Web 端（仓库根的 `dist/`）包成一个 APK。**没有第三方依赖**（不用 Capacitor / Cordova /
AndroidX），只有一个 Activity + 一个 WebView + 一个内置启动页。

## 两个入口

| 入口 | 行为 | 资源来源 |
|---|---|---|
| 单机对局 | `file:///android_asset/www/index.html` | APK 内置（`dist/` 被打进 `assets/www`）→ **完全离线** |
| 局域网联机 | 顶层导航到 `http://<主机IP>:8080/` | 主机（同一 WiFi 上的 PC 跑 `電脳麻将.exe`） |

## 为什么联机是"导航过去"，而不是本地资源直接请求主机

服务端 socket 握手依赖 session cookie —— `server/index.js` 里：

```js
const suser = sock.request.session && sock.request.session.user;
if (! suser) { sock.emit('HELLO', null); return; }
```

而这个 cookie 是 `sameSite: 'lax'`。局域网是**纯 HTTP**，于是：

- 「本地资源 + 跨站请求主机」→ 跨站请求不带 Lax cookie → 服务端直接回 `HELLO null` → 联机不可用；
- 想让跨站带上 cookie 只能改 `SameSite=None`，而 `None` **强制要求 `Secure`** → 必须 HTTPS；
  给局域网主机配 HTTPS，就意味着每台手机都要装自签根证书，不可接受。

**顶层导航之后 origin 就是主机本身**，登录、socket.io、302 跳转、断线重连全部按原样工作，
Web 端和服务端一行都不用改。

## 为什么本地资源用 `file://` 而不是 `WebViewAssetLoader`

`WebViewAssetLoader` 靠 `shouldInterceptRequest` 提供资源，而 Chromium 的 `<audio>` 请求
不一定走该回调 —— 那会导致役种语音全部不出声。`file://` 交给系统 WebView 自己加载，最稳。

## 本地构建

需要 JDK 17 + Android SDK（`ANDROID_HOME` / `ANDROID_SDK_ROOT`），或者直接装 Android Studio。

```sh
# 1) 先在仓库根目录生成 Web 产物（dist/ 未入库）
npm install
npm run build

# 2) 出 APK
cd android
./gradlew assembleDebug          # → app/build/outputs/apk/debug/app-debug.apk
```

`app/build.gradle` 里有一个 `copyWebAssets` 任务，会把仓库根的 `dist/` 复制到
`app/src/main/assets/www/`（该目录已 gitignore）。`dist/` 不存在时会直接报错提示你先 build。

`adb install -r app/build/outputs/apk/debug/app-debug.apk` 即可装到手机。

## CI

`.github/workflows/build-apk.yml`：`develop` / `master` 有推送就出包，
`v*` tag 会把 `Majiang-android.apk` 追加到该 tag 的 Release 上。

出包步骤是 `./gradlew assembleRelease`，**默认用仓库里的固定密钥签名**
（`android/signing/majiang-release.p12`，见该目录的 README），
所以**每次构建签名一致，用户可以正常覆盖安装**。

如果你在仓库 secrets 里配了
`ANDROID_KEYSTORE_BASE64` / `ANDROID_STORE_PASSWORD` / `ANDROID_KEY_ALIAS` /
`ANDROID_KEY_PASSWORD`，CI 会优先用你的密钥。

出包后会跑 `apksigner verify --print-certs` 并把它打到 run 的 annotation 上，
方便核对签名是否还是同一把。

## 已知限制

- **版本号**取自仓库根 `package.json`（`versionCode = x*10000 + y*100 + z`），
  所以只能往上走，不能回退版本号重发。
- **签名**：用的是仓库里那把**公开的开发密钥**（`android/signing/majiang-release.p12`），
  好处是任何一次构建签名都一样、能覆盖安装；代价是私钥公开，
  **不要拿它上架应用商店**。要换成自己的密钥见 `android/signing/README.md`。
  注意：从旧的 debug 签名包换过来时，**需要先卸载一次**。
- **IPv6 不支持**：主机的邀请地址一直是 IPv4（见 `server/index.js` 的 `lan_ip()`）。
- **主机不能是手机**：Android 上跑不了 Node，所以"开房间当主机"必须由 PC 上的
  `電脳麻将.exe`（或任何跑着 `server/` 的机器）来做。
- `androidScheme` / 混合内容之类的问题都不存在 —— 我们没用 Capacitor，
  WebView 只做两件事：加载本地文件、顶层导航到主机。
