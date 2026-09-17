# C2C 优化方案（基于上游 XiaoDuoYa 基座）

> 依据：2026-09-16 首次配对会话复盘（`.workbuddy/reports/2026-09-16-codex-session-binding-analysis.md`）
> 与上游代码审查（`/tmp/c2c-upstream`，6,149 行 vs 我们 19,500 行）。
> 本文档 = 对比结论 + 可执行改动清单 + 验收标准。**多项目多会话的机器级架构不动。**

## 0. 影响优先级的事实（先说结论）

| # | 事实 | 影响 |
|---|---|---|
| 1 | **通道方案由用户自选，项目不绑定任何 provider**（用户 2026-09-17 明确）。本机现状：**cloudflared**；**本项目不再使用 ngrok** | P0 的目标是**通道无关**，不是「支持某两根管道」。ngrok / cloudflared 只能作为**建议内置**，必须保留「用户自己搭、我们只认 URL」的出口 |
| 2 | 用户**可能还有别的通道方案**（不止这两家） | 接口必须**通用**：任何「能把公网 URL 映射到本机端口」的东西都要能接入，包括一条**自定义命令** |
| 3 | `grep -rn ngrok src/` 只命中**注释**——我们**没有任何隧道代码**，隧道一直靠外部工具 + 手工 LaunchAgent 在跑 | 「接一个 provider」是从零实现 + 接管进程托管，成本远大于估算。**正因如此，「不接」才是默认，托管只能是可选增强** |
| 4 | 上次会话 156 分钟里，「连接器配置」的痛点是**手工贴 109 字符带令牌 URL**；`machine auth rotate` 后必须去 ChatGPT 改 URL 才能恢复 | 这才是**真正的流畅度瓶颈**。它与通道选型**正交**，由 OAuth + 配对码消除，不能指望换通道解决 |
| 5 | `arumwu/local-workspace-mcp` 用 **OpenAI 官方 Secure MCP Tunnel** 跑通普通 ChatGPT 对话（2026-09-17 验证） | 第三条路：**无需公网 URL、无需令牌、无需 OAuth**；本机 `tunnel-client doctor` 仍 RESULT ok，配置密钥俱在 |
| 6 | 官方通道控制面是 `api.openai.com`，本机 **DNS 被污染** + **SNI 阻断**；用户实测 ChatGPT 无法访问本地服务 | **闸门 A 结论：本机不可用**，归档待网络条件改善（详见该节两层故障分析） |
| 7 | 不同通道的进程环境要求**可能相反**：ngrok 有代理变量就拒绝启动（`ERR_NGROK_9009`），tunnel-client 没代理就控制面无出网 | 若由 c2c 托管，必须**按 provider 隔离环境变量**——这也正是「**托管不该是默认**」的有力理由 |
| 8 | 我们历史上**实现过**官方通道（`src/tunnel/`、`openai-secure-tunnel` 76 测试、`tunnel-env.ts`），后随传输层改造删除 | 「重建」而非「从零」；历史代码与测试可作重建起点 |
| 9 | c2c 长期占用 ngrok 静态域 `unprohibited-oversilently-hugh`，而该域名在 `~/…/ngrok/ngrok.yml` 里是**声明给 token-radar 项目**的（upstream 指向 3000 端口，traffic policy 也在那边） | c2c 退出 ngrok 后应**把该域名还给 token-radar**。这是**清理项，不是可选**——否则两个项目永远在互抢同一个域名 |

**结论（第四版，按「通道由用户自选」修正）：P0 从「支持两条隧道」改为「通道无关化」。**

```
闸门 A（官方 Secure MCP Tunnel）→ 已判定：本机 SNI 阻断，不可用（归档）
P0 通道无关化 —— provider 由用户自选；ngrok / cloudflared 仅作「建议内置」
    本机现状：cloudflared（ingress 已配好、链路已端到端验证）；ngrok 待退役并交还域名
    待人工：launch agent 加载（或下次登录自动生效）+ 一条 DNS 记录
P1 OAuth 2.1 + 配对码 → 降级为「可选」：URL 令牌对性能无影响，当前配置更省事（用户决策）
P2 端点一致性自检 + 连接器 URL 修复 ← 与通道无关，任何 provider 都需要
P3 文档 / skill / 迁移指引
```

## 一、规模与架构差异（背景）

| | 上游 XiaoDuoYa | 本 fork (peak-xiong) |
|---|---|---|
| src 规模 | 6,149 行 | 19,500 行（3.2 倍） |
| 进程模型 | 每 workspace 一个 bridge 进程 | 一台机器一个 gateway，注册多个 workspace |
| 身份/授权 | OAuth token 绑 workspaceId | 机器身份 + turn capability + context_id |
| 会话模型 | 一 workspace 一 Project 一 Chat（README 明示老用户停在 one-conversation style） | 多 workspace × 多 local session × surface lease + mailbox 控制协议 |
| 公网隧道 | **内置**：Cloudflare Quick（默认）/ Named（稳定域名），`C2C_TUNNEL_PROTOCOL=http2` 降级，由 `c2c setup` 一并托管 | **外部托管、代码零实现**：曾用 ngrok 静态域名，现用 cloudflared，都靠手工 LaunchAgent。**本 fork 的方向是通道无关**（上游将通道内置，代价是绑定 provider） |
| 传输鉴权 | OAuth 2.1（PKCE S256 + DCR + refresh 轮换）+ 一次性配对码 | 静态 bearer（头/URL 双通道，commit `0711446`） |
| 安装体验 | 一条 `c2c setup`（bridge+tunnel+配对码） | `machine setup` + 手工拼 109 字符带令牌 URL 贴进 ChatGPT |

多项目多对话的全部增量（surface lease / mailbox / connector binding / machine registry）都在本 fork 且是需求，**不回移**。

## P0 · 通道无关化（provider 由用户自选，c2c 不绑定隧道）

> **设计目标（第四版，2026-09-17 用户纠正后）**：c2c 只依赖一个契约——
> **「存在一条能把外部请求送到 `127.0.0.1:<localPort>` 的公网 URL」**。
> 至于这条 URL 是 ngrok、cloudflared、Tailscale Funnel、frp、自建反代，还是 OpenAI 官方通道，
> **由用户决定**，c2c 不假设、不偏好、不强制。
>
> 上一版把「ngrok + cloudflared 都要支持」写成了项目约束，那是错的：
> 那等于把**用户的选型自由**收窄成**我们要维护的两根管道**，还得替用户承担两个 provider 的
> 版本漂移、环境差异（见事实 7：代理需求相反）和进程托管。**本项目不再使用 ngrok。**

### 本机现状（cloudflared 已就绪，仅剩两步人工）

| 步骤 | 状态 | 依据 |
|---|---|---|
| cloudflared 安装 + 用户级 launch agent | ✅ 已装 | plist 用 `--token-file` 指向 600 权限令牌文件 |
| 令牌有效性 | ✅ 有效 | 实测启动：`/ready=200`、`cloudflared_tunnel_ha_connections 4`（lax07/sjc07 各 2） |
| 本机到 CF 边缘的连通性 | ✅ 全 PASS | 预检 7 项全 PASS，含 `api.cloudflare.com:443`（**对照：`api.openai.com` 被 SNI 阻断**） |
| 隧道 ingress 规则 | ✅ 已写入（version 1） | 见下方「无需 dashboard 的 provisioning 路径」 |
| **链路端到端可用性** | ✅ **已验证** | quick tunnel 实测 `/health` 200、无令牌 401、带令牌 `tools/list` **200 / 9 工具** |
| launch agent 加载 | ⏳ 待操作者执行 | 会话内 `bootstrap`/`load -w` 均返回 EIO；**或等下次登录自动生效** |
| DNS 记录 | ⏳ 用户选择自己在 dashboard 加 | 我方未触碰 DNS |
| **ngrok 退役 + 域名交还 token-radar** | ⏳ CF 通后执行 | 停并删 `com.ngrok.tunnel.plist`（手工文件，无自动化提醒，易漏） |

### 分层：谁负责什么

| 层 | 归属 | 内容 |
|---|---|---|
| **契约层**（必须有） | **c2c 核心** | 一句声明 + 一个探针：已声明的公网 URL 是否真的到达本机网关。这是**通道无关**的，任何 provider 都适用 |
| **便捷层**（可选） | 内置适配器 | 给常见 provider 提供「一条命令起好」的糖。**默认关闭**，用户显式选择才启用 |
| **逃生层**（必须有） | 用户 | 完全自己搭通道，只把 URL 告诉 c2c。这是**保证不被绑架**的那条路，必须永远可用 |

**这个分层是本次纠正的实质**：上一版只有便捷层做得很好，而契约层和逃生层是缺的。

### 接口设计

- **核心抽象**（照搬上游 `src/tunnel/provider.ts` 的形状，但**只保留契约必需的部分**）：
  `status()` / `getPublicUrl()` / `doctor()` —— 这三个是**任何通道**都必须能回答的。
  `start/stop/restart(localPort)` 属于**便捷层**，放在可选接口后面，不让核心依赖它。
- **三种接入方式**，用户在配置里选一种，**默认是第三种**：
  1. `ngrok`（**建议内置，非默认**）——封装现有 `com.ngrok.tunnel.plist` 的参数形态。
  2. `cloudflared`（**建议内置，非默认**）——移植上游 `cloudflared.ts` / `cloudflared-named.ts` /
     `named-provision.ts` / `protocol.ts`（`C2C_TUNNEL_PROTOCOL=auto|quic|http2`）。
  3. `external`（**默认，逃生层**）——`c2c` 不碰任何隧道进程，只读用户声明的公网 URL 做自检。
     用户还能给一条**自定义命令**（`tunnel.command`）让 c2c 代为执行 `status`/`start`，
     从而接入**任意** provider 而不需要为它写代码。
- **选择与观测**：`c2c machine tunnel use <ngrok|cloudflared|external>` /
  `machine tunnel status --json`；`machine doctor` 报告**当前 provider** 与
  「URL 是否与 `http/endpoint.json` 一致」「该 URL 是否真能到达网关」。
- **不做的事**：不内置默认 provider、不在 `machine setup` 里偷偷装隧道、不因为某个 provider
  更流行就把它设成默认。**选型是用户的决策，c2c 只负责把状态和差异讲清楚。**

### 给用户的通道选择建议（这是「建议」，不是「方案」）

选型只需回答一个问题：**这条公网 URL 会不会变？** 因为连接器指着它，变了就要去 ChatGPT 改。

| | 公网 URL 稳定性 | 前置条件 | 实测延迟中位数 | 我们的建议 |
|---|---|---|---|---|
| **cloudflared Named**（本机现用） | 固定自有域名 ✅ | CF 账号 + 已托管域名 | ≈1057 / 1172 ms | **推荐长期使用** |
| cloudflared Quick | 每次重启换域名 ❌ | 无 | 同上（同一套边缘） | **只用于本机联调**，不要给连接器用 |
| ngrok 静态域名 | 固定 ✅ | 无 | 743 / 854 ms | 可用；但**本项目已退出**，且与 token-radar 争域名 |
| 任意自建（frp / Tailscale Funnel / 反代…） | 取决于你 | 取决于你 | 取决于你 | 走 `external` / `tunnel.command` 接入，**c2c 全力支持** |

> 延迟口径警告：上表是「本机→边缘→本机」测出来的，跨太平洋那段**走了两遍**；
> ChatGPT 的真实路径只走**一遍**。所以这只用于**横向比较**，不代表用户体感。
> 详细数据与警告见下方「实测数据」。

> 上游把通道内置于 `c2c setup`，好处是开箱即用，代价是**绑定 provider**：
> 上游代码里 `cloudflared` 是一等公民，换通道要改代码。我们选择相反的方向——
> **开箱可用性靠契约层（自检 + 清晰报错）来弥补，而不是靠内置实现**。
> 这是一个刻意的取舍，不是遗漏。

### 连接器 URL 变更的三种解法（覆盖任何 provider）

1. **不让它变**：Named Tunnel 固定自有域名（首选）。
2. **自动修复**：URL 漂移时自动删旧连接器、用新 URL 重建（上游的修复循环，靠 CUA 操作 ChatGPT 页面）。
3. **人工提示**：`machine setup` / `doctor` 检测到「实际公网 URL ≠ 已记录 endpoint」时，
   输出一条明确动作（现在这一步全靠人记得手工 `machine endpoint set`）。
   → P2 做这个，是 1、2 的必要补充。

> 重要更正：**OAuth 解决的是「令牌轮换不用改连接器」，它不解决「URL 变了要改连接器」。**
> URL 漂移只能靠上面三条，与通道选型无关。

**用户决策（2026-09-17）**：
- P1（OAuth/配对码）**降级为可选**——理由：URL 携带令牌对**性能零影响**，且当前配置方式更省事；
  用户优先级是**性能**而非凭据形式。
- 通道**由用户自选**，本项目**不再使用 ngrok**，本机**现在使用 cloudflared**；
  ngrok 与 cloudflared 只作为**给用户的建议**存在，用户也可能改用别的通道方案。

### 本轮实测证据（支撑上面的状态表）

#### launch agent 的加载限制（已二次确认，非配置问题）

| 命令 | 结果 |
|---|---|
| `launchctl bootstrap gui/501 <plist>` | `Bootstrap failed: 5: Input/output error` |
| `launchctl load -w <plist>`（legacy 路径，本次新测） | `Load failed: 5: Input/output error` |

两条路径都失败 → 确认是**会话层限制**，与 c2c `autostart` 同一根因，不是 plist 内容问题。
**但用户无需做任何事也能自愈**：`~/Library/LaunchAgents/` 下的 plist 带 `RunAtLoad`，
**下次登录/重启会自动加载**。想立刻生效才需要在自己的终端跑一条 `bootstrap`。

补充：`cloudflared service install` **自己报成功但不校验 bootstrap 结果**——这是一个产品缺口，
与 c2c `autostart enable` 那个「改配置失败会退化成服务下线」的坑同类。

#### 无需 dashboard 的 provisioning 路径（新发现，供 P0 实现参考）

现状是「手工写 plist + 去 dashboard 配 hostname」，理想形态是 `c2c machine tunnel use cloudflared`
自己把隧道建起来并把 DNS/ingress 配好。可行路径已实测：

1. 凭据来源二选一：`cloudflared tunnel login` 产出的 `cert.pem`（zone 级 API 令牌，**本机已有**），
   或 dashboard 建隧道给出的 token（当前 `c2c-mac` 走的是这条）。
2. 两条 API 调用即可完成：
   - `POST /zones/{zone_id}/dns_records` → `<名字>.terracecapital.xyz` 的 proxied CNAME 指向
     `<tunnel_id>.cfargotunnel.com`（等价于 `cloudflared tunnel route dns <name> <hostname>`）；
   - `PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations`
     body = `{"config":{"ingress":[{"hostname":"…","service":"http://127.0.0.1:48765"},{"service":"http_status:404"}]}}`。
3. **幂等性**：`configurations` 有 `version` 字段（本次写入后 0 → 1），PUT 是覆盖语义，
   适合做「声明式期望状态」的对齐；`doctor` 可读回比对，天然满足 P2 的一致性自检。

> 我这次的 ingress 写成了「一条具名 + 一条**无 hostname 兜底**」，因此**任何**指向该隧道的
> 主机名都能抵达网关——这样用户选什么名字都不会因为 ingress 不匹配而 503/404。

#### 实测数据：CF vs ngrok（同一台机器、同一时刻、交替采样）

方法：从本机直连（**绕过会话代理**）交替打两个公网端点，各 12 次、扣掉 2 次预热，取 10 个样本。

| 目标 | 中位数 | 最小 | p90 | 状态码 |
|---|---|---|---|---|
| `GET /health`（CF quick） | 1057 ms | 743 ms | 1846 ms | 200 |
| `GET /health`（ngrok） | 743 ms | 583 ms | 1521 ms | 200 |
| `MCP tools/list`（CF quick） | 1172 ms | 731 ms | 1910 ms | 200 |
| `MCP tools/list`（ngrok） | 854 ms | 615 ms | 2221 ms | 200 |

**怎么读这个表（别过度解读）**：

- 两者**都能用**，功能与鉴权行为完全一致（401 / 200 / 9 工具），**没有协议层面的差异**。
- CF 中位数约慢 **300–400 ms**，但 **p90 在 tools/list 上反而更好**（1910 vs 2221）
  → 差异更像**边缘 POP 选择**与瞬时抖动，不是隧道机制本身的优劣。
- **关键警告：这个测量口径不是 ChatGPT 的真实路径。** 从本机发起的请求走的是
  「本机 → 边缘 → 本机」，等于把跨太平洋那一段**走了两遍**；而 ChatGPT 的请求是
  「OpenAI 侧 → 就近边缘 → 隧道 → 本机」，只有**一遍**。所以本表**高估了 CF 的代价**，
  只能当方向性参考。**真实结论只能由 ChatGPT 侧观测得出。**
- quick tunnel 与 named tunnel 走同一套边缘，但 quick 有额外限制，故本表对 named 也只是近似。

#### 诊断方法论（可复用）

- **用一次性 quick tunnel 验证链路**：`cloudflared tunnel --url http://127.0.0.1:48765`
  可以在**不碰用户账号、不建任何 DNS 记录**的前提下，验证「CF 边缘 → 本机网关」是否通。
  这把「链路问题」与「DNS/配置问题」干净地分开了——本轮正是靠它提前确认了 CF 路线可行，
  否则要等到用户配完 DNS 才知道。
- **隧道日志不能证明请求到达**。唯一可信的验收是**从外部真实打一次**：
  `/health` → 200、受保护端点无凭据 → 401、带凭据 `tools/list` → 200 + 工具数。
- 没有 ingress 时 cloudflared 会明确警告 `No ingress rules ... will return 503`——
  「所有请求 503」基本就是这条，不是网络问题。
- 会话环境有两个探测陷阱会让结论跑偏（详见 `.workbuddy/memory/2026-09-17.md`）：
  ① 会话自带 `HTTP_PROXY`，`curl 127.0.0.1:<未监听端口>` 会被代理伪造成 **502**
     （必须 `--noproxy '*'`）；② `ps` 被禁用，用 `ps -p` 判进程死活会得到**假阴性**。

#### c2c 长期占用了 token-radar 的 ngrok 域名（退出后需交还）

`~/Library/Application Support/ngrok/ngrok.yml` 里声明了一个名为 `token-radar-dev` 的 endpoint：
`url` 是 `unprohibited-oversilently-hugh.ngrok-free.dev`，upstream 指向 `127.0.0.1:3000`，
traffic policy 在 `~/Documents/crush/.local/ngrok-token-radar-policy.yml`。
**这个静态域名是 token-radar 项目的资产，不是 c2c 的。**

而 c2c 的 launch agent 一直用 `--url=<同一域名>` 把它指向 `48765`。实测该域名当前
`/health` 返回 `c2c-bridge`、`/__nope__` 返回 404 → **c2c 是现占用者**，token-radar 那条声明在休眠。
**同一个静态域名只能被一个 endpoint 占用**，一旦 token-radar 启动就互抢，表现为随机 502/404。

→ c2c 退出 ngrok 后**必须把这个域名交还**：`launchctl bootout gui/$(id -u)/com.ngrok.tunnel`
并删除 `~/Library/LaunchAgents/com.ngrok.tunnel.plist`。
注意这个 plist 是**手工文件、不在代码里**，没有自动化会提醒你——容易忘，要显式列为迁移收尾项。

## 闸门 A · 官方 Secure MCP Tunnel —— **结论：本机不可用（SNI 阻断）**

`arumwu/local-workspace-mcp` 2026-09-17 在普通 ChatGPT 对话里跑通了这条路，配置方式是
**「连接 = 通道 + 验证 = 无验证」**（通道本身由 OpenAI 账号/工作区 + runtime key 鉴权）。
收益极大：没有公网 URL、没有令牌、没有 URL 漂移、不需要 OAuth、不需要 ngrok/Cloudflare。

**但本机实测结论是否定的**：使用时出现 **SNI 层阻断**，ChatGPT 无法访问本地服务
（用户实测反馈，与 `docs/issue-log.md` 记录一致）。

### 故障的两层结构（必须分清，否则会误判）

| 层 | 现象 | 判据 | 现状 |
|---|---|---|---|
| **L1 控制面无出网** | 隧道建立不了会话 → ChatGPT 根本没有通道可用 | 隧道日志 `dial tcp ...: i/o timeout` / `poll timed out`；`api.openai.com` 解析进 `199.59.149.207`（Twitter 网段，DNS 污染）+ **SNI 被拦** | **卡在这一层**。历史上有过修复：让隧道进程继承代理后，控制面 5 小时零 WARN/ERROR |
| **L2 端到端未验收** | 控制面正常，但 ChatGPT 的调用没抵达 MCP 服务 | 唯一标志：隧道日志出现 `forwarded command to MCP server`（历史出现 **0 次**） | 从未达成，无法判定 L2 是否本来就能通 |

关键：**L1 的解法历史上已经找到过**——隧道进程必须继承可用代理（`HTTP_PROXY`/`HTTPS_PROXY`，
即已删除的 `src/config/tunnel-env.ts` 的职责），因为走代理时 `api.openai.com` 可通（`http=401`）。
问题是这个解法**很脆**：本机代理是 Clash Verge 的动态端口（当前 `127.0.0.1:33331`，
沙箱里实测连不上），端口一变 plist 就失效 → 隧道静默失联。

### 一个被忽略的冲突：两个 provider 的代理需求相反

| provider | 代理要求 | 依据 |
|---|---|---|
| ngrok | **必须没有代理变量**，否则拒绝启动 | `ERR_NGROK_9009`（已实测） |
| tunnel-client（官方通道） | **必须有代理变量**，否则控制面无出网 | 本轮 + issue-log 记录 |

所以官方通道与 ngrok **不能共用一个进程环境**；若将来同时保留，必须按 provider 隔离环境
（这正是 `tunnel-env.ts` 当年存在的理由）。

### 结论与复现条件

- **现在不投入官方通道**：归档为「网络条件改善后再评估」，方案按公网 URL 路线推进。
- 未来若要重试，前置条件必须同时满足：① 有一个**长期稳定**的代理端点（不是动态端口）；
  ② 隧道由我们托管并可注入该代理环境；③ 先在 L1 拿到「控制面连上、零 poll timeout」，
  再进 L2 拿 `forwarded command to MCP server`。**L1 未过不要动连接器**，否则会把网络问题
  误判成连接器问题（C2C-023 的旧坑：平台侧缓存旧 schema）。
- 参考项目能跑通的原因很可能是**它的网络对 `api.openai.com` 没有 SNI/DNS 阻断**，
  与实现质量无关——这也解释了为什么同一份 v0.0.14 配置在我们这里失败。

## P1 · OAuth 2.1 + 一次性配对码（公网 URL 路线）

### 为什么是它

- ChatGPT 连接器的身份验证下拉里，**OAuth 是官方原生支持的路径**；现在只能选「无身份验证」+ URL 里塞令牌，是绕路。
- 消除三件事：① 手工拼贴 109 字符 URL；② 令牌出现在 URL 里被隧道与各跳记录（`docs/security.md` 已自认此风险）；③ `auth rotate` 后必须人工改连接器。
- 上游已验证可用，接口面小且清晰。

### 上游可移植面（精确清单）

| 上游文件 | 行数 | 内容 |
|---|---|---|
| `src/auth/oauth.ts` | 363 | `createOAuthRouter`：AS 元数据、DCR、authorize、token、revoke |
| `src/auth/store.ts` | 278 | client / code / access / refresh token 存储与轮换 |
| `src/auth/middleware.ts` | — | 401 + `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource/mcp"`（**ChatGPT 靠这个发现 OAuth**） |
| `src/pairing/manager.ts` | 162 | 配对码：8 位 `XXXX-XXXX`、字母表剔除 I/L/O/0/1、SHA-256 存哈希、TTL/尝试次数/限频 |

上游暴露的端点（照此实现）：

```
GET  /.well-known/oauth-authorization-server[/mcp]   AS 元数据
GET  /.well-known/openid-configuration               AS 元数据别名
GET  /.well-known/oauth-protected-resource[/mcp]     PR 元数据
POST /oauth/register                                 DCR（动态客户端注册）
GET  /oauth/authorize                                授权页（HTML，输入配对码）
POST /oauth/authorize                                校验配对码 → 发授权码
POST /oauth/token                                    PKCE S256 换 token + refresh 轮换
POST /oauth/revoke                                   撤销
```

### 适配到我们架构（与上游的关键差异）

| 维度 | 上游 | 我们（机器级） |
|---|---|---|
| 资源归属 | `workspaceId` | **`machineId`**（一台机器一份授权）；per-turn 授权仍由 `context_id` 能力令牌负责 |
| 客户端数 | 单 workspace 单连接器 | 允许多条 client 记录（多设备/多 app 各一条），但不做多租户 |
| 与静态 bearer 关系 | OAuth 是唯一通道 | **OAuth 首选，静态 bearer 保留为降级**，`/mcp/<token>` 通道语义不变 |
| 现有关口 | `middleware.ts` | 复用 `src/gateway/server.ts` 的 `/mcp` 守卫，扩展为「OAuth access token **或** 静态 bearer」二者任一通过 |

### 改动清单（文件级）

**新增**

- `src/gateway/oauth/router.ts`——移植 `createOAuthRouter`，资源字段改 `machineId`
- `src/gateway/oauth/store.ts`——client/code/token 存储，沿用 `config/paths.ts` 的
  `getStateDir()` + `writeSecureJson`(600) + `withFileLock` 模式，落
  `~/Library/Application Support/codex-with-chatgpt/oauth/`
- `src/gateway/oauth/authorize-page.ts`——授权页 HTML（配对码输入 + 错误/重试态）
- `src/gateway/pairing.ts`——配对码管理器（移植上游 `pairing/manager.ts`）
- `tests/oauth-*.test.ts`、`tests/pairing.test.ts`

**修改**

- `src/gateway/server.ts`：
  - 挂载上述路由（在静态 bearer 守卫**之前**）
  - `/mcp` 守卫改为两通道判定：`verifyOAuthAccessToken(...) || verifyHttpAuthToken(...)`
  - 401 响应补 `WWW-Authenticate: Bearer resource_metadata="<publicBase>/.well-known/oauth-protected-resource/mcp"`
- `src/config/public-endpoint.ts`：元数据里的 `resource` / `issuer` 必须来自已记录的 public base URL
  （否则 ChatGPT 拿不到绝对地址）
- `src/cli/index.ts`：
  - 新增 `c2c machine auth pair --json`（签发配对码，输出「连接器 URL + 配对码 + 有效期」）
  - 新增 `c2c machine auth clients`（列出已注册 client）/ `clients revoke <id>`
  - `machine doctor` 增加 OAuth 检查项（元数据可达、client 数、token 状态）
- `src/config/http-auth.ts`：注释更新（令牌不再是唯一通道），行为不变
- 文档：`docs/protocol.md`（Device connector binding 段）、`docs/security.md`（威胁模型：
  URL 令牌降为可选通道，补 OAuth 面）、`docs/troubleshooting.md`、`README.md` + `README.zh-CN.md`、
  `docs/issue-log.md` 新增一节
- `skill/SKILL.md`：连接器配置从「`<base>/mcp/<令牌>` + 无身份验证」改为
  「`<base>/mcp` + OAuth + 配对码」，并保留降级说明

### 验收标准（可执行）

1. `c2c machine auth pair` 输出 8 位配对码与 `https://.../mcp` 地址，码 5 分钟内有效。
2. 裸 `curl -i <公网>/mcp` → **401 且 `WWW-Authenticate` 含 `resource_metadata=.../oauth-protected-resource/mcp`**。
3. `GET <公网>/.well-known/oauth-protected-resource/mcp` 与 `.../oauth-authorization-server` 返回合法 JSON，
   `resource`/`issuer` 是绝对公网地址。
4. `POST /oauth/register` 能拿到 `client_id`（DCR）。
5. 带正确 PKCE verifier 的授权码换 token 成功；**用错误 verifier 必须失败**。
6. 拿 access token 调 `tools/list` → 9 个工具（**URL 里不含任何令牌**）。
7. 配对码错误 5 次后锁定；过期码报明确错误；成功用掉的码不可复用。
8. **回归**：静态 bearer 头 / `/mcp/<令牌>` 两条老通道照常 200。
9. **rotate 验证**：`c2c machine auth rotate` 后，OAuth 连接器**无需任何人工修改**仍可调用 `tools/list`。
10. `c2c machine doctor` 全 ok；全量测试通过（单跑判据）。

### 风险与回滚

- 新增公网攻击面 → 缓解：PKCE 强制、配对码 TTL 5 分钟 + 5 次尝试 + 限频 + 用后销毁、
  token 只存哈希、状态文件 600、不做多租户。
- 万一 ChatGPT 侧 OAuth 发现失败 → **静态 bearer 通道原样保留**，可立即切回（连接器改回
  `<base>/mcp/<令牌>` + 无身份验证），不需要回滚代码。

## P2 · 端点一致性自检（契约层的落地，通道无关）

**这一项的定位在本次纠正后升级了**：它不再是 P0 的补充，而是 P0 契约层本身——
因为「通道由用户自选」意味着 **c2c 无法假设自己知道那条 URL**，它只能靠「声明 + 探针」来掌握真相。
换句话说：**越不绑定 provider，这个自检就越重要。**

- `machine doctor` / `machine setup` 比对三件事是否一致：
  ① 用户**声明的**公网 URL（`http/endpoint.json`）；② 用户**实际**声明的（`tunnel.command` 的输出，
  若配了的话）；③ **该 URL 是否真的能到达本机网关**（探针：打 `/health` 期望 200）。
- 不一致时输出**一条明确动作**（现在完全靠人记得手工 `machine endpoint set`）。
- **探针必须通道无关**：只发一个真实 HTTP 请求看结果，不去读任何 provider 的状态文件/日志。
  这样任何 provider（含用户自建的）都能被同等对待。
- 前提已完成：P0 的契约层提供声明与探针，P2 只负责把它们接到 doctor/setup 的输出上。
- 反面案例（本次实测贡献）：隧道进程健康、4 条 QUIC 连接、预检全 PASS，但 ingress 为空
  → 外部请求全 503。**进程状态再绿也不能替代一次真实探测**，这正是探针必须存在的原因。

## P3 · 连接器迁移与文档

- 迁移指引按闸门 A 的结果二选一：
  - 闸门 A 通过 → 连接器改「连接 = 通道」+「验证 = 无验证」，公网 URL 路线作为降级保留。
  - 闸门 A 不通 → 连接器改「连接 = 服务器 URL」+「身份验证 = OAuth」，走授权页输配对码。
- **通道选型指引要写成「建议 + 判据」而不是「本项目的方案」**：核心判据只有一条——
  「这条公网 URL 会不会变」。任何满足判据的通道都合格，包括我们没提到的。
- **ngrok 退役收尾（本次新增，易漏）**：停并删除 `com.ngrok.tunnel.plist`，把静态域名交还 token-radar。
- `docs/issue-log.md` 记录本次优先级修正（四条事实 + 官方通道 spike 结论 + 通道无关化决策）。
- 保持「不手工贴令牌」为默认，降级路径只在文档里作为排障手段出现。

## P4 · skill 自更新提示

- 上游 skill 每日查 GitHub 自动更新版本；我们已有 `update-check` 实现与测试，只差 skill 侧文案与
  版本提示。低收益，最后做。

## 排期建议

| 阶段 | 内容 | 验收 |
|---|---|---|
| ~~第 0 步~~ | ~~闸门 A：官方通道 spike~~ | **已判定不可用（SNI 阻断），归档** |
| 第 1 步 | **P0 通道无关化**：契约层（URL 声明 + 探针自检）先行；便捷层（`ngrok`/`cloudflared` 适配器）与 `external`/`tunnel.command` 逃生层随后 | `machine tunnel status` 报告「已声明 URL 能否到达网关」；**不设默认 provider**；`external` 路径可跑通 |
| 第 2 步 | P1 OAuth 后端（元数据 + DCR + authorize/token + 配对码 + 测试） | 验收 1–8 |
| 第 3 步 | P1 收尾（CLI `auth pair`/`clients`、rotate 验证）+ P2 端点自检 | 验收 9–10 |
| 第 4 步 | P3 文档 / skill / 迁移指引 + **ngrok 退役收尾**（停并删 `com.ngrok.tunnel.plist`，域名交还 token-radar） | 人工走一遍连接器迁移；`launchctl print` 确认 ngrok job 已卸载 |

每步都以「全量测试 + `machine setup` 同步 + doctor 全绿」收口，与既有流程一致。

## 明确不做

- 不改机器级单 gateway 多 workspace 架构；不回移「每 workspace 一进程」。
- 不做多租户 OAuth / 组织级账号体系；只做「一台机器一份授权」。
- 不删除静态 bearer 与 `/mcp/<令牌>` 通道（降级与脚本用途）。
- **不绑定通道**：不设默认 provider、不在 `machine setup` 里静默安装隧道、
  不因为某家更流行就把它变成事实标准。**ngrok 明确退出本项目**，
  ngrok / cloudflared 只作为「建议内置」的便捷适配器存在。
- **不把「c2c 代管通道」变成必经路径**：`external`（用户自己搭、只告知 URL）必须永远可用，
  且是**默认**。托管进程只在用户显式选择时才发生。

## 附录 · 参考项目 borrow 清单（`arumwu/local-workspace-mcp`，MIT）

该项目的定位与我们的 c2c 不同（41 工具全权限本地执行 + Docker 跑 Python），但以下做法值得借鉴：

| 值得借鉴 | 说明 | 我们用在哪 |
|---|---|---|
| **官方通道连接配方** | ChatGPT 连接器「**连接 = 通道**」+「**验证 = 无验证**」；通道由 OpenAI 账号/工作区 + runtime key 鉴权；runtime key 只给 `Tunnels Read + Use` | 本机因 SNI 阻断**暂不可用**（见闸门 A）；配方留存备用 |
| **密钥处理方式** | 密钥独立文件、权限 600、profile 里以 `file:` **引用**而非内联；禁止出现在 argv / Git / 对话 | 我们的 `http/auth.json`、`openai-tunnel/secrets/*` 已有同样纪律，可写成规范 |
| **launchd 用有名 App 而非 `/bin/sh`** | 编译一个 ad-hoc 签名的小启动 App + plist，macOS「登录项」显示可识别的名字；同名文件存在则**拒绝覆盖**；崩溃重启限频（≥30s） | 仅在用户**显式选择**由 c2c 托管通道时使用（便捷层）；`external` 模式下 c2c 不产生任何 launchd 条目 |
| **验证纪律** | 明确区分「网页 ChatGPT 已验证」与「桌面 App 待验证」；要求真实工具调用返回 stdout + exit code 才算成功；不把进程存在当接通 | 与我们「本机 curl 通过 ≠ 网页能调用」的既有判据一致，可强化 |
| **模式分离** | documents 模式：Docker 隔离、输入只读、**无网络**；full 模式需显式选择 | 我们的工具全是只读，风险更低；文档模式思路可用于未来放开写操作时 |
| **不借鉴** | 41 个工具含终端与全权限文件写；运行期强依赖 Docker | 与本项目「read-only by construction」的安全模型冲突 |
