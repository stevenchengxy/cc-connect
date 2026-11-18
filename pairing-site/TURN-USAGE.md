# 公共 TURN 流量与配额

管理后台的「公共中继」默认关闭。需要开启时，先为已批准的成员分别填写每期出站流量预算和并发数，再为全局配置预算、并发数，并选择「保护模式」。两台参与设备使用不同账号时，两端都需要可用额度。每份短期 TURN 凭据都携带服务端生成的账号标识 `cc-<账号 UUID>`。客户端提供的显示名称、设备名和 IP 均不参与记账。

## 供应商和时段

| Worker 绑定 | 用途 |
| --- | --- |
| `CC_CF_ACCOUNT_ID` | 实际承担费用的 Cloudflare 账号 |
| `CC_CF_ANALYTICS_TOKEN` | 限定该账号的只读 API token，需要 Account Analytics Read 读取 TURN 数据，Calls Read 核对 TURN Key 归属 |
| `CC_CF_TURN_KEY_ID` | 该账号下专用于 CC Connect 的 TURN Key ID |
| `CC_CF_TURN_API_TOKEN` | 与 TURN Key 配套的私密签发、撤销凭据 |
| `CC_TURN_BILLING_DAY` | 可选。每期开始的 UTC 日期，默认每月 1 日。允许 1–31，短月份取最后一天。应与所需的预算周期对应 |

在 Cloudflare 直接部署时，项目脚本会应用 D1 迁移、创建专用 TURN Key，并把签发 token 上传为 Worker Secret。首次成功部署后，在该 Worker 的 Settings → Variables and Secrets 补充 `CC_CF_ANALYTICS_TOKEN` 和 `CC_CF_ACCOUNT_ID`，可选的 `CC_TURN_BILLING_DAY` 也在这里设置。对这个部署脚本，用 Secret 类型可以让正常重部署保留这些额外绑定。重试曾中断的首次部署后应再核对绑定。首次管理员设置码摘要按配对服务 README 配置。GPT Sites 使用对应站点的私密 Worker 绑定；前端资源和仓库都不需要这些 token。[Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

在支持定时触发器的部署中，给这个 Worker 添加每分钟一次的 Cron Trigger `* * * * *`，并检查触发记录。项目的部署脚本不替运营方修改现有触发器。服务也会在已登录、已通过房间验证的客户端轮询时后台巡检用量并重试撤销；两种入口共用一个 D1 租约，每 60 秒最多启动一次。仅靠轮询时，没有活跃客户端的空档没有新的后台巡检。管理员手动刷新以及签发和续签都独立检查用量，已发凭据仍按自身有效期过期。[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

后台按当前周期读取 Cloudflare Analytics 的出站和入站字节。全局视图覆盖该 Cloudflare 账号所有 TURN Key。个人视图只查询一个 CC Connect 账号标识。配额按出站字节计算。成功查询返回空数据集时会标明「无记录」，读取失败则显示不可用并拒绝发放。周期查询超过供应商允许的时间窗口时，服务按完整 UTC 日期分段汇总，并保存已查询过的历史日。无法完整覆盖周期时拒绝发放。每个账号实际支持的查询跨度与保留期可以用 GraphQL 的 Settings 节点核实。[TURN Analytics](https://developers.cloudflare.com/realtime/turn/analytics/) · [查询范围](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/)

## 限额和停用

- 单账号和全局预算都使用十进制 GB，配置上限为 1,000 GB。任一范围的本期供应商出站数据达到其预算的 90%，服务即停发并尝试撤销对应凭据。预算判断保留本期见过的最高出站数。账号未获批、额度或并发数为 0、数据异常、无法检查 TURN Key 归属，均不会获得新凭据。
- 每个可用凭据最长 120 秒，到期前最后 35 秒可轮换。并发数统计持有凭据的「房间和参与端」组合。Worker 用原子写入保留名额并限制签发和查询频率。同一短期凭据在供应商端仍可能被用于多次 TURN allocation。
- 紧急停用时，将全局模式设为「关闭」。Worker 先在数据库中停发，再逐批调用提供商撤销 API。读数异常、超额、主动断开、退出登录或管理员暂停账号都会触发相应范围的撤销。供应商暂时不可达时，撤销将保留待重试状态。无法确认的凭据不会再从缓存交付。[签发、轮换和撤销](https://developers.cloudflare.com/realtime/turn/generate-credentials/)
- Cloudflare Analytics 使用自适应抽样，服务商称用量约在 30 秒后出现。统计和撤销都存在延迟，保护模式无法保证账单严格封顶为 $0 或精确停在某个字节。免费额度由同一 Cloudflare 账号中的 SFU 和 TURN 共享；此处全局数字只覆盖 TURN。若需确保本项目不产生新的公共 TURN 用量，请保持关闭并等待历史凭据全部失效。已发生的费用以供应商账单为准。[计量与抽样](https://developers.cloudflare.com/realtime/turn/replacing-existing/) · [到期和计量延迟](https://developers.cloudflare.com/realtime/turn/faq/) · [共享额度](https://developers.cloudflare.com/realtime/sfu/platform/pricing/) · [Cloudflare 支出控制适用范围](https://developers.cloudflare.com/billing/manage/spend-management/)

## 只读连通性检查

把前三个账号/只读绑定以环境变量提供给操作员终端后，可在仓库根目录执行下列命令。输出只包含 Key 归属校验结果，以及这个账号当前 TURN 数据集可查询的最大秒数和保留秒数。它不签发凭据或触发媒体流量。

```sh
node --input-type=module <<'JS'
import {verifyKeyOwner, turnQueryLimits} from './pairing-site/worker/usage-provider.js'
await verifyKeyOwner(process.env)
const {maxDuration, notOlderThan} = await turnQueryLimits(process.env)
console.log({keyOwnershipVerified: true, maxDuration, notOlderThan})
JS
```

首次生产验收还需用已批准、有配额的受控账号建立一次短会话，确认双方的实际选路和远端首帧，结束后分别读取单账号、全局计量并核对撤销结果。只读检查不能证明新发凭据已经产生可归属的转发流量。
