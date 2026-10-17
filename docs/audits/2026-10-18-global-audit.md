# 2026-10-18 全仓审计

本报告保留初次全仓审计及后续整改证据。初次审计发现 15 项问题，整改复核另发现 C2C-050；全部 16 项已修复并于 2026-10-18 通过代码与自动化验收。最终类型检查、构建和全量测试均退出 0，48 个文件、666 项通过。本轮没有部署或重新进行真实网页验收。

## 整改实现与验收证据

整改基于 `b33bfcdfe1e8cc01c8e545e7713335cacd8983fb`，继续使用唯一的 `codex/global-audit` 分支和原隔离工作树。实现按工作区访问、Git 读取、脱敏、配置事务和更新来源分别归属；没有改动控制终态的双观察屏障。

| 问题 | 实现与回归 |
| --- | --- |
| C2C-035 | 从项目身份模块取得实际 Git common-dir 和内部状态根；普通读取强制拒绝，目录与两种搜索引擎复用同一可见性规则。覆盖普通、linked、non-Git 及 separate-git-dir 布局，执行记录仍由专用 scope/轮次门禁提供。 |
| C2C-036、C2C-044 | inventory 保留全仓 rename 来源，过滤时转为 workspace 坐标，内容 pathspec 使用仓库根字面量语义；禁用 external diff/textconv。覆盖嵌套工作区、三种 diff mode、linked worktree、敏感及跨工作区 rename 和无害驱动 marker。 |
| C2C-037、C2C-040 | logger 持有统一凭据脱敏规则，执行命令与输出复用；覆盖当前 MCP 令牌、URL 路径、结构化日志、JSON 引号/空白/转义与 shell 引号。短诊断码继续可读，私钥拒绝与输出限制保留。 |
| C2C-038 | 仅在实际写配置时保存 preimage/postimage 并登记回滚；恢复前核对当前内容和权限，独立编辑冲突时保留并报错。公开 CLI 输出不含回滚快照。验证 helper 事务边界，完整 CLI 调用链另作静态核对。 |
| C2C-039 | 共用 descriptor 安全打开模块，校验规范路径、父链及打开对象身份，再通过同一 descriptor 读取。覆盖叶子/祖先替换及打开后路径替换，文本、图片、Node 搜索和有界 JSON/ignore 读取共用。 |
| C2C-041 | 每次操作刷新 ignore，批量读取复用本批规则；重复注册刷新旧实例。读取失败保留旧保护并拒绝；只有确认目录项实际不存在才清空，悬空链接不视为删除。 |
| C2C-042 | 文本扫描上限 8 MiB，chunk 组装服从返回预算，首请求行超预算早停；保留精确数字行数和 LF/CRLF/bare-CR、跨 chunk UTF-8 语义。图片 10 MiB、Node 搜索单文件 2 MiB 仍有界。 |
| C2C-043 | 区分 rg 成功、正常无匹配、执行错误及达到 limit 主动终止；诊断有界脱敏，regex 错误不再伪装为空结果。 |
| C2C-045、C2C-046 | 安装元数据另存 baseline 祖先验证结果；旧元数据缺少证明时返回未知。SSH 保留连接用户名，移除密码及 HTTP 凭据，规范化往返幂等。 |
| C2C-047 | 首次 token read-or-create 全部在同一锁内；双进程验证返回同一值，显式 rotate 仍强制更换。 |
| C2C-048 | buildStage 清理移至发布 current 之前，清理故障不改变 current/launcher；注入清理失败回归。 |
| C2C-049 | CLI 共用解析器支持独立值 `--scopes none`，拒绝与其他 scope 混用，缺省行为保留。集成模拟验证本地读取被拒，精确 Computer Use candidate/final 仍可完成、旧 context 撤销、下一轮保持独立 pending。 |
| C2C-050 | 修复前两个文件/目录互换用例均复现敏感内容泄漏；修复后按批次强制排除可能重新进入的拒绝路径，相关敏感 rename 保留双端保护。独立复核发现的 scoped child 与无关修改预算回归已先复现再修复；必要排除超预算时拒绝返回，24 项 Git 测试及独立定向复核通过。 |

定向原始日志和数字退出码保存在 `/tmp/c2c-global-closure/` 的 `config/`、`workspace/`、`git/`、`git-path-collision/`、`redaction-update/`、`zero-scope/`。工作区最终定向 6 个文件、105 项通过；Git 最终定向 24 项通过。配置、脱敏及更新改动已独立复核；最后三处访问/Git 修正也经定向独立复核，无剩余合并阻断。

最终验收由 Luna tester 在隔离 `C2C_STATE_DIR=/tmp/c2c-global-closure/final/isolated-state` 中执行，未改变 `HOME` 或 `CODEX_HOME`：

| 命令 | 真实退出状态 | 结果 |
| --- | --- | --- |
| `pnpm typecheck` | `status: 0, signal: null, error: null` | 类型检查通过。 |
| `pnpm build` | `status: 0, signal: null, error: null` | 构建通过。 |
| `pnpm exec vitest run --maxWorkers=1` | `status: 0, signal: null, error: null` | 48 个文件、666 项通过；Vitest 305.68 秒，子进程 306.190 秒。stderr 为空，无 worker timeout 或 unhandled error。 |

原始 stdout/stderr 与每条命令的实际状态保存在 `final/commands.json`、`typecheck.result.json`、`build.result.json`、`full.result.json` 及对应日志。`runner-started.json`、`runner-completed.json` 记录完整生命周期，`freeze-before.json` / `freeze-after.json` 中 Git 源码和测试哈希一致；主代理直接核对这些文件及实际 diff。此前失败复现和中间日志不能替代这次最终成功证据。C2C-033 终态恢复、精确响应与跨会话隔离的既有回归也包含在本次全量中。

读取并非编辑中的文件的原子快照。macOS 使用打开前后路径/对象身份校验；Linux 可用 procfs 时另核对 fd 路径。不承诺抵御所有恶意 ABA 或原地修改。零 scope 证据是自动化集成模拟，没有真实网页搜索。本轮不部署、重启网关或操作其他会话。

## 范围与证据

- 审计基线：`1594a170736828cd4cd83526c0033559cccd6046`，审计分支只有 `codex/global-audit`。同一分支还包含下述终态恢复修复。
- 范围覆盖 `src/`、`bin/` 的 51 个文件，并定向核对测试、CLI、Skill、协议和安全文档。覆盖控制请求/历史迁移、会话及页面租约、能力与注册表、MCP/HTTP、文件和 Git 读取、执行记录、日志、配置、安装/自启/进程及更新检查。不是仅审本次 diff。
- 代码结构查询在该隔离 worktree 没有可用 CodeGraph 索引，采用定向源码搜索；未初始化或借用另一个工作树的索引。
- Luna worker 执行实现与项目测试；Luna tester 执行隔离探针；主代理复核源码、实际 diff 和证据。静态发现与实测结果分别标注。
- 探针仅使用临时 Git 仓库、合成记录、合成凭据、显式临时配置和无害 marker 程序。没有读取真实 token、修改真实认证状态、调用账号或联网；没有重设 `HOME`。`C2C_STATE_DIR`、探针内 `CODEX_HOME` 和 Git 配置均隔离。
- 本轮没有部署、重启网关、清理其他状态或发送 ChatGPT 消息。前轮真实网页验收记录见 `docs/issue-log.md` 的 C2C-032，不能当作本轮新增修复的实测。

探针原始结果位于 `/tmp/c2c-global-audit/probes/report.md`、`summary.json` 和 `run-probes.ts`。这些是本机临时证据；下文保留可长期审阅的触发条件、观测和最小修复方向，不依赖临时文件才能理解结论。

## 本轮修复：C2C-033

成功 Computer Use 终态先写 terminal marker，再写页面 `final`。如果第二步失败，严格的交付快照会隐藏结果，但旧恢复逻辑又把它当作普通取消，导致原结果无法恢复、BOOT 无法继续绑定。

修复将原 marker 只用于内部恢复。请求、session、任务/迭代/阶段、页面和代次必须匹配；仍经同一页面状态机核对原回复、candidate/final、完成证据及结果。只有精确 `final` 持久化后，消费者才能从快照得到交付结果。没有放宽缺少完成证据的旧 final，也没有重新签发已撤销的读取权限。

- 修复前故障注入：恢复测试 5 通过、1 失败，重放后仍是 `result_candidate`，没有可交付结果。
- 首轮修复后定向验证：恢复与迁移共 32/32 通过。
- 最终验证（2026-10-18）：`pnpm typecheck`、`pnpm build`、恢复/迁移定向测试均退出码 0；定向 32/32 通过。`pnpm exec vitest run --maxWorkers=1` 最终退出码 0，46 个文件、625 项全部通过，耗时 294.01 秒。覆盖恢复后的 BOOT `surfaceCommit`、错误回复/请求/结果/时间拒绝、缺少完成证据拒绝及另一 session 保持活动。
- 全量首次日志显示 625 项通过、278.48 秒，但未留存数字退出码，未作为最终成功退出证据；仅重跑全量以补齐该缺口。最终 runner 将原始 stdout/stderr 和真实 `status: 0`、`signal: null`、`error: null` 分别写入 `/tmp/c2c-global-audit/vitest-full-rerun.log` 和 `vitest-full-rerun-exit.json`。类型、构建、定向日志依次为同目录的 `typecheck.log`、`build.log`、`focused-final.log`。
- 全量重跑使用隔离的 `C2C_STATE_DIR=/tmp/c2c-global-audit/isolated-state-rerun`；本轮新增恢复修复通过故障注入验收，未重新执行真实网页验收。C2C-033 的实现与自动验证已完成。

源码责任仍由 `src/control/requests.ts` 持有；Gateway 只将中断重放路由回该责任模块。测试位于 `tests/control-terminal-recovery.test.ts`。

## 初次审计发现与触发证据

以下按发现时的版本保留触发条件和证据；当前实现状态见报告开头的整改记录，不能把历史代码描述当作当前源码行为。

P1 表示应优先修复的权限、凭据或数据完整性问题；P2 表示有具体触发条件的正确性、可靠性或安全加固问题。优先级不是对真实账号已经受损的判断。

### C2C-035 / P1：文件读取绕过执行记录权限

**隔离复现确认。** `src/workspace/identity.ts` 的 `projectDataDirectory` 在 Git 仓库将状态保存到 `.git/codex-with-chatgpt/workspaces/...`；`src/workspace/ignore.ts` 仅将 `.codex-with-chatgpt/` 列为敏感目录，`.git/` 只属于 listing/search 的 noise。`Workspace.readFile` 不拒绝 noise。

探针创建真实 Git 布局和合成执行记录，`readFile` 与 `readMany` 均直接返回该记录。MCP 两个处理器只要求 `workspace.read`，而执行记录工具另有 `execution.read` 及 session/task 约束。仓库主工作树内的普通路径读取因而可以绕开这些限制；共享 Git 元数据中的其他工作树记录也处于同一边界中。探针直接调用源码 API，权限范围来自处理器接线复核，未启动认证传输做账号测试。

最小修复：由内部状态路径的权威解析器提供强制拒绝规则，在文件访问入口按规范路径拒绝实际内部状态目录及别名，不仅增加一个 listing 隐藏规则。验证普通/linked worktree、`read_file`/`read_many` 和合法源码读取。

### C2C-036 / P1：只读 Git diff 可运行外部驱动

**隔离复现确认。** `src/workspace/git.ts` 的 `gitDiff` 缺少 `--no-ext-diff` 和 `--no-textconv`。当仓库或全局 Git 配置存在相应驱动，`git_diff` / `review_context` 可在读取时运行本机程序；过滤 safe paths 并不能禁用驱动。

探针在临时仓库配置两个无害驱动，调用 `gitDiff` 后 textconv 和 external-diff marker 都出现。触发需要已有驱动配置，不能据此声称任意远端文件独自就能执行命令。

最小修复：在实际内容 diff 调用显式禁止两类外部驱动，保留普通 diff 行为；用无害 marker 验证两工具不再执行驱动。

### C2C-037 / P1：当前传输令牌遗漏脱敏

**隔离复现确认。** `src/logger/index.ts` 的 `REDACT_PATTERNS` 没有 `c2c_mcp_`。裸令牌和路径中的令牌不能依靠通用 `token=...` 模式处理；执行输出沿用同一 `redact`。

合成令牌经 `redact` 和 `sanitizeExecutionOutput` 后仍存在，后者返回 `allowed: true`。探针只记录布尔值，没有将令牌值写入报告。该令牌是传输门禁；泄漏不等于同时获得 turn capability。

最小修复：统一当前凭据格式的脱敏规则，覆盖裸值、`/mcp/<token>`、结构化日志与执行输出，避免每个消费者各自维护前缀列表。

### C2C-038 / P1：失败回滚覆盖独立配置修改

**helper 隔离复现确认，CLI 调用链静态确认。** `src/cli/index.ts` 的 `machine setup` 在安装前 snapshot 整份 Codex 配置，catch 无条件调用 `src/config/sandbox-allow.ts` 的 `restoreCodexConfig`；即使失败发生在本事务尚未写配置之前，也会恢复整份旧文件。安装锁不能排他保护外部编辑器或其他配置写者。

临时配置探针确认：snapshot 后的独立编辑被覆盖；原先缺失、随后由另一写者创建的文件被删除。未对真实配置或完整 CLI 做并发故障注入。

最小修复：仅在本事务实际写入配置后登记回滚，并验证 postimage 后再逆转本事务修改；冲突时保留独立修改并明确报错。验证安装早期失败、并发编辑和独立新建配置。

### C2C-039 / P2：路径校验与打开之间存在替换竞态

**静态发现，未进行确定性竞态复现。** `src/workspace/manager.ts` 的 `readFile` 先解析 realpath，随后异步 stat、打开探测二进制，再按路径创建流。并发本地写者可在这些步骤间替换叶子或祖先链接，使读取对象不同于已校验对象。Node 搜索有同类边界；`read-image.ts` 的叶子 `O_NOFOLLOW` 不能保护祖先。

最小修复：将包含性/对象身份验证绑定到实际读取的 descriptor，并处理祖先替换；共用同一安全打开规则。补确定性同步点测试，不以普通 symlink 拒绝测试代替竞态验证。

### C2C-040 / P2：JSON 密码与密钥字段未脱敏

**隔离复现确认。** `src/execution/sanitize.ts` 的字段规则不接受键名后的 JSON 引号，`password`、`secret` 等 JSON 字段可能穿过；logger 的通用字段规则也不覆盖这些键。

合成 JSON 的 password/secret 值保留，sanitizer 返回 `allowed: true`。最小修复：完善带引号/不同空白的结构化字段处理，统一消费者规则；保留已有私钥整段拒绝及大小上限。

### C2C-041 / P2：已注册工作区不刷新 `.c2cignore`

**静态发现。** `src/workspace/ignore.ts` 只在 constructor 读取规则；`src/gateway/workspace-registry.ts` 的 `register` 即使构造新 Workspace，命中已有 fingerprint 仍返回旧 registration。新增敏感规则在现有实例以及重复登记后均不生效，直到重启；初始读取失败还会静默退回默认规则。

最小修复：明确一处规则刷新/失效责任，在必要时重新加载；读取失败应保留既有保护或拒绝不确定访问。验证注册后收紧规则、重复登记和读取失败。

### C2C-042 / P2：文件返回预算没有限制扫描和单行内存

**静态发现，未运行耗尽内存实验。** `src/workspace/manager.ts` 的 readline 在检查 `maxBytes` 前已组装完整一行，超长无换行文件可能大量占用内存；即使取到请求范围，仍继续读 EOF 计算 `totalLines`。`read_many` 可放大资源消耗。

最小修复：在 chunk 层限制扫描量/行长；精确总行数需有文件大小前提，否则返回受限或未知信息并说明契约。验证有限预算下早停，不新增无界全文件扫描。

### C2C-043 / P2：ripgrep 错误被当成成功空结果

**隔离复现确认。** `src/workspace/search.ts` 的 close handler 忽略退出码和 signal。非法正则 `a(` 使 rg 退出码为 2，但 `searchWorkspace` 正常返回 `engine: ripgrep`、零匹配、`truncated: false`。

最小修复：区分 0、正常无匹配的 1、执行错误和主动达到 limit 的终止；错误消息有界并脱敏。验证非法 regex、访问错误和正常零结果。

### C2C-044 / P2：子目录工作区 Git diff 坐标不一致

**隔离复现确认。** `src/workspace/git.ts` 的 inventory 返回 repo-relative 路径，但实际 diff pathspec 仍相对 workspace cwd 解释。以仓库的 `app/` 为 workspace 时，`app/changed.txt` 被再次解释为 `app/app/changed.txt`。

探针确认默认 Git diff 有修改，inventory 返回 `app/changed.txt`，API 生成的 pathspec 返回空 diff，而 cwd-relative 的 `changed.txt` 正常。源码 API 返回 `isRepo: true`、零字节 diff。仅实测 unstaged tracked 文件，未覆盖 staged/head 和 linked worktree。

最小修复：统一 inventory、ignore 和 pathspec 的坐标来源，显式采用 workspace-relative 或仓库根语义；覆盖嵌套 workspace 与所有 diff mode。

### C2C-045 / P2：安装版本基线掩盖已存在的更新

**静态发现。** `src/update/check.ts` 的 metadata 路径以 `remote !== local && remote !== baseline` 判断更新；`src/update/source-metadata.ts` 的 baseline 只是安装时观测的远端 tip，没有证明该提交包含在安装版本中。

从旧 A 安装、当时远端已是 B，metadata 记录 local=A/baseline=B；远端仍为 B 时会报告无更新。checkout 路径有祖先检查，installed runtime 路径没有相同证据。最小修复：只有证实 baseline 已被安装内容包含时才能抑制提示，否则报告更新或未知，不以“曾观测到”代替“已安装”。

### C2C-046 / P2：SSH 源地址用户名丢失且规范化不幂等

**隔离复现确认。** `src/update/source-metadata.ts` 的 `sanitizeRepository` 对 URL 无条件清空 username/password，而 scp 分支首次保留 username。`git@host:path` 首次转成 `ssh://git@host/path`，再次清理后失去 `git@`；直接 SSH URL 首次就丢失。

这会改变 SSH 连接身份，导致常见托管源更新失败。探针仅使用保留的 `.invalid` 域名，没有连接网络。最小修复：按协议处理凭据，保留 SSH 所需 username、删除 password/HTTP 凭据，并验证 scp/SSH 往返幂等。

### C2C-047 / P2：首次并发读取传输令牌可能意外轮换

**静态发现，未执行多进程时序注入。** `src/config/http-auth.ts` 的 `requireHttpAuthToken` 在锁外检查不存在，然后调用强制 rotate。两个首次调用都读到 missing 后，会依次轮换，使第一个调用刚返回的令牌立即失效；并发 `auth show` 不受 machine setup 锁保护。

最小修复：初始化在同一 token 锁内二次检查并复用已有值；显式 rotate 才强制轮换。用双进程 barrier 验证两次首次获取返回同一 token，且显式轮换仍失效旧值。

### C2C-048 / P2：runtime 发布后清理错误绕过 rollback

**静态发现，未注入文件系统清理故障。** `src/config/runtime-install.ts` 在 publish current 后、进入 launcher rollback 的 try 前清理 buildStage。此时删除失败会跳到外层 catch，current 已改变却未恢复。`skill install` 直接调用该安装器，不能依赖 machine setup 外层补偿。

最小修复：把清理放到发布前，或将全部发布后失败纳入统一回滚边界；注入该断点验证 current、launcher 和实际返回状态一致。

### C2C-049 / P2：CLI 无法表达纯网页研究的空 scopes

**静态契约不一致。** `skill/SKILL.md` 和 `docs/protocol.md` 规定 web-only research 无需本地 scopes；`src/cli/index.ts` 的 `parseScopes` 却拒绝空列表，缺省授予全部 TURN_SCOPES。只有插件身份发现有另行隐式空列表，普通网页研究无法按文档最小授权。

admin schema/broker 已支持空 scopes。最小修复：明确一个显式零 scope 的 CLI 输入并在同一解析器实现，更新帮助和文档；验证空权限不能读取仓库，同时能够完成纯网页研究工作流。

### C2C-050 / P1：文件与目录互换时 diff 重新包含敏感路径

**整改独立复核新增，初始为静态证据。** 此缺陷在 `b33bfcd` 已存在：Git 的 literal pathspec 仍递归匹配目录。若 HEAD 中的普通文件 `app/public` 被删除，并新增内容不同的 `app/public/.env`，inventory 会分别列出安全删除和敏感新增；只将安全路径传入内容 diff，仍会让 `:(top,literal)app/public` 匹配敏感后代。目录替换为文件也可能泄漏已删除的敏感内容，影响共用入口的 `git_diff` 和 `review_context`。

修复要求：每个内容 batch 都保留 inventory 拒绝路径的强制排除，包括被拒 rename 的两个端点；不能让正向 pathspec 扩大已批准的集合。补文件到目录、目录到文件的回归，并保留合法修改正向覆盖。超出参数预算时应拒绝，不得删掉排除条件继续执行。

## 可选的结构简化

以下是维护性方向，不作为已证实的运行缺陷或合并门禁。删除公开接口前必须核对外部消费者和升级影响。

- `requests.ts` 的 terminal marker kind 只剩 `cancelled`，文件名/时间字段 helper 及 kind 条件分支可随相关修复收敛，避免保留没有第二种语义的泛化。
- `result-schema.ts` 的 limits/factory 仅剩一套实际策略，可评估直接共享 schema 与常量；不能以少几行代码为由复制限制或删掉必要校验。
- Gateway 的 `controlBindingForTurn` 未发现消费者；completion fence 的 Gateway 封装及 `commitSessionRoute` 当前只发现测试消费者。先核对公开导出与外部使用，再决定退役，不能仅因仓库内无生产引用就直接删除。
- `Workspace.resolve` 的公开 `allowSensitive` 选项保留；本轮已明确它不能绕过 Git 元数据或内部状态拒绝规则。此前未生效的 `GitDiffOptions.path` 已实现为 workspace-relative scope，并保留第三参数调用方式。
- surface 状态读路径会重写 machine/mirror，request 路径 helper 反复验证 migration marker，存在职责和 I/O 收敛空间。本轮没有性能 benchmark，不能声称某种改写必然提升延迟。

## 验收边界与后续顺序

12 个 MCP 工具都已声明 `outputSchema`，成功结果使用 `structuredContent`；`read_many` 不再缺失输出架构。这是接口契约检查，不消除上面的访问边界问题。

整改沿现有责任模块收敛：凭据规则由 logger 持有，安全打开由 descriptor helper 持有，路径可见性由 Workspace 持有，Git scope 与安全筛选各有明确语义。公开接口保留或扩展，不另起替代状态源或无边界的重构。其余可选简化不作为缺陷，也不声称已实施。

本轮未验证 Windows 原生行为、全部文件系统竞态、真实账号攻击或新的网页端到端流程。原七组临时探针用于记录发现，本轮对应修复已补入项目回归；定向通过与最终全量结果分别记录，不将自动测试扩大解释为所有运行环境均已验收。
