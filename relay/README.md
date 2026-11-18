# 跨网配对

同一局域网的两台电脑可以直接粘贴邀请。跨公网使用时，可以在已有服务器上一次部署信令服务，两台客户端各保存一次相同的服务地址。每次连接仍需新的邀请和共享端的本机确认。

## 一次部署公网服务

准备一台有独立公网 IPv4 的 Linux 服务器，并安装 Docker Engine 和 Docker Compose v2.24 或更高版本。把本 `relay` 文件夹复制到服务器。给服务器添加 DNS A 记录，例如 `pair.example.com`。仅配置 IPv4 的服务器请只发布可用的 A 记录。请用自己的域名和地址替换文中示例。

1. 在云安全组和服务器防火墙放行 TCP 80、443、3478，以及 UDP 3478 和 49160–49200。80 和 443 供 Caddy 签发证书及提供 WSS。3478 接受 TURN 客户端连接，UDP 端口范围负责转发媒体。请选用这些端口可独占的服务器。
2. 在服务器的 `relay` 目录执行以下命令，一次生成本机配置和随机 TURN 密码。保留这份 `.env`，只通过可信渠道向两台电脑提供凭据。

   ```sh
   umask 077
   cp .env.example .env
   printf 'TURN_PASSWORD=%s\n' "$(openssl rand -hex 24)" >> .env
   nano .env
   ```

3. 把 `PAIR_DOMAIN` 改为你的域名，`TURN_PUBLIC_IP` 改为服务器公网 IPv4，`TURN_LOCAL_IP` 改为实际绑定在 Linux 网卡上的 IPv4。可运行 `ip -4 route get 1.1.1.1` 查看输出中的 `src` 地址。很多云主机有一对一公网映射，这时两个 IP 会不同。把 `TURN_USERNAME` 换成自选的字母、数字、下划线或短横线组合。保留自动生成的密码。
4. 启动服务并查看状态。三个服务分别是 `https`（Caddy）、`signal`（配对）和 `turn`（coturn）。Caddy 会向公开证书机构申请域名证书，需要公网 DNS 已生效。

   ```sh
   docker compose config --quiet
   docker compose up -d --build
   docker compose ps
   docker compose logs --tail 40 https turn
   ```

5. 在两台电脑的CC Connect网络设置中填写下表并保存。共享端创建新邀请，控制端粘贴邀请，待共享端确认后连接。

   | 设置 | 填写内容 |
   | --- | --- |
   | 信令地址 | `wss://pair.example.com/pair` |
   | TURN 地址 | `turn:pair.example.com:3478?transport=udp` |
   | TURN 用户名 | `.env` 中的 `TURN_USERNAME` |
   | TURN 密码 | `.env` 中的 `TURN_PASSWORD` |

建议两端分别使用家中网络和手机热点验证。若受限网络禁止出站 UDP，两端可将地址改为 `turn:pair.example.com:3478?transport=tcp`。如果网络仅允许 TLS 443，可填写已有服务商提供的 `turns:` 地址及凭据。这个 Compose 示例提供 UDP/TCP 3478 与 WSS 443；TURN 连接中的 WebRTC 媒体和数据通道仍由两端加密。服务端带宽与机房距离会影响中继时的画质和延迟。[WebRTC TURN 指南](https://webrtc.org/getting-started/turn-server) · [coturn 配置文档](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)

需要暂停服务时，在同一目录运行 `docker compose stop`，恢复时运行 `docker compose start`。更换 TURN 密码后运行 `docker compose up -d --force-recreate turn` 并同步修改两端设置。Caddy 证书保存在项目的 Docker 数据卷里。[Caddy 反向代理文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

## 已有反向代理与 TURN 服务

已有基础设施时，可在本项目根目录运行 `npm ci --omit=dev` 和 `node relay/server.cjs`。将可信域名的 WSS 路径 `/pair` 反向代理至 `127.0.0.1:8844`，同时在两台客户端保存自己的 TURN 服务参数。服务重启或断网会结束已有会话，重新发起邀请即可连接。

## 数据和连接边界

邀请内含 256 位随机密钥，应通过可信私聊传递。局域网邀请另含地址和临时 TLS 证书指纹。邀请有效期为十分钟，配对或拒绝后即告消耗。对端显示的设备名称是自报名称，共享端应先与对方核实请求。

信令服务按派生的房间标识转发端到端加密的握手、SDP 和 ICE 消息。它能看到连接地址、时间和传输数量。邀请密钥仅保留在两端。画面和键鼠输入走 WebRTC，加密媒体需要中继时经配置的 TURN 转发。操作系统及获授权的本机程序仍可能观察到应用运行、权限、网络活动、屏幕或输入变化。
