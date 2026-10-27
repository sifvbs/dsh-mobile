# dsh-mobile

把 **DeepSeek Harness (DSH) 的 Web GUI** 接到手机上，同 WiFi 或任意移动网络都能用。

不需要公网 IP，不需要端口映射，不需要改 DSH 源码。

两条路都端到端验证过（真浏览器 + CDP，不是 curl 猜的）：

| 场景 | 入口 | 验证判据 |
|---|---|---|
| 同 WiFi | `http://<LAN-IP>:56875/pair-accept?pair=…` | `SLOTS: 41`、`OWNS: true`、`REQ 239/239`、WebSocket 已连 |
| 异网 / 4G | `https://<随机名>.trycloudflare.com/pair-accept?pair=…` | 同上 |

---

## 一、为什么不能直接让手机连

DSH 的桌面宿主只监听 `127.0.0.1`，手机天然连不上。但"改成监听 `0.0.0.0`"这条路是堵死的：

1. `@deepseek-ai/dsh-host-webserver` 的 `Config` **显式拒绝通配地址**：

   ```
   webserver: host "0.0.0.0" is an unspecified (wildcard) address, which is not supported:
   binding every interface would expose remote code execution to the network;
   bind one concrete IPv4 or IPv6 address of a local interface instead
   ```

   所以 `@linxin666/dsh-remote-web-ui` 那个「LAN 开关」（`lanBind`，写的就是 `0.0.0.0`）在 0.2.1 之后装不上。

2. 就算绑了具体 IP，还有一整套信任栅栏：

   - `client-connection` 的 `isTrustedApiRequest` 只认 **loopback / `trustedHosts` / listener 自身绑定 IP** 三类 Host，其余一律 401/403。
   - `remote-web-ui` 的 `lanFence` 还要再叠一层：`lanAddresses` + `publicBaseUrl` 的 host + `trustedHosts`。
   - `/api/pair/issue` 需要一个 base 才肯签发（`publicBaseUrl` 或活着的 LAN base），否则回 `409 lan-required`。

3. `/` 上有 DSH 自己的浏览器鉴权（401，`dsh web authentication required`）。**正门是 `/pair-app`**：它把 loopback 的 `index.html` 抓下来、注入设备脚本再返回，不依赖 `dsh-auth` cookie。之后所有 API 走 `/remote/*` 并带 `x-dsh-remote-device`。

本仓库做的事，就是按这套规则把路铺通：

```
LAN:     手机 ──▶ <LAN-IP>:56875 ──[tcp-proxy]──▶ 127.0.0.1:<DSH>
异网:    手机 ──▶ https://x.trycloudflare.com ──▶ cloudflared
                                                  └─▶ 127.0.0.1:56998 ──[tunnel-shim]──▶ 127.0.0.1:<DSH>
```

---

## 二、前置

- Windows 10/11（脚本是 PowerShell；JS 部分跨平台）
- Node.js 18+
- DSH 桌面版，且装了 `@linxin666/dsh-web-all`（它带 `remote-web-ui`）
- `qrcode` 和 `qrcode-terminal` 两个 npm 包（DSH profile 的 `node_modules` 里通常已经有）
- 只有 tunnel 模式需要 `cloudflared.exe`

把 `cloudflared.exe` 放到本仓库的 `bin\` 下：

```
https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
```

---

## 三、配置

编辑你的 profile patch（`%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml`），在末尾追加：

```yaml
- id: web-ui-remote-web-ui        # 必须是这个 id（web-all 的 shell 行），不是 remote-web-ui
  config:
    plugin: '@linxin666/dsh-remote-web-ui'   # 缺这个键 → shell 静默 no-op，什么都不生效
    trustedHosts:
      - 192.168.1.10                          # 你的 LAN IP（无端口 = 匹配任意端口）
      - 127.0.0.1
    publicBaseUrl: https://change-me.trycloudflare.com
    requirePairingForLan: true
    enabled: true
```

两个坑，都会静默失败：

- **`id` 写错**：`@linxin666/dsh-web-all` 里这一行的 id 是 `web-ui-remote-web-ui`，写 `remote-web-ui` 不会匹配到任何行。
- **少了 `plugin` 键**：shell 的 `isOverrideShape(row)` 判定成立后直接 no-op，一行警告都没有。

改完即时热重载，不用重启 DSH。

---

## 四、用法

### 双击 `go.cmd`

```
[1] Same WiFi  (tcp-proxy)        -> pair-qr-lan.png
[2] Any network (cloudflared)     -> pair-qr-tunnel.png
[3] Both at once                  -> both
```

默认 DSH 端口是 `3080`。实际端口看 DSH Web GUI 的地址，或者：

```cmd
set DSH_PORT=58202 && go.cmd

rem 顺手改 profile 配置（推荐）
set DSH_PORT=58202 && set DSH_PROFILE=desktop && go.cmd
```

### 命令行

```powershell
# 同 WiFi
powershell -NoProfile -ExecutionPolicy Bypass -File .\pair-qr.ps1 -Mode lan -DshPort 3080 -Profile desktop

# 异网（起隧道 + 出码）
powershell -NoProfile -ExecutionPolicy Bypass -File .\pair-qr.ps1 -Mode tunnel -DshPort 3080 -Profile desktop

# 两条一起出（先起隧道，publicBaseUrl 用隧道域名）
powershell -NoProfile -ExecutionPolicy Bypass -File .\pair-qr.ps1 -Mode both -DshPort 3080 -Profile desktop
```

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `-Mode` | `lan` | `lan` / `tunnel` / `both` |
| `-DshPort` | `3080` | DSH webserver 端口 |
| `-LanPort` | `56875` | LAN 转发监听端口 |
| `-ShimPort` | `56998` | 隧道 shim 监听端口 |
| `-Ip` | 自动探测 | LAN 侧对外宣告的地址 |
| `-Node` | 自动查找 | node.exe 路径。找不到 PATH 上的 `node` 时会退到 DSH 自带的 runtime |
| `-QrcodeModule` | 自动查找 | `qrcode` 包路径 |
| `-Profile` | 空 | 传了就顺手把该 profile 的 `cordis.patch.yml` 改成正确状态（见下），并留 `.bak-dshmobile` 备份 |

**`-Profile` 会做三件事**，省掉手改 YAML：

1. 没有 `web-ui-remote-web-ui` 块就补一整块（带检测到的 LAN IP）；
2. 有块但 `trustedHosts` 里没有当前 LAN IP，就插一行；
3. 把 `publicBaseUrl` 指向本次要签发的 base。

`both` 模式下隧道先起，`publicBaseUrl` 用隧道域名；`lan` 模式用 `http://<LAN-IP>:<LanPort>`。改完等 1.2 秒热重载再签发。

**一次调用里两种模式共享同一枚配对令牌**。插件同一时刻只保留最后一枚，签两次会把先出的码顶掉——这是 `pair-qr.ps1` 里 `Get-PairToken` 缓存的原因。

### 手机上

1. 扫码 → `/pair-accept?pair=…`
2. **不用点任何东西**，自动 303 → 写一年期 `dsh_pair` cookie → 进 `/pair-app` → 主界面
3. 想加到主屏，**收藏跳转后的根路径**，不要收藏 `/pair-accept?pair=…`（令牌 10 分钟过期）
4. 想要桌面版排版：控制台执行 `sessionStorage.setItem('dsh-remote-force-desktop','1'); location.reload()`

下次重进：同域名直接开首页即可（Service Worker 会把 `/` 的导航改走 `/pair-app`，cookie 还在就自动重新配对）。

**必须重扫码的情况**：隧道重启换了域名、清了 cookie、撤销了设备、超了 `maxDevices`（默认 4）。

### 验证

```powershell
node .\scripts\verify.js --url "https://xxx.trycloudflare.com/pair-accept?pair=..."
```

跑 headless Chrome，看四件事：`SLOTS`（SPA 是否真的挂载）、`OWNS`（host grant 是否送达）、`WS`（`/remote/api/remote.mux` 是否连上）、`REQ/RESP`。**curl 只能证明服务端在，证明不了 SPA 能跑起来。**

---

## 五、两个脚本为什么存在

### `scripts/tcp-proxy.js`

纯 TCP 字节转发。**不改写任何 HTTP 头**——Host 必须原样到达 DSH，否则 `trustedHosts` 栅栏对不上。

为什么不直接改 DSH 的绑定地址：见上面第一节，`Config` 拒绝 `0.0.0.0`，而桌面宿主又是以 `127.0.0.1` 起的。

### `scripts/tunnel-shim.js`

`remote-web-ui` 的 `trustedHosts` 在 zod schema 里**不是 volatile 字段**，而且它的 `apply` 包在 `mountOnce` 里——插件已挂载时改 `cordis.patch.yml` 不会重跑 `applyImpl`，内存里仍是旧域名，于是每个新的 `trycloudflare` 域名都 403。

不重启 DSH 的唯一办法：让到达 DSH 的请求"长得像回环请求"。

1. Host 改写成 `127.0.0.1:<port>` —— `isLoopbackClient()` 要求 Host 是回环**且** `socket.remoteAddress` 也是回环，shim 从 127.0.0.1 连出，两条都满足。
2. 删掉 `Origin` / `Referer` —— `isTrustedApiRequest` 在有 Origin 时会拿它和 Host 比，Host 已被改写，不删就失配。
3. 响应的 `Location` 里 loopback 地址改写成公网 https origin，否则手机会跳 `http://127.0.0.1` 然后 `ERR_CONNECTION_REFUSED`。

**安全约束**：因为 shim 把一切都伪装成回环，`loopbackFence` 守护的桌面控制端点会被顺带放行——

```
POST /api/pair/issue    凭空签发配对令牌
POST /api/pair/stop     停掉本次配对
POST /api/pair/revoke   吊销任意设备
```

`tunnel-shim.js` 对这三条硬编码 403（`LOOPBACK_ONLY`）。**不要删掉那个检查。**

---

## 六、异网为什么选 cloudflared（踩坑记录）

这一段是特定网络环境的实测结论，换网络要重新验。

| 方案 | 结果 |
|---|---|
| localhost.run（`lhr.life`） | 通，但**限速 ~23 KB/s**。启动聚合包 9.2 MB → 6.6 分钟，页面 15s watchdog 必然 reload |
| localtunnel（`loca.lt`） | 带宽好（600 KB/s），但有**强制提示页**（手机无法加 `bypass-tunnel-reminder` 头）+ 间歇 408/503 |
| serveo.net | 明示 **252 KiB/s** 上限，10 分钟过期，免费版还有强制警告页 |
| bore.pub | npm 的 `bore-cli` 是 client+inspector，**不是** bore.pub 隧道客户端 |
| pinggy | SSH 连上后长时间无任何输出 |
| **cloudflared quick tunnel** | **9.2 MB / 3.1 s ≈ 3 MB/s**，快 130 倍 —— 采用 |

cloudflared 本身还有三个坑，`pair-qr.ps1` 都处理了：

1. **系统 DNS 拒绝解析 SRV** → `lookup argotunnel.com: dnsquery: DNS operation refused.`，edge discovery 直接失败。
   → 用 `$env:TUNNEL_EDGE` 显式给 `IP:7844`。**端口必须带**，只写 IP 会报 `missing port in address`。
2. **系统 DNS 只回 AAAA** → 新域名本机只能解析到 `2606:4700::…`，`curl` 直接 000。
   → 走 DoH（`223.5.5.5/resolve`）取 IPv4 再 `--resolve` 钉住。手机端不受影响（运营商 DNS 正常）。
3. **QUIC 会被中途掐断** → `accept stream listener error: … no recent network activity`，随后域名 530。
   → `--protocol http2 --ha-connections 4`。单连接注册成功也仍可能 530，4 条才稳。

已知限制：quick tunnel 域名**每次重启都变**，无可用性保证。掉线就重跑脚本；要固定域名得用 named tunnel（需要 Cloudflare 账号和 `tunnelToken`）。

---

## 七、文件表

| 文件 | 作用 |
|---|---|
| `go.cmd` | 双击入口，菜单三选一 |
| `pair-qr.ps1` | 两种模式的统一出码器 |
| `scripts/tcp-proxy.js` | LAN 纯 TCP 转发 |
| `scripts/tunnel-shim.js` | 隧道前置，改写 Host / Origin / Location |
| `scripts/make-pair-qr.js` | 一步签发 + 生成 PNG（给 IM 机器人用） |
| `scripts/termqr.js` | 终端二维码 |
| `scripts/verify.js` | headless Chrome 端到端验证 |
| `bin/cloudflared.exe` | 自备，见上文 |

运行期生成的：`pair-url-*.txt`、`pair-qr-*.png`、`public-host.txt`、`proxy.log`、`shim.log`、`cf.log`、`cf.err`。

### 给 IM 机器人用

如果 DSH 接了 `@michengai/dsh-im-connect`，可以让微信/钉钉会话自己发二维码：

```
node scripts/make-pair-qr.js --port <DSH> --out <会话 cwd>
```

生成的 PNG 只要落在会话 cwd 内、并且在**同一回合**用 `present` 工具声明过，IM 插件就会随回复把它发出去。

---

## 八、回滚

1. 配置：把追加的那段 `web-ui-remote-web-ui` 删掉，或恢复备份
2. 进程：`Get-Process cloudflared | Stop-Process -Force`；`tcp-proxy` / `tunnel-shim` 是 node 进程，命令行含对应文件名
3. 手机端：清该站点 cookie（`dsh_pair`），或 `POST /api/pair/revoke {"deviceId":"…"}`（**必须本机调**）

---

## 九、许可

MIT。
