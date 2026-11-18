# 托管配对服务

Worker 用 D1 暂存房间和加密信令。共享端与控制端都须登录已经批准的账号，再用一次性设备邀请注册各自的角色。每次连接都需要共享端在本机确认。账号登录最长有效七天，房间等待加入的期限为十分钟，配对后的房间最长有效十二小时。正常关闭后，另一端有九十秒可读取已发出的断开消息。退出登录、暂停账号或撤销登录后，服务会立即停止该房间的信令，并通知中继模块撤销相关凭据。客户端须持续检查房间，以便另一端掉线或授权终止时关闭媒体。

信令按方向连续编号。接收方完整获取第 N 条后再请求 N+1，服务端才释放已返回的第 N 条密文，重复请求 N 可恢复丢失的响应。已消费消息的摘要保留至房间过期，用于判断重复写入是否相同。每个方向最多暂存 512 条未消费消息，密文与摘要合计上限为 2 MiB。每个方向允许初始 512 条写入，后续每分钟增加 32 条额度，单次会话累计上限为 16,384 条。

使用 GPT Sites 时，在 `.openai/hosting.json` 中保留项目 ID，并设置 `"d1": "DB"`。运行 `npm run build` 后，将构建产物连同 `drizzle/` 迁移发布。公开的 `GET /health` 可检查数据库是否已有账号表。

## 首次设置管理员

1. 在维护者的电脑上，从仓库根目录运行以下命令。选择密码管理器可以接管的私有目录，目标文件应位于仓库、云同步和公开下载目录之外。

   ```sh
   node pairing-site/scripts/bootstrap.mjs "$HOME/.cc-connect-first-admin"
   ```

2. 命令会将 32 字节随机设置码写入仅当前用户可读的新文件，并在终端输出 `CC_ADMIN_BOOTSTRAP_SHA256` 值。将这个摘要写入生产 Worker 的同名 secret binding，然后发布新的服务版本。设置码原文仅交给首次创建管理员的人。
3. 将下例中的域名替换为自己已验证的 HTTPS 服务，选择管理员用户名。命令从私有文件读取一次性设置码，并在本机终端隐藏输入两次新密码。密码管理器也可以经私有管道向命令提供密码，此时在末尾加 `--password-stdin`。

   ```sh
   node pairing-site/scripts/bootstrap.mjs setup https://your-worker.example.com "$HOME/.cc-connect-first-admin" supervisor
   ```

   创建成功后，打开 `/admin` 登录，移除 Worker 的摘要绑定，删除本地的设置码文件，并将登录凭据保存到密码管理器。设置码在管理员已创建的数据库上永久失效。
4. 管理员创建 8 位、二十四小时有效、单次使用的注册邀请码，使用私有渠道交给成员。0.4.4 起，成员可输入小写字母或省略分组横线；旧的 43 位邀请码在其有效期内继续可用。成员选择用户名和密码，管理员在账号列表批准。批准一次即可发起或接受后续设备邀请，每次共享仍由共享端确认。

管理员可以暂停账号，之后通过重新批准恢复使用。撤销是永久操作。撤销登录会话则让账号在所有设备上重新登录。暂停或撤销同时使既有房间失效，两端都要重新配对。管理员账号不能通过成员状态接口降权或停用。旧客户端和迁移前的房间没有登录绑定，不能获取项目中继或建立新的托管连接。

账号名大小写不敏感，支持 3 至 40 位 ASCII 字母、数字及 `_.-`，首位使用字母或数字。密码长度为 12 至 128 个 UTF-16 单位。服务只存带随机盐的密码校验值、会话令牌摘要和账号状态。登录限流同时使用服务平台确认的来源和用户名短时摘要。会话令牌、邀请原文、设置码和密码请勿放入请求日志。

## 跨网中继

新服务的公共 TURN 默认关闭。维护者可以在管理页设置中继策略及配额，并在服务端检查计量凭据。参见[公共 TURN 流量与配额](./TURN-USAGE.md)。

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
