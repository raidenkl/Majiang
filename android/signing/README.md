# 签名密钥（请先读这一段）

这个目录里的 `majiang-release.p12` 是**故意提交进仓库的**一把固定签名密钥。

| 项 | 值 |
|---|---|
| 文件 | `majiang-release.p12`（PKCS#12，RSA 2048，自签，30 年有效期） |
| storeType | `PKCS12` |
| alias | `majiang` |
| storePassword / keyPassword | `majiang-release` |

## 为什么放仓库里

签名必须**每次构建都一样**，否则用户装新版要先卸载（Android 不允许同包名换签名覆盖安装）。而：

- **CI runner 每次都是全新的**，AGP 自动生成的 debug 密钥每次都不同 → 签名必然变化；
- **开发机没有 JDK / Android Studio**（`keytool` 都没有），没法离线生成一把再存起来；
- 用 GitHub Secrets 存密钥当然更规范，但那需要你自己先生成密钥再加上去。

所以先用一把"公开的开发密钥"把「覆盖安装」这件事做通：任何人 clone 下来都能复现同一个签名。

## 代价（务必知道）

- **这把私钥是公开的**。任何拿到仓库的人都能用同名包发布"更新"。
  → **绝对不要用它上架 Google Play / 国内应用商店**；仅适合自己和小范围局域网传播的安装包。
- 反过来，对局域网自用来说这个风险可忽略：更新本来就只从你自己的 Release 取。

## 想换成自己的密钥（推荐长期这么做）

1. 在有 JDK 的机器上生成（或用 Android Studio 的 *Generate Signed Bundle / APK*）：

   ```sh
   keytool -genkeypair -v -keystore my-release.p12 -storetype PKCS12 \
     -alias mykey -keyalg RSA -keysize 2048 -validity 10950
   ```

2. 在仓库 **Settings → Secrets and variables → Actions** 加 4 个 secret：

   | Secret | 内容 |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | `base64 -w0 my-release.p12` 的输出 |
   | `ANDROID_STORE_PASSWORD` | keystore 密码 |
   | `ANDROID_KEY_ALIAS` | 上面 `-alias` 的值 |
   | `ANDROID_KEY_PASSWORD` | 私钥密码（与 keystore 相同即可） |

3. 之后 CI 会优先使用 secrets 里的密钥（`android/app/build.gradle` 里
   `ANDROID_KEYSTORE_PATH` 环境变量优先于仓库内的默认值），
   并且可以删掉本目录与 `android/app/build.gradle` 里的默认值。

> 注意：换密钥意味着**用户必须先卸载已装的 App** 才能装上新的（签名不同）。
> 所以定了密钥之后就尽量别再换。
