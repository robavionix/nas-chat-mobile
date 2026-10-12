# Linux x86_64 / ARM64 部署

本项目使用同一套源码和 Compose 配置，支持 `linux/amd64`（Intel / AMD 64 位）与 `linux/arm64`。宿主机可以是普通 Linux、虚拟机或提供 Docker 的 NAS，无需桌面环境、显示器或 GPU。上游 [LinuxServer 镜像](https://docs.linuxserver.io/images/docker-weixin/) 提供这两种架构；32 位 i386 / i686 和 ARMv7 不支持。

微信容器使用 Debian 用户空间，QQ 独立镜像使用 Ubuntu 用户空间；宿主机发行版不需要安装 Python、X11 或聊天客户端。QQ 部署见 [独立部署说明](qq-deployment.md)。宿主机仍需满足 Docker 和上游客户端的 CPU / 内核要求，不能保证所有旧型号 CPU 或旧 NAS 内核都可运行。

## 通用 Linux 安装

准备 Docker Engine（建议受维护版本，至少 20.10）、Compose v2、Bash 和可用 HTTPS 入口。建议宿主机内存至少 4 GB，并为镜像、构建缓存及聊天数据预留至少 12 GB 磁盘。底层桌面镜像较大，首次拉取与构建可能需要较长时间；随后启动无需联网安装 Python 包。

在源码目录执行：

```sh
git clone https://github.com/robavionix/nas-chat-mobile.git
cd nas-chat-mobile
bash scripts/setup.sh /absolute/path/chat-remote
cd /absolute/path/chat-remote
bash doctor.sh
docker compose up -d --build
docker compose ps
```

`setup.sh` 仅准备一个尚不存在的部署目录；不会启动容器，也不会覆盖已有数据。它自动生成随机网页登录密码，保存在权限为 `600` 的 `.env` 中，不在日志输出密码。以普通用户执行时，PUID / PGID 取当前用户。以 root 执行时必须指定数据所属普通用户，例如：

```sh
sudo env PUID="$(id -u)" PGID="$(id -g)" bash scripts/setup.sh /opt/chat-remote
```

`doctor.sh` 只读检查 Docker、Compose、Docker 服务端架构、强制跨架构设置和部署文件。成功不等于客户端已登录；启动后 `chat` 应在几分钟内变为 `healthy`。健康检查验证 API、nginx 登录页、X11 和输入工具，不把“尚未登录客户端”当作故障。

`config/` 保持私有权限，静态网页子目录以独立只读挂载提供给 nginx 的 `www-data` 用户。只有网页文件使用 `644`、网页目录使用 `755`；会话密钥、推送密钥与运行数据不因此公开。修改 Compose 卷配置后需要 `up -d` 重建容器，单独 `restart` 不会增加挂载。

用本机 HTTPS 反向代理指向 `http://127.0.0.1:5804`，保留原始 `Host`、`Origin` 和 WebSocket 的 `Upgrade` / `Connection`，再打开 HTTPS 地址的 `/index.html` 完成桌面客户端登录，手机入口是 `/mobile/`。登录 Cookie 需要 HTTPS。不要把浏览器入口改成 HTTP 来排查登录。

如果代理本身也在容器内，它的 `127.0.0.1` 是代理容器自身；应配置共享 Docker 网络并使用 `chat:3000`，或让代理通过宿主机地址连接。不要未经调整直接将目标设为代理容器内的 localhost。

## 架构与依赖

无需手工写 `platform: linux/amd64`：Docker 自动选择当前架构。x86_64 主机拉取 amd64，ARM64 主机拉取 arm64；清除遗留的 `DOCKER_DEFAULT_PLATFORM`，避免误用模拟运行。

`Dockerfile` 在本机基础镜像上创建独立 Python 虚拟环境，安装 Pillow、Web Push / 加密依赖及 X11 输入工具，不修改 Selkies 的 Python 包。默认固定上游多架构 manifest digest，避免 `latest` 更新悄悄改变客户端布局；若要升级上游，请修改 `BASE_IMAGE` 后重新构建、验证。构建上下文仅包含依赖定义，`.env`、聊天数据、证书和私人图标均不进入新增镜像层。仓库提供构建配方，不发布包含第三方客户端的二次打包镜像。

`mobile-services/mobile/python` 优先使用新虚拟环境，同时兼容旧部署的 `/lsiopy/bin/python3`。新虚拟环境模式忽略旧 `push-deps/`，避免 ARM 原生扩展或旧依赖遮蔽当前架构的包。后端遵从 `DISPLAY`（默认 `:1`），Xlib 使用本机指针与 `unsigned long` 类型，不包含 ARM 专用机器码或固定为 ARM 的库路径。

`.env` 可调整：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PUID` / `PGID` | 部署用户的 UID / GID | `config/` 所有者；不要照搬另一台机器的 ID |
| `HTTP_PORT` | `5804` | 仅绑定宿主机 `127.0.0.1` 的 HTTP 上游端口 |
| `MEM_LIMIT` | `4g` | 容器内存上限，并非预留；宿主机与 DSM 也需要内存 |
| `SHM_SIZE` | `1gb` | 桌面共享内存上限，避免 Chromium / Qt 在小 `/dev/shm` 中退出 |
| `TZ` | `Asia/Shanghai` | 容器时区 |
| `BASE_IMAGE` | `ghcr.io/linuxserver/weixin@sha256:ef55da929cab5fae1f45b902b94918234604fa1473a7a7322383614a51573059` | 上游标签或多架构 manifest digest；更改后重新构建 |

普通 CPU 软件渲染为默认方式，禁用 GPU 自动探测和容器内嵌套 Docker；不需要 `privileged`、宿主机网络或挂载 Docker socket。未设置推送的 HTTPS origin 时，不会自动启用通知，即使依赖已安装。

## 群晖 DSM

适用于能安装 Container Manager（或带 Compose v2 的 Docker）的 **x86_64 群晖**。以实际 `docker info` 架构和套件可用性为准，不依赖型号名称判断。

1. 安装 Container Manager，启用 SSH，在 SSH 中用 `id 用户名` 查数据所属用户的 UID / GID。群晖用户的 UID / GID 通常不同于 `1000:1000`，请填写实际值。
2. 将公开源码解压到共享文件夹，例如 `/volume1/docker/nas-chat-mobile`。从此目录运行安装脚本，目标使用相邻的新目录 `/volume1/docker/chat-remote`；若需要 sudo，按前面的方式明确指定 PUID / PGID。部署目录必须位于可执行脚本的本地文件系统，勿使用会丢失权限的 SMB 客户端挂载。
3. 执行 `doctor.sh` 后，可以通过 SSH 运行 `docker compose up -d --build`。也可在 Container Manager → **项目 → 创建**，将项目路径设为 `chat-remote`，使用其中的 `docker-compose.yml` 并构建、启动。[群晖项目说明](https://kb.synology.cn/zh-cn/DSM/help/ContainerManager/docker_project)
4. DSM 自带反向代理在宿主机上运行，目标设为 **HTTP / 127.0.0.1 / 5804**（或你设置的端口），来源为自己的 HTTPS 域名。在自定义标题中创建 WebSocket 标头，并为该域名选择有效证书。不要使用 DSM 管理入口的端口作为本项目 HTTP 端口。
5. 打开 `/index.html` 完成桌面登录，再用 iPhone 打开 `/mobile/`。公网通知和可选内网 IP HTTPS 沿用 README 的设置流程。

部分旧 DSM 内核或 libseccomp 与较新的容器不兼容。先更新 DSM / 容器套件并检查容器日志；遇到 `Operation not permitted`、线程创建失败等错误时核对上游兼容说明。本项目不会默认关闭 seccomp 或要求特权模式。不要把没有登录产生的“窗口尚未就绪”误判为架构错误。

## 从 ARM64 迁移到 x86_64

1. 保留原服务器作为回退，备份 `.env`、`config/` 和证书。先在新机器准备独立部署，确认新的原生镜像启动正常。
2. 两端停止客户端后再复制所需配置；不要同时打开同一份可写数据。PUID / PGID 按新宿主机修改，并修正数据所有权。
3. **不要复制 `config/mobile/push-deps/`、Python 虚拟环境或容器文件系统。** 这些目录可能含 ARM 原生扩展；新镜像会安装 x86_64 依赖。可以保留 `config/mobile/push/` 中的 VAPID 密钥与订阅，以及 `session.key` 等应用数据；域名或 HTTPS origin 变化仍需更新配置和重新订阅。
4. 新旧客户端架构或版本不同，桌面客户端可能要求重新登录；不保证聊天客户端的登录缓存可跨架构沿用。先验证登录、会话选择、发送与画面，再切换代理。
5. 私人图标只在自己的部署目录保留；不要提交到源码仓库。证书只在地址继续匹配且客户端信任时复用；IP 改变需要重新生成服务器证书。

## 验证与故障定位

0.4.0 已在原生 x86_64 CPU 的 Ubuntu 26.04 / WSL2 Linux、Docker 29.1.3、Compose 2.40.3 中完成镜像构建、全新安装和容器冒烟检查：X11 窗口识别、真实像素颜色、键盘与中文剪贴板、加密扩展、nginx 登录与布局 API、WebSocket 无损帧解码均通过。另检查登录页权限错误能被健康检查捕获，并验证重启后会话密钥和 nginx 路由保留。测试容器未登录真实聊天账号，因此未验证新 x86 部署中的真实会话发送和手机推送。尚未在群晖真机验证。

上游固定 manifest 包含 amd64 / arm64；ARM64 原生 Python 扩展的 wheel 可获取性已检查。现有 ARM64 私人部署保持运行，但 0.4.0 的新构建镜像尚未在 ARM64 宿主机做同样的完整冒烟检查。

仓库的通用回归检查见 README；部署脚本可运行 `bash tests/test_deploy.sh`，覆盖随机密码、权限、路径中含空格、不覆盖已有目录、排除运行数据与跨架构配置检查。

`tests/smoke_container.py` 专用于**未登录账号的临时测试容器**：验证真正的 X11 截图颜色、窗口识别、测试窗口键盘输入、中文剪贴板、加密扩展、nginx 鉴权及布局 API。它会临时打开测试窗口，因此不要在使用中的私人聊天桌面上执行。

```sh
docker exec -i -u abc chat-remote /custom-services.d/mobile/python - < tests/smoke_container.py
```

常用诊断（请自行删除日志中的个人信息后再分享）：

```sh
docker compose ps
docker compose logs --tail=100 chat
docker compose exec chat /custom-services.d/mobile/python /custom-services.d/mobile/healthcheck.py
docker image inspect nas-chat-mobile:local --format '{{.Os}}/{{.Architecture}}'
```

健康检查只报告状态，不自动重启正在运行的桌面。重建后有问题时恢复备份部署文件和先前镜像，执行 `docker compose up -d`；不要删除 `config/` 来排查。镜像构建只发生在新测试环境和新部署，原有 ARM64 私人服务不需要为此停机。
