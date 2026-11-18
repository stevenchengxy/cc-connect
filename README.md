# CC Connect

两台电脑安装 CC Connect 并登录获批账号后，可通过一次性配对码共享屏幕和键鼠。配对使用项目的账号服务，画面通过 WebRTC 优先直连。

右上角的状态胶囊可展开查看连接详情。点「设置」可切换简体中文、繁体中文或英文、检查更新和退出账号。首次启动跟随系统语言，手动选择会保存在本机。

0.4.1 起，已批准的管理员登录桌面端后，可直接点击右上角「用户管理」创建邀请码、审批账号及查看中继用量。也可通过浏览器登录[管理后台](https://cc-connect-pair.stevenchengxy19.chatgpt.site/admin)。

## 开始连接

1. 两台电脑分别安装 CC Connect。macOS 打开 DMG，将「CC Connect」拖入「应用程序」，遇到同名应用时选择「替换」。Windows x64 运行 EXE 安装器，按提示完成当前用户安装。
2. 两端都更新至 0.4.0 或更高版本并登录。新用户向管理员获取注册邀请码，注册后等待一次账号审批，在应用内刷新状态。
3. 在被控电脑选择「共享此机」，点击「生成配对码」，将完整配对码私发给对方。它在十分钟内有效，一次会话结束后需要重新生成。
4. 在控制电脑选择「连接设备」，粘贴配对码并连接。
5. 在被控电脑核对请求设备，选择共享屏幕。默认仅观看。需要远程操作时，勾选「允许对方使用键盘和鼠标」，点击「开始共享」。
6. 控制端点击远端画面即可操作，Shift + Esc 释放键盘焦点。两端都能结束连接。被控端也可以在系统托盘或 macOS 菜单栏结束共享。

macOS 被控端首次使用时，需要在「系统设置 → 隐私与安全性」中为 CC Connect 授予屏幕录制权限。接受键鼠操作还需要辅助功能权限。更改权限后重新打开 CC Connect。若系统提示本地网络或防火墙权限，请允许 CC Connect 与受邀的电脑连接。Windows 的系统安全桌面和提升权限的窗口受系统输入权限限制。

## 画质与延迟

控制端可在连接前或会话中切换接收画质。

| 模式 | 横屏分辨率上限 | 帧率上限 | 视频码率上限 |
| --- | ---: | ---: | ---: |
| 流畅优先 | 1280 × 720 | 30 fps | 4 Mbps |
| 均衡模式（默认） | 1920 × 1080 | 60 fps | 12 Mbps |
| 清晰优先 | 2560 × 1440 | 60 fps | 22 Mbps |

这些数值是编码目标上限。实际效果取决于源屏幕、画面变化、编码硬件、被控端上行带宽和网络拥塞。一般办公从均衡模式开始。阅读小字时可试清晰优先，鼠标反馈拖延或画面频繁冻结时可切到流畅优先。会话底部按可用数据展示直连或中继、实时分辨率、帧率、码率和网络往返时间。往返时间仅衡量网络路径，点击到画面更新还要经过采集、编码、解码和显示。

画面和键鼠使用 WebRTC 加密传输。局域网与跨网配对都通过项目的 HTTPS 服务验证双方账号并交换加密信令。每次配对还使用新的邀请密钥验证握手，配对码有效期为十分钟。若两台电脑无法直接互访，TURN 可转发加密的媒体和数据。两端仍需足够的带宽。[WebRTC 连接说明](https://webrtc.org/getting-started/peer-connections) · [TURN 指南](https://webrtc.org/getting-started/turn-server) · [WebRTC 安全架构](https://www.rfc-editor.org/rfc/rfc8827.html)

## 网络和隐私

- **自动配对**。双方需联网登录已获批账号。设置留空即可生成新的配对码，旧版本的配对码需要在升级后重新生成。
- **画面传输**。跨网配对成功后，客户端通过 STUN 发现公网地址，再尝试建立加密的 WebRTC 连接。对称 NAT 或严格防火墙可能允许配对，却阻止画面直连。这类网络需要 TURN 媒体中继，或让两台电脑加入可互访的 VPN。
- **中继与账号**。管理员可为公共中继设置总额度、账号额度与并发限制，额度满足且计量服务可用时签发短期凭据。客户端也可配置自己的 TURN。账号退出、权限撤销或会话失效后会停止连接。
- **本机可见性**。共享时被控端会显示状态。应用没有 Claude 集成。具备屏幕、进程或网络观察权限的工具仍可能识别到活动。传输加密保护链路中的内容。接收方和获准读取本机屏幕的软件都可能看到显示内容。
- **凭据**。邀请包含临时密钥，请仅通过可信渠道发送给本次受邀者。配对服务可以观察连接地址、时间和流量大小。保存的 TURN 密码由操作系统凭据存储加密。当前版本共享一块屏幕，音频和跨机剪贴板未接入。

## 从源码运行

桌面端使用 Electron。构建需要 Node.js 24。Mac 端需要 Xcode Command Line Tools，Windows x64 端需要 .NET Framework 4.x 自带的 C# 编译器。项目内有两个系统的原生键鼠组件源码。

```sh
npm ci
npm start
```

Mac 上运行 `npm run dist:mac` 生成 Apple Silicon 和 Intel 通用 DMG。Windows x64 上运行 `npm run dist:win` 生成 NSIS EXE 安装器。构建产物位于 `release/<版本号>/`。当前 Mac 包为本地临时签名，未经过 Apple 公证。Windows 包未进行 Authenticode 签名。

## 验证

`npm test` 检查直接配对、证书指纹、邀请密钥、同意与拒绝、WSS 转发以及凭据持久化。`npm run test:desktop` 需要图形桌面环境和支持 node:sqlite 的 Node.js 版本。它使用本机临时数据库注册、审批两个账号，并启动两个带独立临时配置的 Electron 实例，用合成动画窗口验证配对、拒绝后重新连接、默认仅观看、实际视频解码、传输统计与停用账号后双端断开。可选的 `node scripts/verify-desktop.cjs --loopback-relay` 使用本机已有的 `coturn/coturn:4-alpine` Docker 镜像，验证中继凭据续签和限额拒绝。该测试不会采集用户桌面或向系统注入键鼠。

0.3.1 的异网测试在一台 Mac 和独立的 Ubuntu 云主机之间完成了公网配对与授权。两端未配置 TURN，未收到视频帧。另在双 NAT 模拟和强制 TURN 的隔离测试中收到了合成画面。[异网测试记录](https://github.com/stevenchengxy/cc-connect/actions/runs/44282060543)

在这台 Mac 上，还验证了控制通道的鼠标坐标、按键收发、仅观看时的输入隔离和画质切换。Windows 实机键鼠、真实双机跨公网吞吐和延迟仍需在目标设备上验收。

## 更新

在 0.4.1 中，从「设置」打开「软件更新」即可检查、下载并安装新版本。0.3.0 到 0.4.0 的入口在右上角「更新」。下载时显示进度，下载完成后由你点击「安装更新」。安装前需要结束远程会话。

macOS 应安装在 `/Applications/CC Connect.app` 或用户的 `~/Applications/CC Connect.app`。应用内更新会验证下载内容与应用包，关闭现有进程后替换应用并重新打开。也可下载 DMG，通过 Finder 的同名项目提示选择「替换」。

Windows 安装器使用固定的当前用户安装位置。后续 EXE 安装器会更新已注册的旧版安装。早期 ZIP 便携版所在的解压文件夹需要自行管理，安装器升级针对已注册安装。

更新清单使用 Ed25519 签名，客户端校验内置公钥、版本与文件 SHA-256 后安装。发布私钥保存在仓库之外。发布工具 `scripts/sign-release.cjs` 负责为新版本生成签名清单，私钥与凭据应保留在发布环境中。

## 下载与源码

下载网页使用 GPT Sites 托管，页面提供 macOS 和 Windows 安装包以及 GitHub 源码入口。安装包随 GitHub Release 发布，更新清单与网站一同发布。[下载 CC Connect](https://cc-connect-desktop.stevenchengxy19.chatgpt.site/) · [GitHub 源码与发行版](https://github.com/stevenchengxy/cc-connect)

本项目采用 MIT 许可证。下载页面源文件位于 `website/`。

### 发布新版本

1. 更新 `package.json`、锁文件和下载页中的版本号，运行 `npm test` 与 `npm run test:desktop`。
2. 在具备原生构建工具的对应系统运行 `npm run dist:mac` / `npm run dist:win`，汇总两个安装包到 `release/<版本号>/`。
3. 使用发布环境的私钥运行 `npm run release:manifest`。默认密钥位置为 `~/.config/cc-connect-release/signing-key.pem`，也可用 `CC_CONNECT_SIGNING_KEY` 指定。公钥必须与 `src/update-public-key.pem` 匹配。备份私钥；不要将它提交或上传到公开下载位置。
4. 将安装包、`SHA256SUMS.txt` 与 `latest.json` 发布到 GitHub 对应的 `v<版本号>` Release，再将 `website/dist/`（包括生成的 `updates/latest.json`）发布到下载站点。已发布版本的安装包应保持不可变；修复请递增版本号。

自行分发的 fork 应生成自己的 Ed25519 密钥对，并修改 `src/updater.cjs` 和发布脚本里的更新站点与 GitHub 仓库地址。主项目客户端只信任主项目的公钥与下载来源。

Windows 的真实系统升级替换和真实双机公网性能仍需目标设备验收。自动化更新验证使用隔离环境与合成响应。
