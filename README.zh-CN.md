# Codex with ChatGPT

[English](README.md) | **简体中文** | [安装流程](#安装与配置)

> ChatGPT 负责思考，Codex 负责干活。

本项目把 ChatGPT 网页版作为本地 Codex 会话的优先研究、分析、规划、整理与审查伙伴。
凡是 ChatGPT 页面或只读 MCP 能完成的任务，默认优先交给 ChatGPT；Codex 始终掌握
工作区写入、命令执行、测试和 Git 操作。ChatGPT 通过 MCP 按需读取当前工作区，
也可以使用自身的联网搜索能力。当前对比模式由 Computer Use 从精确绑定的页面
回复中读取并校验精简的结构化结果。

### ChatGPT-first 分派

`CHATGPT_FIRST` 只适用于证据闭包的子任务：ChatGPT 页面或当前已授权工具必须能够
取得交付结论所需的全部输入，不能只根据“审查 PR”“检查后端”这样的任务名称分派。

- `RESEARCH`：联网检索、外部文档、资料比较和工作区只读发现。
- `PLAN`：架构、实现方案、迁移步骤、接口设计和文档整理。
- `REVIEW`：只审查当前工作区相对 `HEAD` 的未暂存/已暂存变更，以及同一
  本地会话、任务和迭代已经登记的执行记录。
- 本地 Codex 只执行文件修改、命令、测试、Git 和最终验证。

当前 Connector 不能读取任意 commit、分支、tag、PR Diff、父提交或历史源码快照，
也不能读取工作区外或敏感数据；ChatGPT 不能执行命令/测试、修改文件或 Git/PR、
部署服务、切换账号/权限，或宣称最终运行状态已经验证。混合任务由 Codex 先解析 ref、
收集并登记缺失证据；ChatGPT 只承担具备完整输入的研究、规划或审查；最后由 Codex
执行和验收。已知能力缺口不得为了得到可预期的 `BLOCKED` 而先行派发。

网页的 Web Search 是 ChatGPT 自身能力，不是 Connector 暴露的本地 MCP 工具；
搜索结果和其他分析结果统一由 Computer Use 从精确回复读取。为节省本地
上下文，控制消息只携带任务目标和关联字段，不复制仓库内容、Diff 或日志。

## 机器级一次配置

连接按机器配置一次：

- 每台设备各绑定一个连接器；同一个 ChatGPT 账号可以有多台设备的 C2C 插件。
  插件完整名称与稳定链接记录在机器级配置中，本机所有项目和会话复用。
- 连接器指向**公网 HTTPS 地址**：由第三方隧道转发到本机，并在
  Authorization 头携带 bearer 令牌。该令牌只是传输层门禁，不是项目凭据，
  不能替代 C2C 的轮次能力授权。
- C2C 守护进程启动唯一的 `c2c serve-http` 网关，绑定回环端口 `48765`
  （可用 `C2C_HTTP_PORT` 覆盖）。这个网关是机器上唯一的 MCP 网关，
  可以服务所有已注册工作区。
- 一个工作区对应一个 ChatGPT Project；一个本地 Codex 会话对应该 Project
  内一个持久 ChatGPT 对话/页面。
- 浏览器操作始终使用已认领的精确 `tabId`，不会因为某个页面恰好在前台就误发
  消息。
- 机器级最多同时持有 100 个未过期的会话/页面租约，按唯一的
  `(projectId, localSessionId)` 身份计数，每个身份对应一个工作区内的本地会话所有者。
  租约释放、过期或会话退役后会释放容量；最多 100 个
  独立会话可以并行运行。新的第 101 个会话认领会收到可重试的容量拒绝，必须等待、
  退避并在容量释放后重试。同一会话续租、幂等认领或换页都会复用原名额，不会增加
  计数。只有同一本地会话内部的轮次串行，因为一个对话需要保持顺序。

因此不会抢占用户普通的 ChatGPT 对话。C2C 只拥有本地会话记录的页面，不会接管
其他标签页。

## 安装与配置

这是供用户自行部署的开源项目。每位用户在自己的电脑上安装，并使用自己的隧道和
凭据；公开 Git 仓库不代表共享维护者的电脑、公网地址或令牌。

当前传输方式是**公网 HTTPS 地址**：由你运行的第三方隧道转发到网关固定的回环
端口，ChatGPT 连接器使用 `<公网基地址>/mcp`，并在 Authorization 头携带 bearer
令牌。本项目不使用官方 OpenAI Secure MCP Tunnel，因为本网络在 TLS SNI 层重置该
端点：TCP 能连到 `api.openai.com` 的真实地址，但只有 SNI 为 `api.openai.com`
时握手被中断。更换 DNS 或代理都无法绕过。bearer 令牌只认证传输层；C2C 的短期
任务级 `context_id` 授权是另一层，仍然必需。缺少有效令牌时 `POST /mcp` 返回
`401`；令牌由 C2C 生成并保存，不是 ChatGPT 侧的凭据。

### 让 Codex 执行安装

首次安装使用 **Codex 桌面端的普通本地任务**，不要先调用 `$codex-with-chatgpt`：
此时 Skill 还没有安装，也不能依赖尚未连通的 ChatGPT 来安装它自己。可以先发给 Codex：

```text
请为当前系统用户安装 https://github.com/peak-xiong/codex-with-chatgpt 的 main 分支。
先阅读 README.zh-CN.md 的安装说明，检查操作系统、Git、Node.js、Corepack、
当前任务的内置浏览器能力，以及已有的 C2C 安装。
确认源码目录后再克隆和构建；保留已有修改、安装配置和会话，不覆盖或清理它们。
复用已有有效的设备/插件绑定；若缺失或失效，询问当前电脑对应的插件完整名称及
实际可用的稳定链接，用 `machine connector set` 记录一次，之后所有本机项目复用，
不要按相似名称选择另一台电脑的插件。
否则在前置检查和干净源码构建完成后运行 `machine setup --json`，把输出的 MCP 地址
和令牌提示告诉我，并指导我启动隧道、用 `machine endpoint set` 记录公网地址。
不要猜测账号、组织、工作区、地址或凭据，除非我明确要求，不要输出完整 bearer 令牌。
缺少权限或遇到登录、授权步骤时，说明需要我完成的操作；不要自行切换账号、
扩大权限，或改用其他隧道方案或 OAuth。
```

下面第 1–6 步也是 Codex 应遵循的安装顺序。**Codex 已完成的本地命令不需要用户
再执行一遍**；命令块供 Codex 执行或用户核对。

| 操作 | 谁来完成 |
| --- | --- |
| 登录隧道服务并启动一条转发到网关回环端口的隧道 | 用户启动并保持隧道运行；Cloudflare 命名隧道需要账号和域名，Cloudflare 快速隧道两者都不需要，ngrok 免费版需要注册账号 |
| 记录公网地址并避免在聊天中泄露 bearer 令牌 | Codex 用 `machine endpoint set` 记录地址；令牌可见范围由用户控制 |
| 检查环境、构建源码、全局安装、诊断 | Codex 在本地执行，不在 ChatGPT 对话中执行 |
| 使用公网地址和 Authorization 头创建/复用 ChatGPT 连接器 | 用户在已确认的 ChatGPT 工作区中完成，随后由 Codex 验证 |

### 1. 检查前置条件

- Git、满足 Node.js >= 20 要求的受支持 Node.js LTS 版本，以及 Corepack。
  先运行 `node --version`、`git --version`、`corepack --version`。缺少 Corepack
  时，先安装适合当前 Node.js 版本的 Corepack；仓库的 `package.json` 已固定 pnpm 版本。
- Codex 桌面端，当前会话能够使用内置浏览器和 Computer Use。只安装命令行工具
  不会自动获得网页操作能力。
- ChatGPT 账号/工作区能够使用开发者模式的自定义应用。请在自己的账号中确认入口
  和管理员授权，不能仅凭订阅名称认定功能可用。
- 可用的第三方隧道客户端，能够把本机端口以 HTTPS 暴露到公网。只要能把公网
  HTTPS 地址转发到网关的回环端口，任何隧道都可以。优先使用 **Cloudflare 命名隧道**：
  域名稳定、一条隧道可以服务多个域名、重连后地址不变；只有在没有 Cloudflare 账号
  和域名时才用快速隧道（Cloudflare `trycloudflare.com` 或 ngrok），它们每次重连都会
  换一个新域名，地址变化后必须重新记录。其中 Cloudflare 快速隧道不需要账号，
  ngrok 免费版需要注册账号。
- 电脑能够出站访问隧道服务、GitHub 和包仓库。ChatGPT 调用本地工具期间，电脑必须
  保持唤醒、联网，隧道和 C2C 网关必须同时运行。

当前真实验证环境是 **macOS + Codex 桌面端**。代码包含其他平台目标，但 Windows/Linux
原生安装和完整浏览器流程尚未完成验收。下面命令使用 macOS/POSIX Shell 语法，不能
当作 PowerShell 命令直接执行。

账号、权限和网络要求以所选隧道服务的官方文档为准。公网地址用于私有连接和开发者
模式应用，**不满足公开插件商店的提交要求**。“公开源码供别人自行部署”与“发布一个
所有人都能直接安装的 ChatGPT 公共插件”是两件事。

### 2. 下载并构建干净的源码仓库

对于 [PR #409](https://github.com/XiaoDuoYa/codex-with-chatgpt/pull/409) 中的机器级方案预览，
下面个人 fork 的 `main` 已包含实现。不要假设其他仓库或分支也已包含它。使用
`git clone`，不要使用 Download ZIP；安装器要求从干净、已提交的 Git 版本构建。

```sh
git clone --branch main --single-branch https://github.com/peak-xiong/codex-with-chatgpt.git
cd codex-with-chatgpt
corepack pnpm install --frozen-lockfile
corepack pnpm build
node bin/c2c.js machine setup --help
git status --short
```

保留这个源码目录以便后续升级。安装前 `git status --short` 应无输出。已有修改时，
先妥善保存，或另外克隆一份干净源码；不要为通过安装检查而重置或删除自己的工作。

### 3. 启动隧道并记录公网地址（仅首次安装）

这一阶段在隧道服务自己的页面和客户端完成，**不是本地 `machine setup` 的功能**。
如果前置检查已经确认存在健康、已记录公网地址且隧道正在运行的 C2C 安装，则跳过本节。

只要能把公网 HTTPS 地址转发到网关的回环端口，任何隧道都可以。优先使用
**Cloudflare 命名隧道**：域名稳定、一条隧道可以服务多个域名、重连后地址不变；
只有在没有 Cloudflare 账号和域名时才用快速隧道（Cloudflare `trycloudflare.com`
或 ngrok）。

1. 在隧道服务中配置，并为这台电脑保留或复用它专用的一条隧道；不要复用另一台电脑的
   隧道或公网地址。Cloudflare 命名隧道需要账号和域名，快速隧道两者都不需要。
2. 把该隧道指到网关的回环端口 `48765`（即默认 `C2C_HTTP_PORT`）。这个端口是有意
   固定的：隧道配置指向它，端口在两次启动之间变化会静默破坏公网地址。隧道必须与
   网关运行在同一台机器上。
3. 复制隧道给出的 HTTPS 基地址，例如 `https://<your-subdomain>.example.com`，
   不要带 `/mcp` 后缀；`c2c machine endpoint set --url <https-url>` 会自行追加
   `/mcp`。
4. 保持隧道运行。快速隧道的公网地址每次重连都会变化，变化后必须用
   `machine endpoint set` 重新记录，ChatGPT 连接器也要同步更新；Cloudflare
   命名隧道没有这个问题。

**出网与代理。** 隧道客户端需要自己的出网通道。如果本机通过代理上网，隧道客户端
可能拒绝启动或连接失败，请让运行它的进程直连。有一个已验证的坑是 ngrok 特有的：
**ngrok 免费版在设置了代理环境变量时会拒绝启动**，它以 `ERR_NGROK_9009` 退出，
并提示 ngrok agent 不能在设置了代理环境变量的环境中运行。请在运行 ngrok 的
Shell（或服务定义）中取消 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、
`NO_PROXY`，让 ngrok 直连。

不要把 bearer 令牌放进命令行参数、截图、Project 指令或 Git。令牌由 C2C 生成并保存；
不要复用另一台电脑的地址或令牌。这套架构里没有运行密钥，也没有 Tunnel ID 需要收集——
隧道客户端是服务商提供的普通程序，C2C 既不会安装它，也不会托管它。

### 4. 为当前系统用户全局安装一次

完成第 3 步后，在**同一个 Codex 安装任务**中回复下面内容，不要粘贴 bearer 令牌：

```text
我已经为这台电脑启动了一条隧道，并指向网关的回环端口。它的公网 HTTPS 基地址是：
<https://your-tunnel-public-base-url>
请从刚才构建的干净源码目录执行 machine setup，为当前系统用户安装。
然后用 machine endpoint set 记录该公网地址，并报告 MCP 地址。只显示令牌提示，
不要在聊天中输出完整 bearer 令牌。
然后检查全局 Skill、machine status 和 machine doctor --no-fix，报告实际结果。
本地安装完成后，等待我在 ChatGPT 创建或确认连接器，再进行工作区配对和回传验收。
```

Codex 应在第 2 步构建好的源码目录执行下面命令，不使用 `sudo`。首次安装时全局
`c2c` 可能不存在，必须使用源码入口：

```sh
node bin/c2c.js machine setup --json
node bin/c2c.js machine endpoint set --url "https://<your-tunnel-public-base-url>" --json
node bin/c2c.js machine auth show
```

`machine setup` **只接受 `--json`**；`--tunnel-id`、`--runtime-key-file` 和
`--reuse-existing` 都已移除。后续升级同样直接重跑它：会复用已记录的地址和已有令牌，
不需要原始凭据路径。只有隧道的公网地址真的变化时才需要重新记录。

预期返回 `ok: true`、`configured: true`。安装器会部署经校验的运行时，安装全局
Skill 和 `c2c` 命令入口，通过机器守护进程启动唯一的 `c2c serve-http` 网关，并在
首次使用时生成 bearer 令牌。`machine endpoint set` 记录公网基地址和回环端口；
`machine auth show` 只显示令牌提示，加 `--reveal` 才输出连接器需要的完整值。
**安装器不会启动你的隧道、创建 ChatGPT 工作区，也不会在 ChatGPT 中创建连接器**；
隧道必须已在第 3 步启动。

用 `c2c machine auth rotate --json` 轮换令牌。旧令牌立即失效，请在同一个操作里同步
更新连接器的 Authorization 头，否则所有调用都会返回 `401`。

**代理说明。** C2C 网关只绑定回环地址，本身不需要代理。隧道客户端需要自己的出网，
代理可能让它拒绝启动或连接失败；ngrok 免费版尤其在有代理变量时拒绝运行（见第 3 步）。
如果本网络按域名劫持明文 UDP/53 查询（例如 `api.openai.com` 被解析到
`2a03:2880::/29`，即 Meta 网段），仅更换 DNS
服务器无效，因为伪造应答出现在链路上；程序不走代理时必须使用加密 DNS（DoH/DoT）。

不要再并行运行官方 OpenAI Secure MCP Tunnel 的客户端或示例 MCP 服务。C2C 已移除该
传输方式，它在本网络上无法连接，运行它只会多出一条无用的路径。

命令入口位于 `~/.local/bin/c2c`。若终端找不到 `c2c`，在自己的 Shell 启动配置中
加入下面一行，再重新加载该 Shell：

```sh
export PATH="$HOME/.local/bin:$PATH"
```

也可以不改 PATH，直接执行 `"$HOME/.local/bin/c2c" machine status --json` 检查。

### 5. 每台设备在 ChatGPT 中连接一次

切换到预期的 ChatGPT 账号/工作区，按需开启开发者模式（当前入口为设置中的
Security and login，可能需管理员先授权）。打开 [ChatGPT 插件页](https://chatgpt.com/plugins)，
通过加号/创建入口新建开发者模式应用，配置如下。不同 UI 版本可能称其为应用、
插件或连接器。

| 字段 | 值 |
| --- | --- |
| 名称 | 能区分设备的完整名称，例如 `Codex with ChatGPT - Laptop`；现有名称可以保留 |
| Connection（连接方式） | `Server URL`（不是 `Tunnel`） |
| MCP Server URL | `c2c machine endpoint get --reveal` 会打印含令牌、可直接粘贴的完整地址：`<公网基地址>/mcp/<令牌>` |
| Authentication | `No authentication`（无身份验证） |

选「无身份验证」不是配置错误：该表单只有 `OAuth`、`No authentication`、`Mixed`
三项，没有静态令牌输入框，ChatGPT 也无法携带自定义 API 密钥，所以令牌走 URL。
其他 MCP 客户端应继续使用 `Authorization: Bearer` 头，它优先于 URL。

已有该连接器时直接复用，不重复创建。这里没有 Tunnel 可选，也没有运行密钥：
公网地址加令牌就是传输配置的全部。工具发现期间保持隧道和网关运行。
地址被拒绝时，确认记录的是不带 `/mcp` 后缀的公网基地址（C2C 自行追加），并且隧道
仍在转发。返回 `401` 说明连接器 URL 里的令牌与本机当前令牌不一致：用
`c2c machine auth show --reveal` 核对，或用 `c2c machine auth rotate` 两边一起轮换。
请把完整的 `/mcp/<令牌>` 地址当作密码，它就是传输凭据。

通过传输令牌校验只证明调用方到达了本机网关，并不授予工作区访问权限：ChatGPT 仍须
在每次工具调用中携带 `c2c control open` 签发的 `context_id`，否则任何工具都不会对
工作区生效。完成后通知 Codex“连接器已配置”，再继续第 6 步；看到连接器卡片不等于
回传验收已通过。

同时告诉 Codex 哪个插件属于当前电脑，由 Codex 在本机记录一次：

```sh
c2c machine connector set --name '<本机插件完整名称>' \
  --plugin-url 'https://chatgpt.com/plugins/plugin_<实际观察到的ID>' --json
c2c machine connector get --json
```

链接必须来自实际插件页面，不要原样使用占位符。没有可用稳定链接时可省略
`--plugin-url`，但插件名称必须足以唯一识别目标。绑定只保存本机路由，不会创建或
重命名远端插件；插件实际连接哪条通道，仍需通过真实读取验证返回的机器身份。

两台电脑各使用自己的公网地址和插件，路由层级为：
**设备 → 公网地址 → 指定插件 → Workspace/Project → Session/Chat/标签页**。
不要跨设备复制机器 ID、凭据、插件绑定或页面归属状态。普通升级保留绑定；绑定记录的
machine id 与当前机器不一致时旧绑定会变为 `stale`。旧安装首次升级若尚无绑定，只需
补记一次已有的设备/插件对应关系；`control open` 会在发出本地 MCP 请求前检查绑定。
之后所有本机项目自动继承，无需逐项目安装或再次选定插件，也不强制要求界面显示
插件标签。`machine connector get` 返回 `status: bound` 后再进行真实读取验收。

创建应用或变更工具 schema 后，确认已有应用中的所需只读工具及输入契约。
仅当当前界面提供 Refresh 且需要更新发现信息时使用一次，不假定固定菜单路径。
打开 Manage 或重启隧道都不能证明 schema 已刷新；真实读取在第 6 步单独验证。
缺少按钮时不要反复寻找或重建连接器。

切换 ChatGPT 账户后，还需检查原工作区的 Project/Chat 是否可访问。插件绑定成功
不会自动迁移旧项目；按[账户迁移流程](docs/protocol.md#account-migration)备份并清理
已确认失效的路由后，再让 Codex 创建新项目和会话。保留新账户已经有效的绑定。

### 6. 先验证安装，再验证真实回传

从现在起使用全局命令：

```sh
c2c skill status --json
c2c machine status --json
c2c machine doctor --no-fix --json
```

预期 Skill 的 `installed`、`matches` 为 `true`，机器 `ready: true`，doctor
`ok: true`。这些检查不能证明 ChatGPT 已经能够回写结果。

在 Codex 桌面端打开实际要使用的项目，新建本地会话并提出：

```text
请使用 $codex-with-chatgpt 配对当前工作区，验证本地读取和结构化结果回传。
在本会话专属的 ChatGPT 对话中连续完成两轮只读问题，每轮都必须从精确关联的
页面回复中由 Computer Use 校验结构化标记。不要修改业务代码，也不要接受未关联的
页面文字。
```

Skill 会注册当前工作区，在首次配对时为它创建 ChatGPT Project，或者使用用户明确
认可的现有精确 Project URL，再验证本地会话专属的 Chat。已有权威绑定时直接复用。
控制问题使用 Chat 模式，且当前消息能调用这个连接器。若找不到 Skill，可重新打开
Codex 桌面端；已有会话需要重新读取新版 Skill，而不是逐项目重新安装。

验收分为三个独立层级：

| 层级 | 必须看到的证据 |
| --- | --- |
| 已安装并连接 | 全局 Skill 匹配、机器 ready、doctor 通过 |
| 本地读取可用 | BOOT 返回预期 workspace/project ID 和真实本地证据 |
| 回传可用 | Computer Use 校验精确 tab/chat/generation/response 和结构化结果标记 |

前两层是纯本地检查：机器健康、doctor 通过、地址已记录，只证明各托管组件彼此一致，
**不能证明 ChatGPT 能到达本机**。要单独验证 HTTP 这一跳，可以带令牌直接请求公网
`/mcp` 地址：

```sh
MCP_URL="https://<your-tunnel-public-base-url>/mcp"
TOKEN="$(c2c machine auth show --reveal)"
curl -sS -i -X POST "$MCP_URL" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual-check","version":"0"}}}'
```

返回 `401` 说明令牌不匹配；返回完整的 `initialize` 响应只证明这条 HTTP 链路可用，
**不等于** ChatGPT 连接器能通过隧道访问该地址——后者需要一次真实连接器调用。地址
可达但调用失败时，优先刷新 ChatGPT 应用管理页缓存的工具 schema
（Plugins → 该应用 → **Manage** → **Refresh**）；仅重启隧道不会刷新平台侧的元数据。

mailbox 回调代码和历史真实回传记录继续保留，供后续对比；生产 MCP 当前不注册
这些回调工具。只有经过精确页面关联和 schema 校验的结果标记才会被接受，普通页面
文字不能替代结果。详见 [当前验收边界](docs/issue-log.md#最新回传验收修复)。

### 在其他项目或会话中使用

“全局”指**当前系统用户和 Codex 配置下共用一份安装**，不是所有用户、电脑和
ChatGPT 账号自动共享。

| 范围 | 要做什么 |
| --- | --- |
| 当前机器/系统用户 | 一份运行时、Skill、隧道和连接器 |
| 新工作区 | 首次注册并配对自己的 ChatGPT Project |
| 新本地会话 | 在该 Project 中绑定一个专属 Chat/页面 |
| 同一会话的后续任务 | 复用页面，只生成新的任务授权 |

在实际要让 ChatGPT 访问的项目根目录中执行：

```sh
cd /absolute/path/to/your-project
c2c machine workspace register --json
c2c workspace --json
```

Skill 会按需执行注册，上面的命令用于检查。不要在不包含 C2C 源码的业务项目中
运行 `node bin/c2c.js`。工作区命令按可信的当前目录确定目标，`-w` 不能选择其他路径。
其他项目不需要新的连接器、隧道或复制 Skill——同一个机器级地址服务所有已注册
工作区；换电脑/系统用户则需各自配置。

### 安装位置与升级

macOS 默认位置如下，均属于当前系统用户：

| 项目 | 位置 |
| --- | --- |
| 命令入口 | `~/.local/bin/c2c` |
| 全局 Skill | `~/.codex/skills/codex-with-chatgpt/SKILL.md` |
| 托管运行时 | `~/Library/Application Support/codex-with-chatgpt/installation/current` |
| 公网地址记录 | `<机器状态目录>/http/endpoint.json`（0600） |
| bearer 令牌 | `<机器状态目录>/http/auth.json`（0600） |
| Git 项目状态 | `<git-common-dir>/codex-with-chatgpt` |
| 非 Git 项目状态 | `<workspace-root>/.codex-with-chatgpt` |

`CODEX_HOME` 可改变 Skill 的配置根目录。`C2C_STATE_DIR` 改变机器状态位置，不改变
已注册的仓库本地状态；通常无需设置。托管运行时不是 Git 源码目录，不要直接修改或
在其中 `git pull`。Gateway 管理受保护的结果箱和跨工作区页面索引；项目自身保存
路由、checkpoint 和执行记录。

升级前先让活动任务结束：安装可能重启共享网关，使旧授权失效。在最初克隆的干净
源码目录中执行：

```sh
cd /absolute/path/to/codex-with-chatgpt
git status --short
git pull --ff-only
corepack pnpm install --frozen-lockfile
corepack pnpm build
node bin/c2c.js machine setup --json
c2c skill status --json
c2c machine doctor --no-fix --json
```

只有状态检查无输出时才继续。复用已记录的公网地址、已有 bearer 令牌和现有连接器；
升级时不需要原始令牌、密钥文件路径，也不必逐项目升级。只有隧道公网地址真的变化时
才需要重新执行 `machine endpoint set`。安装命令必须使用上述**更新后源码的入口**，
不要改为旧的全局 `c2c`，否则会复用它自身的旧运行时。重启后 Skill 取得新授权，既有
Project/Chat 映射仍保留。
升级涉及工具契约时，按第 5 步核验已有应用的发现信息；仅在界面提供且确有需要时刷新。
`c2c update-check --json` 只检查更新，不执行安装；`checked: false` 也不能证明已是最新版。

### macOS 登录后自动启动（可选）

首次完成机器配置后，在 macOS 上只需启用一次机器级 LaunchAgent，并确认状态：

```sh
c2c autostart enable --json
c2c autostart status --json
```

LaunchAgent 会隐藏运行 `c2c autostart run --quiet`。这个命令只调用
`ensureMachineGateway`，在唯一的 `c2c serve-http` 网关停止时把它拉起，不会为工作区
创建第二个网关。它不会启动你的隧道。关闭自动启动：

```sh
c2c autostart disable --json
```

自动启动只是机器级保活机制，不是页面调度器，也不会改变机器级 100 个活动会话/页面
租约的容量。

### 常见安装问题

| 现象 | 先检查什么 |
| --- | --- |
| 找不到 `corepack` 或 `c2c` | 安装适合当前 Node.js 的 Corepack；检查第 4 步的入口和 PATH |
| 没有 `machine setup` 命令 | 检查仓库/分支并按第 2 步重新构建；旧 OAuth 版本是另一套架构 |
| `machine setup` 拒绝 `--tunnel-id` 或 `--reuse-existing` | 这两个参数已随 Secure Tunnel 传输方式移除；只运行 `machine setup --json` |
| `machine endpoint get` 没有地址 | 用 `c2c machine endpoint set --url <https-url>` 记录运行中隧道的 HTTPS 基地址 |
| 连接器返回 `401` | Authorization 头的令牌与 `c2c machine auth show --reveal` 不一致；更新其中一侧或两边一起轮换 |
| 隧道客户端因代理报错退出（例如 ngrok 的 `ERR_NGROK_9009`） | 让隧道客户端直连出网；ngrok 免费版需取消 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`，它在设置代理变量时拒绝运行 |
| 安装器要求干净 Git 源码 | 使用 Git 克隆并先保存自己的修改，不能用 ZIP 代替 |
| 机器未 ready | 执行 `c2c machine doctor --no-fix --json`，它会分别报告 `gateway`、`endpoint`、`auth` 三项检查 |
| 能读文件但收不到结果 | 检查当前消息的回传工具可用性，不能宣称完整成功或绕过平台授权 |

受控修复和精确会话恢复详见 [故障排查](docs/troubleshooting.md)。

## 运行结构

```text
ChatGPT Project A                 ChatGPT Project B
  会话 A1 -> 页面 A1                 会话 B1 -> 页面 B1
  会话 A2 -> 页面 A2                 会话 B2 -> 页面 B2
            \                         /
             \                       /
              一个全局连接器（Server URL + Bearer 令牌）
                              |
              第三方公网隧道 -> <公网地址>/mcp
                              |
           c2c serve-http 监听 127.0.0.1:48765（/mcp 需 bearer 令牌）
                              |
          机器网关：工作区注册表 + 能力令牌代理 + 结果箱
                              |
                       可信本地工作区
```

Skill 根据可信的本地 `cwd` 确定工作区。网关为工作区分配稳定的 `projectId`、
checkout-specific 的 `workspaceId` 和 `registrationId`，并把注册信息保存在机器
注册表中。Project 与对话 URL 只用于导航和记忆，不是文件系统授权边界。

每个控制轮次都会获得一个短时 `CONTEXT_ID`，绑定：

```text
machine boot + workspaceId + projectId + registrationId
localSessionId + taskId + iteration + phase
requestId（非 BOOT 必填，BOOT 不包含）
compactionEpoch + 页面 generation + 请求的 scopes
```

ChatGPT 必须在每一次 MCP 调用中传入 `context_id`。网关验证能力令牌、取得活动
租约，在长调用期间续租，并在调用结束后释放租约。令牌过期、取消、页面轮换、
上下文压缩或网关重启都会让旧令牌失效。

## 控制流程

正常状态流转为：

```text
RESEARCH -> INIT -> PLAN -> EXECUTED -> REVIEW -> DONE
```

Codex 只向精确认领的对话发送很短的控制消息，绝不把文件内容、diff 或日志粘贴
到 ChatGPT。ChatGPT 通过只读 MCP 工具读取数据，并在精确回复末尾输出
`C2C_HOST_OBSERVED_RESULT` 结构化标记。Computer Use 校验 tab、chat、generation、
response id、request id、阶段和 payload schema 后，Codex 才推进会话。

这是临时对比模式。mailbox 回调实现仍保留在源码中，但生产 MCP 不注册
`get_control_result_status`、`report_control_progress` 和 `submit_control_result`，
`control open` 也不会授予 `c2c.result.write`。

## 页面所有权

ChatGPT 操作使用内置浏览器。配置时 Skill 以 browser、surface、Project URL、
chat URL 和 `tabId` 精确认领页面。租约带有 generation 和 owner epoch；替换存活
页面必须提供精确的当前 generation，其他会话的页面不能被认领。

每个本地会话的处理顺序：

1. 执行 `c2c session get --json`，记录 `sessionIdentity.id`。
2. 读取该会话的 route 和 surface lease。
3. 只打开或返回该会话保存的 chat URL。
4. 每条控制提示都带上 `CONTEXT_ID` 和 `RESULT_REQUEST_ID`。
5. 等待精确的 Computer Use 结果完成后，才能发送下一条控制消息。

Computer Use 通过稳定 URL 和语义化 DOM/浏览器 API 驱动每个独立的内置浏览器
页面，并始终使用精确 `tabId`。正常操作不使用截图坐标点击；轮次结束后保留页面
为待机状态，不关闭或挪作其他会话用途。

`surface release` 只结束当前租约，并保留会话路由以便下次继续使用。只有在本地
Codex 会话被永久丢弃时，才执行
`c2c surface retire --local-session <id> --json`。退役会撤销该会话的 context、
结束活动控制请求，并删除页面绑定和 checkout 路由；工作区的 ChatGPT Project
绑定仍供其他会话和未来会话复用。

### 会话不可用时

Skill 检查精确标签页的语义状态，再交给 `c2c surface check` 判断。标签页关闭时
重新打开原 Chat；明确归档或不可用时，在原 Project 中创建新 Chat，不自动取消归档。
遇到登录或授权时，Codex 只提示已观察到的入口或服务链接及所需操作，由用户完成；
模型不发起或提交登录、不填写账号密码或验证码、不读取已保存凭据，也不切换账号。
用户告知完成后，再检查原页面、身份和授权并继续任务。
加载和生成中只等待，不重复发送。CLI 评估宿主观察，
本身不独立探测 ChatGPT 页面。

不强制要求 C2C 出现在插件选择器中或显示已选标签。绑定与授权正常时，可直接在
原对话的正常关联请求中写明连接器名称，请 ChatGPT 发现并调用可用工具；
工作区任务先调用 workspace_info 核验身份，不额外发送探测消息。
以真实工具调用结果判断可用性，模型仅说“我能使用插件”仍属于未验证。
界面未显示不能单独导致人工选择或重建对话。真实工具/授权失败按结果协议结束，
不得换页面重试平台已拒绝的任务。

替换前先将已验证的 Computer Use 结果保存到本地 checkpoint。只有确认页面失败后，
才取消精确的 pending 请求。未收敛的
请求会阻止页面轮换。恢复保留任务进度，新页面通过 BOOT 后才能提交路由，旧
generation 不能继续写回。一次恢复只自动创建一个替代页面，不使用会话退役来恢复。
详见 [恢复协议](docs/protocol.md#page-recovery)。

默认使用页面当前模型。模型和推理强度元数据不会操作选择器，也不保证始终为最新
模型；明确指定模型时，必须在页面中选择并验证。

## 安全边界

- 传输层是公网地址，因此 `POST /mcp` 必须携带 bearer 令牌；未携带或令牌错误都会
  返回 `401`。缺少令牌时网关拒绝启动 `serve-http`。
- bearer 令牌只是**传输层门禁，不是授权**。通过校验的调用方仍必须携带
  `c2c control open` 签发的有效 `context_id`，任何工具才会对工作区生效；每个工具
  还会单独校验自己的 scope。
- MCP 工作区工具全部只读；Computer Use 结果受活动请求、精确页面/回复身份和 schema 约束。
- 工作区路径会规范化并限制在注册根目录内，符号链接和目录穿越都会被拒绝。
- 能力令牌和活动租约均短时有效，并绑定会话、任务、轮次、阶段、压缩纪元、页面
  generation 与 scopes。
- 保留的 mailbox 完成栅栏在当前生产传输中停用，仅继续由测试覆盖以便后续对比。
- 机器生命周期记录同时校验 machine id、boot epoch、pid 和精确运行时数据，第二
  个进程不能悄悄成为网关。
- bearer 令牌、管理令牌和原始能力令牌只保存在受保护的机器状态中（0600），普通
  CLI 输出会隐去它们；只有显式执行 `machine auth show --reveal` 才会打印完整令牌。
- 任何能访问公网地址的人都可以尝试 bearer 校验，因此令牌泄露时应执行
  `c2c machine auth rotate`，并保证该隧道专用于本机。

详细契约见 [docs/architecture.md](docs/architecture.md)、
[docs/protocol.md](docs/protocol.md)、[docs/security.md](docs/security.md)。

## 常用命令

```sh
c2c machine start
c2c machine status --json
c2c machine doctor --no-fix --json
c2c machine stop
c2c machine endpoint get --json
c2c machine endpoint set --url https://<your-tunnel-public-base-url> --json
c2c machine auth show --json
c2c machine auth rotate --json
c2c workspace --json
c2c surface get --local-session <session-id> --json
c2c session get --local-session <session-id> --json
c2c control status \
  --local-session <session-id> --request <id> --task <id> \
  --iteration <n> --phase <phase> --json
```

`machine stop` 会停止所有工作区共享的连接，请先等待活动任务结束。
下面源码检查命令应在 C2C 源码目录中执行：

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

## 许可证

MIT
