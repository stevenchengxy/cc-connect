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
