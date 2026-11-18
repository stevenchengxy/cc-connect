# 托管配对服务

这个 Worker 用 D1 暂存一次性房间和加密信令。申请共享后，两台设备凭邀请各自注册一个角色。客户端在共享端同意后建立 WebRTC 连接。Worker 能确认角色已经注册，共享确认由客户端执行。房间初始有效期为 10 分钟，双方注册后的最长期限为 12 小时。关闭后保留最多 90 秒，供对端取走已发送的断开消息。服务拒绝读取过期房间，每次注册新房间时分批清理过期记录。

使用 GPT Sites 发布时，在 `.openai/hosting.json` 中保留项目 ID，设置 `"d1": "DB"`。运行 `node scripts/build.mjs` 构建 Worker，随部署一起打包 `drizzle/` 迁移。`GET /health` 可验证数据库绑定和迁移是否就绪。

## 给受限网络启用 TURN

配对服务的维护者需要一台可访问的公网 TURN 服务器及足够的带宽。以下配置在服务器和 Worker 各做一次。桌面端使用默认公网配对时自动获取短期凭据。

1. 在 coturn 配置文件中设置以下参数。将域名改为自己的，使用密码管理器生成至少 32 字符的随机值替换占位符，限制配置文件的读取权限。`use-auth-secret` 使用 TURN REST 凭据，并取代固定 `user=` 方式。保留服务器适用的监听地址、NAT 映射、转发端口范围、内网禁转规则和访问限额。仓库 `relay/` 中的固定账号示例供自建信令模式使用。

   ```ini
   realm=turn.example.com
   use-auth-secret
   static-auth-secret=<运营者生成的随机值>
   fingerprint
   user-quota=8
   total-quota=64
   ```

2. 为 UDP/TCP 3478 和 UDP 转发端口范围配置防火墙。如果需要覆盖只允许 TLS 出站的网络，为 coturn 配置可验证的证书和对应 TLS 端口。可用独立 IP 的 TCP 443 承载 `turns`。只有 TLS 监听已通过验证时才发布该地址。
3. 在配对 Worker 的运行时设置中添加 `CC_TURN_SECRET`，设为 coturn 的同一随机值。将 `CC_TURN_URLS` 设置为服务端实际监听的地址数组，例如 `["turn:turn.example.com:3478?transport=udp","turn:turn.example.com:3478?transport=tcp"]`。按 Sites 工作流重新发布。请将密钥保存在服务端运行时配置中。
4. 在不同网络上运行两台客户端，以 TURN-only 测试确认双方收到 `relay` 候选、已选候选对并持续解码画面。服务商的带宽和配额按其实际限制生效。

客户端在两个角色都已注册的有效房间中使用 `GET /v1/rooms/{房间}/{角色}/ice` 及该角色的 bearer 获取凭据。凭据最长有效 60 分钟，且不超过房间到期时间。服务没有接入 TURN 时返回 204。已签发的凭据在到期前由 coturn 单独验证。长时间会话如果需要重新分配中继，应重新取得有效凭据。

[coturn TURN REST API 文档](https://github.com/coturn/coturn/blob/master/README.turnserver)

## 使用 Cloudflare Realtime TURN

维护者也可以使用 Cloudflare 的托管中继，免去自建公网 TURN 主机。

1. 在自己的 Cloudflare 账户中创建 Realtime TURN Key。检查该账户的带宽额度、计费和用量告警。这个公开配对服务允许持有邀请的一对客户端获取中继凭据，使用量计入维护者的 Cloudflare 账户。
2. 在配对 Worker 的运行时设置中配置 `CC_CF_TURN_KEY_ID` 和 `CC_CF_TURN_API_TOKEN`，值分别来自该 TURN Key 的 ID 和 API Token。保留其中一种提供商配置。使用 Cloudflare 时清空 `CC_TURN_URLS` 和 `CC_TURN_SECRET`。
3. 发布数据库迁移与 Worker。两个角色注册后，应用可通过相同的 `/ice` 接口取得有时限的 Cloudflare 凭据。每个角色复用自己的有效凭据，并发请求共用签发锁。服务端在 D1 缓存短期凭据，房间清理时删除。长期 API Token 仅用于 Worker 调用 Cloudflare 的固定 HTTPS 接口。
4. 使用两个不同网络的设备进行 TURN-only 的画面传输验收，并在供应商控制台核对用量。

[Cloudflare 官方凭据文档](https://developers.cloudflare.com/realtime/turn/generate-credentials/)

## 部署到自己的 Cloudflare 账户

当下载站的边缘防护拦截桌面 API 时，可以把同一个配对 Worker 独立部署到专用 `workers.dev` 名称。部署命令会创建项目专用的 Worker、D1 数据库和 Realtime TURN Key，并启用公网端点。视频中继流量按该 Cloudflare 账户的实际额度计费。

1. 在自己的 Cloudflare 账户中选择 `workers.dev` 子域名。为这个账户创建 API Token，授予 Workers Scripts Edit、D1 Edit 和 Calls Write。将账户 ID 和 Token 通过本机的密钥管理器注入 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` 环境变量。请勿将其发到聊天、命令行参数或仓库。
2. 从仓库根目录运行以下命令。最后一个参数为专用服务名，已有其他项目占用时请换名。脚本使用 Node 24 内置的 HTTPS 与 Cloudflare API。

   ```sh
   node pairing-site/deploy-cloudflare.cjs --apply cc-connect-pair
   ```

3. 使用命令输出的域名请求 `GET /health`，确认返回 JSON、`service=cc-connect-pair` 和 `protocol=1`。将桌面应用的托管服务地址设置为这个域名的 `/v1`，重新构建和发布。两台客户端都升级后重新生成邀请。在一对临时测试设备上确认两个角色注册后 `/ice` 返回有效中继地址，最后在真实的不同网络上检查 TURN-only 画面和所选候选对。公开 API 需要允许正常桌面客户端访问。

脚本检查远端所有权标记和资源 ID。再次使用相同账户及服务名运行，会复用现有 D1 和 TURN Key，核对已应用 SQL 的哈希并应用新增迁移。部署记录保存在 `~/.config/cc-connect-cloudflare/<账户>/<服务名>/deployment.json`，请备份此记录，避免多个运维环境并发修改同一服务。当供应商首次返回 TURN 密钥时，脚本先将其写入仅当前用户可读的恢复记录，再通过 HTTPS 写入 Worker 的 secret binding。确认写入后，脚本从恢复记录中移除该密钥；账户 API Token 始终只在进程内使用。

若过程被中断，使用同一部署记录重试。如果 `deploy.lock` 残留，先确认本机没有部署进程，再移除对应记录目录下的锁文件。若 TURN Key 已经创建但生成响应中途丢失，请在账户中核实专用 Key 并恢复其凭据；脚本遇到这种情况会停止。长期密钥不会随重试自动轮换。

[Cloudflare Worker 上传格式](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/) · [D1 查询和批处理](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/) · [Realtime TURN Key API](https://developers.cloudflare.com/api/resources/calls/subresources/turn/methods/create/)
