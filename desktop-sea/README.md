# 電脳麻将 — Node SEA 单文件打包

把 web 版（`../dist`）打包成**单文件可执行程序**：内置 Node 静态服务器，
双击后自动打开系统默认浏览器到 `http://127.0.0.1:8080/` 游玩。

## 产物形态

| 平台 | 产物 | 体积 |
|---|---|---|
| Linux | `電脳麻将` | ~126 MB |
| Windows | `電脳麻将.exe` | ~126 MB |

- 程序 = Node 运行时 + `server.js`（静态服务器）+ `dist.zip`（14MB 应用资源，以 SEA 资产注入）。
- **每平台各构建一个**（原生二进制无法跨 OS 通用）。构建需在目标平台上进行，或用 CI 矩阵。

## 构建步骤

前置要求：Node ≥ 22.2（用到了 `zlib.crc32` 与 SEA assets）。

```bash
cd desktop-sea
npm install          # 安装 postject
npm run build        # = build:zip → build:blob → build:bin
```

三个子步骤：

1. `npm run build:zip` — `build.js` 把 `../dist` 打成 `dist.zip`（纯 Node 实现，Windows 无 zip 命令也可用）。
2. `npm run build:blob` — `node --experimental-sea-config sea-config.json` 生成 `sea-prep.blob`（含 server.js + dist.zip）。
3. `npm run build:bin` — `bin.js` 复制 `process.execPath`（当前 node）为 `電脳麻将(.exe)`，再用 postject JS API 注入 blob。

> 关键点：postject 的 `--sentinel-fuse` 必须用 **`NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`**
> （`NODE_SEA_FUSE_` 前缀）。用 postject 自带的 `POSTJECT_SENTINEL_` 默认值会报
> "Could not find the sentinel"。

### Windows 构建
在 Windows 上装 Node ≥ 22.2 后同样执行 `npm install && npm run build`，
`bin.js` 会自动复制 `node.exe` 并产 `電脳麻将.exe`。

### 在 Linux 上构建 Windows 版？
SEA 需要目标平台的 node 二进制，**不建议用 Wine 强出**。推荐 GitHub Actions 矩阵
（`windows-latest` + `ubuntu-latest`）各自跑 `npm run build`，一次 push 双平台出产物。

## 运行行为

1. 启动后从 SEA 资产读出 `dist.zip`，解压到 `<系统临时目录>/majiang-<内容hash>/`（幂等：已存在则复用）。
2. 在 `127.0.0.1:8080` 起静态服务器（**被占用自动退到 8081**）。
3. 自动打开默认浏览器（Win `start` / macOS `open` / Linux `xdg-open`），失败则打印 URL。

## 开发调试（不打包直接跑）

```bash
npm run dev          # = node server.js ../dist，直接 serve 源 dist 目录
```

## 注意事项

- **localStorage 按"域名:端口"隔离**：若 8080 被占用退到 8081，存档/牌谱/偏好会是另一份
  （origin 不同）。想保持存档连续，请确保启动时 8080 空闲。
- 牌谱数据都在浏览器 localStorage，程序本身不落盘牌谱文件。
- 解压目录以内容 hash 命名：dist 更新后 hash 变化会自动解压新副本；旧目录需手动清理
  （`/tmp/majiang-*`）。
- netplay / 天鳳牌譜导入需联网（netplay 还需外部 kobalab 服务器，离线时优雅降级）。

## 文件说明

| 文件 | 作用 |
|---|---|
| `server.js` | 静态服务器 + 最小 ZIP 解压器 + 自动开浏览器（仅内置模块，零依赖） |
| `build.js`  | 纯 Node 的 ZIP 写入器，把 `../dist` 打成 `dist.zip` |
| `bin.js`    | 复制 node 运行时 + postject 注入（JS API） |
| `sea-config.json` | SEA 配置（入口 + dist.zip 资产） |
| `.gitignore` | 忽略构建产物（dist.zip / sea-prep.blob / 可执行文件 / node_modules） |

## 局域网联机（内置对战服务器）

从 v2.5.3 起，桌面版内置了**完整的网络对战服务器**（express + socket.io + Majiang.Game 权威引擎）。
双击程序启动后，可以在网页上按以下流程联机：

1. タイトル画面 → 「ネット対戦」→ 「局域网联机」按钮 → **开启**（默认 OFF）
2. 开启后页面显示邀请链接（如 `http://192.168.1.5:8080/`）
3. 其他设备在浏览器打开该链接 → 同页面入室 → 对局
4. 空席由 AI 自动补位；掉线时服务器自动代打

局域网开关可在对局空闲时随时关闭（房间存在时不可切换）。

### 端口与防火墙

- 监听端口：`8080`（被占自动退到 8081…8099）
- 局域网联机关闭时仅监听 `127.0.0.1`，不影响其他使用场景
- 如需局域网访问，请确保防火墙放行对应端口

### 构建说明（含对战服务器）

```sh
npm run build:server          # 从仓库根目录：webpack 打包服务器单文件
cd desktop-sea && npm run build   # 打包 dist.zip → SEA blob → 注入二进制
```

构建产物 `server-bundle.cjs` 已自动忽略，不进入版本控制。
