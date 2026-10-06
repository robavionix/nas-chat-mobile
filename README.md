# nas-chat-mobile

把运行在 NAS 上的**桌面版聊天客户端**变成**手机浏览器里可触控使用的界面**。

它配合 [linuxserver/docker-weixin](https://github.com/linuxserver/docker-weixin) 镜像工作：该镜像在容器里通过网页远程桌面运行 Linux 版客户端。本项目在同一个容器里加一层手机视图：竖屏布局、会话列表与聊天切换、触控点击 / 长按 / 滑动 / 双指缩放、文字与文件发送，并可添加到 iPhone 主屏幕。

> **非官方项目。** 与腾讯公司及其关联公司无任何关联，未获其授权或认可。使用前请阅读文末的 [免责声明](#免责声明)。

## 功能

- **手机竖屏视图**：会话列表和聊天两种视图，标题栏固定，内容在手机本地平滑滚动；支持双指缩放和「Aa」放大。
- **触控操作**：点击、长按（打开右键菜单，可复制、转发、引用、撤回等）、滑动和惯性滚动。复制的内容可以一键复制到手机剪贴板。
- **发送文字**：通过剪贴板粘贴，并核对输入框内容；发送请求带幂等 ID，避免重复发送；会话变化时拒绝发送，避免发错对象。
- **发送照片和文件**：从手机选择后先显示当前聊天标题供核对，单个文件最大 95 MB。
- **弹出窗口**：图片查看器、文章、菜单、对话框、独立聊天窗口会自动显示在手机上，可返回或关闭。
- **防误点**：会话列表因新消息重新排序时，点击前比对行指纹，不一致就不点。
- **画面传输**：服务器直接截取窗口画面，按 64 像素横条增量发送 JPEG，不依赖浏览器视频解码（iOS Safari 解码视频会滞后一帧）。
- **全览**：需要时可按需加载原远程桌面。
- **独立登录**：签名 Cookie 会话（30 天）、按 IP 限制登录失败次数，支持「退出所有设备」。
- **PWA**：可添加到主屏幕，以全屏方式打开。

## 工作原理

```
手机浏览器 ──HTTPS──> 反向代理 / 隧道 ──> 容器内 nginx (:3000)
                                          ├─ /mobile/      手机界面静态文件（mobile/web）
                                          ├─ /mobile-api/  手机后端 server.py (127.0.0.1:8089)
                                          └─ 其余路径       原远程桌面（全览时使用）
server.py ──Xlib / xdotool / xclip──> X 显示器 :1 上的客户端窗口
```

- `mobile-init/50-mobile`：容器启动时修改容器内 nginx 配置，加上 Cookie 鉴权（`auth_request`）和上面的路由，并启动后端服务。
- `mobile-services/mobile/run`：以容器用户运行 `server.py`。
- `mobile/server.py`：读取窗口布局、截取画面、执行点击 / 滚动 / 粘贴 / 发送，全部通过标准 X11 接口完成。
- `mobile/web/`：手机界面。

## 环境要求

- Docker 与 docker compose。已在 ARM64（RK3588 NAS）上测试，x86_64 应同样可用。
- 可用的 HTTPS 访问方式：反向代理、Cloudflare Tunnel、VPN 等。登录 Cookie 带有 `Secure` 和 `__Host-` 前缀，纯 HTTP 无法登录。
- 建议内存 4 GB 以上。

## 安装

1. 准备目录：

   ```
   chat-remote/
   ├── docker-compose.yml        ← 复制自 docker-compose.example.yml
   ├── .env                      ← 复制自 .env.example，并设置密码
   ├── config/                   ← 容器数据，首次启动时生成
   │   └── mobile/               ← 复制本仓库的 mobile/ 目录
   ├── mobile-init/50-mobile
   └── mobile-services/mobile/run
   ```

   ```sh
   git clone https://github.com/robavionix/nas-chat-mobile.git
   mkdir -p chat-remote/config
   cd nas-chat-mobile
   cp docker-compose.example.yml ../chat-remote/docker-compose.yml
   cp .env.example ../chat-remote/.env
   cp -r mobile ../chat-remote/config/
   cp -r mobile-init mobile-services ../chat-remote/
   chmod +x ../chat-remote/mobile-init/50-mobile ../chat-remote/mobile-services/mobile/run
   ```

2. 编辑 `.env`，把 `WEB_PASSWORD` 设成一个足够长的随机字符串（例如 `openssl rand -hex 16`），并让 `PUID` / `PGID` 与 `config/` 目录的所有者一致。

3. 启动：

   ```sh
   cd ../chat-remote
   docker compose up -d
   ```

4. 为 `127.0.0.1:5804` 配置 HTTPS 访问（反向代理或隧道）。**不要直接把它以 HTTP 暴露到公网。**

5. 首次使用：用电脑浏览器打开 `https://你的域名/index.html`（原远程桌面），在里面完成客户端登录。

6. 在手机上打开 `https://你的域名/mobile/`，用 `WEB_PASSWORD` 登录，然后在 Safari 中选择「分享 → 添加到主屏幕」。

## 配置说明

- `SELKIES_MANUAL_WIDTH` / `SELKIES_MANUAL_HEIGHT`：手机视图假定使用较高的竖屏桌面（默认 1800×2800）。后端会把客户端主窗口调整为 760 像素宽、几乎与桌面同高，这样手机可以在本地滚动较长的内容。
- `TZ`：消息时间的显示时区，例如 `Asia/Shanghai`。
- 换图标：替换 `config/mobile/web/` 下的 `apple-touch-icon.png`（180×180）、`icon.png`（512×512）、`icon-192.png` 和 `favicon.png`。iPhone 会缓存主屏幕图标，替换后需要删除旧图标再重新添加。

## 安全建议

- 密码要足够长且随机；登录失败会按来源 IP 限速。
- 只通过 HTTPS 访问。条件允许时，再加一层访问控制（如 Cloudflare Access、VPN）。
- 手机丢失时，在菜单中选择「退出所有设备」，会更换会话密钥，所有已登录设备都需要重新登录。
- 上传的文件临时存放在 `config/mobile/uploads/`，2 小时后自动删除。
- 诊断记录默认关闭。创建 `config/mobile/debug/enabled` 文件即可开启，记录内容只有坐标和状态，不包含消息文本。

## 已知限制

- 会话列表 / 聊天的识别和部分坐标依赖客户端当前的界面布局；客户端更新改版后可能需要调整。
- Cloudflare 临时隧道会在约 128 KB 后卡住长连接 HTTP 流，因此手机端默认用逐帧请求（长轮询）获取画面。`server.py` 里的 WebSocket 推送代码是实验功能，nginx 默认没有为它开放路由。
- 画面在动的时候刷新率约为每秒 5～10 帧，适合聊天类操作，不适合看视频。
- 按单用户设计，多台设备共用同一个桌面。

## 免责声明

1. 本项目是个人学习与自用目的的开源工具，与深圳市腾讯计算机系统有限公司（"腾讯"）及其关联公司**没有任何关联**，未获其授权、赞助或认可。"微信""WeChat""Weixin"及相关标识是腾讯的商标或注册商标，本项目提及这些名称仅为说明所兼容的软件。
2. 本项目**不包含、不分发、不修改、不破解、不逆向工程**任何腾讯客户端或通信协议。它只通过标准 X11 接口（读取屏幕、模拟鼠标和键盘）操作使用者自己在容器中运行的官方客户端窗口，工作方式与远程桌面相同。客户端程序由第三方镜像在运行时获取，其使用受腾讯相关协议约束。
3. **仅限使用者本人用自己的账号使用。** 不得将本项目用于：群发消息、营销推广、自动回复或聊天机器人、批量添加好友、账号买卖或代运营、监控他人通讯、收集他人个人信息，以及任何违反《腾讯微信软件许可及服务协议》《微信个人账号使用规范》等平台规则或所在地法律法规（包括但不限于《中华人民共和国网络安全法》《数据安全法》《个人信息保护法》）的行为。
4. 通过非官方方式使用客户端，可能导致账号受到限制或封禁，相关风险由使用者自行承担。
5. 本项目只在使用者自己的服务器上处理画面和文件，作者不收集任何数据。请妥善保管服务器和访问密码。
6. 本软件按"现状"提供，不附带任何明示或暗示的担保。作者不对因使用或无法使用本项目造成的任何直接或间接损失承担责任。详见 [LICENSE](LICENSE)。

## 致谢

- [linuxserver/docker-weixin](https://github.com/linuxserver/docker-weixin)：容器镜像与网页远程桌面。
- [Selkies](https://github.com/selkies-project/selkies)：网页远程桌面技术。

本仓库不包含上述项目的任何代码，只在运行时与它们的容器配合使用。

## English summary

**nas-chat-mobile** adds a touch-friendly phone interface to a desktop chat client running inside the [linuxserver/docker-weixin](https://github.com/linuxserver/docker-weixin) web desktop container: portrait list/chat views with local smooth scrolling, tap, long-press context menus, pinch zoom, text and file sending, pop-up windows, and a home-screen web app. A small Python service in the container captures the window over X11 and sends changed JPEG strips to the phone, and drives input with xdotool/xclip.

This is an unofficial project. It is not affiliated with or endorsed by Tencent. "WeChat" and "Weixin" are trademarks of Tencent and are mentioned only to describe compatibility. The project does not include, modify, or reverse-engineer any Tencent software or protocol. Use it only with your own account and in compliance with the platform's terms and applicable law; do not use it for bulk messaging, marketing, bots, or monitoring others. Provided as is, without warranty, under the [MIT License](LICENSE).
