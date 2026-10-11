# nas-chat-mobile

当前版本：**0.4.0** · [更新记录](CHANGELOG.md)

把运行在 NAS 上的**桌面版聊天客户端**变成**手机浏览器里可触控使用的界面**。

它配合 [linuxserver/docker-weixin](https://github.com/linuxserver/docker-weixin) 镜像工作：该镜像在容器里通过网页远程桌面运行 Linux 版客户端。本项目在同一个容器里加一层手机视图：竖屏布局、会话列表与聊天切换、触控点击 / 长按 / 滑动 / 双指缩放、文字与文件发送，并可添加到 iPhone 主屏幕。

> **非官方项目。** 与腾讯公司及其关联公司无任何关联，未获其授权或认可。使用前请阅读文末的 [免责声明](#免责声明)。

## 功能

- **手机竖屏视图**：会话列表和聊天两种视图，标题栏固定，内容在手机本地平滑滚动；支持双指缩放和「Aa」放大。
- **会话过渡**：新画面绘制完成后才做 220 毫秒匀速滑动；独立快照覆盖画布改尺寸的过程，返回列表时也覆盖增高的区域，支持系统减少动态效果设置。
- **侧滑返回**：聊天画面的左侧边缘向右滑动，画面跟随手指；滑动不足回弹，完成后立即用本地快照返回会话列表，再衔接实际画面，网络等待不会卡住松手动画。竖向滚动和双指缩放保留各自手势。
- **可选后台通知**：公网 HTTPS 入口可开启 Web Push，支持测试通知和消息内容预览开关；默认隐藏内容，退出登录撤销该会话的订阅。
- **触控操作**：点击、长按（打开右键菜单，可复制、转发、引用、撤回等）、滑动和惯性滚动。复制的内容可以一键复制到手机剪贴板。
- **发送文字**：点击发送立即清空已提交的文字，随后输入下一条不会被旧请求清空；未确认的发送按原会话保留。后端核对输入内容与聊天对象，请求带幂等 ID，避免重复发送。
- **发送照片和文件**：支持文件选择和剪贴板图片粘贴，发送前显示当前聊天标题供核对，单个文件最大 95 MB。
- **弹出窗口**：图片查看器、文章、菜单、对话框、独立聊天窗口会自动显示在手机上，可返回或关闭。
- **防误点**：会话列表因新消息重新排序时，点击前比对行指纹，不一致就不点。
- **画面传输**：默认使用 WebSocket 按横条增量推送，滚动行在手机端复用；每帧解码后确认，服务器最多保留一帧在途。连接中断自动降级为逐帧请求，并定时重试。
- **清晰度**：首屏与会话切换保留原始分辨率；默认清晰优先，内网 IP 的静态画面使用无损 PNG。慢连接可在菜单切换为流畅优先。
- **家里直连**：可为内网 IP 单独配置 HTTPS；设置页提供 iPhone 证书安装指引，菜单显示连接方式。
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
- `Dockerfile` / `scripts/setup.sh` / `scripts/doctor.sh`：为 x86_64 或 ARM64 本机构建依赖，准备部署目录并检查环境；Compose 健康检查验证后端和 X11。
- `mobile/server.py`：读取窗口布局、截取画面、执行点击 / 滚动 / 粘贴 / 发送，全部通过标准 X11 接口完成。
- `mobile/push_service.py`：可选推送服务，监听标准 D-Bus 桌面通知并用 Web Push 加密投递；不读取聊天数据库或客户端通信协议。
- `mobile/web/`：手机界面。
- `scripts/setup-lan.sh` / `lan-proxy/`：可选内网 HTTPS 部署工具与代理模板。

## 环境要求

- 64 位 Linux：支持 Intel / AMD x86_64（`linux/amd64`）和 ARM64（`linux/arm64`），包括普通服务器、虚拟机和提供 Docker 的 NAS。32 位 x86 / ARMv7 不支持。
- Docker Engine（至少 20.10，建议受维护版本）与 Docker Compose v2；安装脚本需要 Bash。详见 [通用 Linux 与群晖部署说明](docs/linux-deployment.md)。
- 可用的 HTTPS 访问方式：反向代理、Cloudflare Tunnel、VPN 等。登录 Cookie 带有 `Secure` 和 `__Host-` 前缀，纯 HTTP 无法登录。
- 建议宿主机内存 4 GB 以上，镜像与构建缓存预留至少 12 GB 磁盘，聊天数据另计。不需要 GPU 或宿主机桌面。

0.4.0 已完成原生 x86_64 Linux 容器构建与截图、输入、登录、WebSocket 冒烟验证；群晖真机与真实账号操作尚待部署验证，详见 [验证范围](docs/linux-deployment.md#验证与故障定位)。

## 安装

1. 在源码目录运行安装脚本，准备一个新的独立部署目录（将绝对路径换成自己的路径）：

   ```
   chat-remote/
   ├── docker-compose.yml        ← 复制自 docker-compose.example.yml
   ├── .env                      ← 脚本生成随机密码与用户 ID
   ├── Dockerfile / .dockerignore ← 在本机为当前架构构建依赖
   ├── mobile/requirements*.txt   ← 构建时使用，不包含运行数据
   ├── doctor.sh                 ← 只读部署检查
   ├── config/                   ← 容器数据，首次启动时生成
   │   └── mobile/               ← 复制本仓库的 mobile/ 目录
   ├── mobile-init/50-mobile
   └── mobile-services/mobile/run
   ```

   ```sh
   git clone https://github.com/robavionix/nas-chat-mobile.git
   cd nas-chat-mobile
   bash scripts/setup.sh /absolute/path/chat-remote
   ```

2. 脚本生成随机 `WEB_PASSWORD` 并保存在部署目录的 `.env`，PUID / PGID 默认取当前用户；以 root 执行需明确指定数据所属普通用户。可以在 `.env` 调整端口、时区和内存上限。脚本拒绝覆盖已有目录，不会复制旧的会话密钥、证书或原生 Python 扩展。

3. 启动：

   ```sh
   cd /absolute/path/chat-remote
   bash doctor.sh
   docker compose up -d --build
   docker compose ps
   ```

   Docker 自动选择当前架构。首次构建包含桌面镜像下载与依赖安装；之后启动不再安装依赖。`chat` 应在几分钟内显示 `healthy`。群晖的 PUID / PGID、项目创建和 DSM 代理设置见 [部署说明](docs/linux-deployment.md#群晖-dsm)。

4. 为 `127.0.0.1:5804` 配置 HTTPS 访问（反向代理或隧道），并保留 WebSocket、Host 与 Origin。**不要直接把它以 HTTP 暴露到公网。**

5. 首次使用：用电脑浏览器打开 `https://你的域名/index.html`（原远程桌面），在里面完成客户端登录。

6. 在手机上打开 `https://你的域名/mobile/`，用 `WEB_PASSWORD` 登录，然后在 Safari 中选择「分享 → 添加到主屏幕」。

## 可选：内网 IP HTTPS

在家可以直接访问 NAS 的内网 IP，无需为它注册域名。需要在 iPhone 上安装并信任本台 NAS 生成的根证书。代理只监听指定的内网 IP 和端口，允许指定网段访问；不需要修改 NAS 管理界面的端口。

在 NAS 上安装好主服务后，从本仓库目录执行（把目录、IP 和网段换成自己的值）：

```sh
sudo env CHAT_ROOT=/absolute/path/chat-remote \
  LAN_IP=192.168.1.10 LAN_CIDR=192.168.1.0/24 LAN_PORT=5843 \
  ./scripts/setup-lan.sh
```

脚本需要 Python 3、OpenSSL 和 Docker Compose。部署目录必须在源码仓库之外。它生成独立根 CA、含 IP SAN 的 397 天服务器证书、只包含根证书的 iPhone 描述文件，以及部署时的 `lan-config.json`；私钥保存在 `chat-remote/lan-proxy/authority/` 和 `tls/`，只有服务器证书目录挂载给代理。再次运行会保留根 CA，续签服务器证书并重建独立代理；桌面客户端继续运行。

1. 先通过已经受信任的 HTTPS 地址打开 `/mobile/lan-setup.html`，下载证书描述文件。
2. 在 iPhone 设置中安装该描述文件，再到“通用 → 关于本机 → 证书信任设置”，开启对应根证书的完全信任。详见 [Apple 的说明](https://support.apple.com/zh-cn/102390)。
3. 连接家庭 Wi-Fi，打开设置页中的家里直连地址，输入原来的网页登录密码。内外网地址各自保存登录状态。
4. 如需主屏幕入口，在内网地址上选择“分享 → 添加到主屏幕”。根目录和 `/mobile/` 下均提供原有中性图标。

固定 NAS 的内网 IP；IP 变化后需要重新运行脚本。请在服务器证书到期前重新运行同一命令续签。正常续签不更换根 CA，无需重新安装根证书。NAS 防火墙还需允许家庭网段访问所选端口；不要把这个端口映射到公网。

## 可选：外网消息推送

0.4.0 的本机构建镜像已包含推送依赖，但仍需主动配置 origin 和在手机上启用。旧部署若仍使用上游原始镜像，可安装可选依赖（使用自己的实际容器名）：

```sh
docker exec chat-remote /lsiopy/bin/python3 -m pip install \
  --target /config/mobile/push-deps -r /config/mobile/requirements-push.txt
```

以容器运行用户创建 `config/mobile/push/settings.json`，仅写入自己的外网 HTTPS 源地址，不带路径：

```json
{"origin":"https://chat.example.com"}
```

该目录需容器运行用户可写、权限为 `700`，配置文件权限为 `600`。重启 Python 服务：

```sh
docker exec chat-remote s6-svc -r /run/wechat-mobile-service
```

服务会生成并保留 VAPID 私钥与订阅文件。请勿公开 `config/mobile/push/`，升级时保留此目录。未配置或未安装依赖时，聊天功能继续运行，推送不启用。

从外网入口打开菜单，开启“消息推送”，允许系统通知，再按“发送测试通知”。菜单会等待服务器投递结果，区分“已排队”与“推送服务已接受”；后者仍需在手机上确认，系统专注模式等设置可能影响显示。通知组件更新完成后才允许开启。iPhone / iPad 需 iOS / iPadOS 16.4 或以上，通过 Safari 添加到主屏幕后，从主屏幕打开并开启；普通 Safari 标签页不支持这项后台推送。参见 [WebKit 说明](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)。支持 Apple、Chrome / Chromium 的 FCM 和 Firefox 推送端点；其他推送服务端点默认拒绝。

消息来源是客户端的标准桌面通知：客户端需启用新消息通知，静音会话或客户端当前焦点等行为可能抑制通知。测试通知仅验证浏览器投递通道；实际来信需另外验证。通知点击后返回会话列表，不根据通知文字猜测并打开联系人。订阅最多保持到网页登录会话到期（30 天），重新登录后需主动开启。

建议使用稳定的 HTTPS 域名或隧道地址。临时隧道地址改变后，需更新 `origin`、重启服务，并在新地址重新添加主屏幕入口和开启通知。内网 IP 入口不提供此开关。

## 升级

先备份部署目录中的 `config/mobile/`、`mobile-init/`、`mobile-services/`，然后在源码仓库执行 `git pull --ff-only`。复制新版后端、网页脚本与 HTML、启动脚本到部署目录，重启主容器，使 nginx 的 WebSocket 路由生效：

```sh
cp mobile/server.py mobile/push_service.py mobile/requirements*.txt ../chat-remote/config/mobile/
cp mobile/web/*.js mobile/web/*.html ../chat-remote/config/mobile/web/
cp mobile-init/50-mobile ../chat-remote/mobile-init/
cp mobile-services/mobile/run mobile-services/mobile/python mobile-services/mobile/healthcheck.py ../chat-remote/mobile-services/mobile/
chmod +x ../chat-remote/mobile-init/50-mobile ../chat-remote/mobile-services/mobile/run ../chat-remote/mobile-services/mobile/python
cd ../chat-remote
docker compose restart chat
```

已有的 `.env`、会话密钥、发送幂等记录、证书和图标不需要覆盖。自定义过 HTML 时，先合并自己的标题、图标链接与菜单入口；如启用内网代理，运行新版设置脚本生成部署配置。刷新手机页面即可加载新脚本。

上述是旧上游镜像部署的兼容升级方式。要采用 0.4.0 的依赖镜像，另外复制 `Dockerfile`、`.dockerignore` 和 `mobile/requirements*.txt` 到部署目录对应位置，将 Compose 的 `image` / `build` 配置按新版示例合并，保留原来的端口、环境变量和卷。先备份原 Compose 与镜像，再执行 `docker compose up -d --build`；只执行 `restart` 不会切换镜像。跨架构迁移请先阅读 [迁移说明](docs/linux-deployment.md#从-arm64-迁移到-x86_64)，不要复制旧的 `push-deps/`。

## 回归检查

在仓库根目录运行，需要 Python 3 + Pillow + cryptography 和 Node.js：

```sh
python -m py_compile mobile/server.py mobile/push_service.py
python tests/test_transport.py
python tests/test_push.py
node tests/test_transport.cjs
node tests/test_fallback.cjs
node tests/test_send.cjs
node tests/test_paste.cjs
node tests/test_navigation.cjs
node tests/test_swipe.cjs
node tests/test_push.cjs
bash -n scripts/setup-lan.sh
bash -n mobile-init/50-mobile
bash -n mobile-services/mobile/run
bash -n mobile-services/mobile/python
bash -n scripts/setup.sh
bash -n scripts/doctor.sh
bash tests/test_deploy.sh
```

这些检查覆盖分段网络读取、传输回退、无损画质、快速输入、失败恢复、图片粘贴、过渡与侧滑生命周期，以及通知权限、订阅撤销、过期处理和消息预览。不会向真实联系人或真实推送端点发送测试消息。

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
- 反向代理需转发 WebSocket 的 Upgrade、Host 与 Origin，示例启动脚本和内网代理已包含配置；不支持 WebSocket 的路径会使用兼容模式。
- 界面内容仍来自桌面截图，远端响应、网络和图片解码决定切换前的等待时间；本地过渡不能消除这些时间。
- 图片粘贴依赖 iOS / 来源 App 是否把图片提供给网页剪贴板；若来源只提供文字或链接，可以使用“＋”从照片或文件选择。
- 画面在动的时候刷新率约为每秒 5～10 帧，适合聊天类操作，不适合看视频。
- 按单用户设计，多台设备共用同一个桌面。

## 免责声明

1. 本项目是个人学习与自用目的的开源工具，与深圳市腾讯计算机系统有限公司（"腾讯"）及其关联公司**没有任何关联**，未获其授权、赞助或认可。"微信""WeChat""Weixin"及相关标识是腾讯的商标或注册商标，本项目提及这些名称仅为说明所兼容的软件。
2. 本项目**不包含、不分发、不修改、不破解、不逆向工程**任何腾讯客户端或通信协议。它仅通过标准 X11 接口（读取屏幕、模拟鼠标和键盘）及标准桌面通知接口，操作使用者自己在容器中运行的官方客户端窗口并接收其系统通知，工作方式与远程桌面相同。客户端程序由使用者自行获取并运行的第三方镜像提供，其使用受腾讯相关协议约束。
3. **仅限使用者本人用自己的账号使用。** 不得将本项目用于：群发消息、营销推广、自动回复或聊天机器人、批量添加好友、账号买卖或代运营、监控他人通讯、收集他人个人信息，以及任何违反《腾讯微信软件许可及服务协议》《微信个人账号使用规范》等平台规则或所在地法律法规（包括但不限于《中华人民共和国网络安全法》《数据安全法》《个人信息保护法》）的行为。
4. 通过非官方方式使用客户端，可能导致账号受到限制或封禁，相关风险由使用者自行承担。
5. 本项目只在使用者自己的服务器上处理画面和文件，作者不收集任何数据。请妥善保管服务器和访问密码。
6. 本软件按"现状"提供，不附带任何明示或暗示的担保。作者不对因使用或无法使用本项目造成的任何直接或间接损失承担责任。详见 [LICENSE](LICENSE)。

## 致谢

- [linuxserver/docker-weixin](https://github.com/linuxserver/docker-weixin)：容器镜像与网页远程桌面。
- [Selkies](https://github.com/selkies-project/selkies)：网页远程桌面技术。

本仓库不包含上述项目的任何代码，只在运行时与它们的容器配合使用。

## English summary

**nas-chat-mobile 0.4.0** adds a touch-friendly phone interface to a desktop chat client running inside the [linuxserver/docker-weixin](https://github.com/linuxserver/docker-weixin) web desktop container. It includes local scrolling, linear list/chat transitions, touch gestures, text and clipboard-image sending, pop-up windows, and a home-screen web app. The Python service captures X11 screenshots and pushes changed JPEG/PNG strips over an acknowledged WebSocket, falling back to frame requests when necessary. Clear mode preserves native resolution; private-IP static frames use lossless PNG. Optional scripts provision a separate LAN HTTPS proxy and an iPhone root-certificate setup page. Existing neutral branding and icons are retained.

Native Linux amd64 and arm64 deployments share one Compose configuration. The local Docker build installs isolated Python and X11 dependencies; setup, environment checks, health checks and Synology instructions are included. See [Linux deployment and validation scope](docs/linux-deployment.md).

This is an unofficial project. It is not affiliated with or endorsed by Tencent. "WeChat" and "Weixin" are trademarks of Tencent and are mentioned only to describe compatibility. The project does not include, modify, or reverse-engineer any Tencent software or protocol. Use it only with your own account and in compliance with the platform's terms and applicable law; do not use it for bulk messaging, marketing, bots, or monitoring others. Provided as is, without warranty, under the [MIT License](LICENSE).
