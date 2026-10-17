# 2026-10-18 全仓审计

本轮完成全仓静态审计和七组隔离复现，**全局质量验收未通过**。现有自动测试通过不能证明下列权限、脱敏和事务边界没有缺陷。本轮只修复待合并变更中的 Computer Use 成功终态恢复问题；其余发现保持开放，没有将审计请求扩大为全仓重构。

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

## 开放问题

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

## 可选的结构简化

以下是维护性方向，不作为已证实的运行缺陷或合并门禁。删除公开接口前必须核对外部消费者和升级影响。

- `requests.ts` 的 terminal marker kind 只剩 `cancelled`，文件名/时间字段 helper 及 kind 条件分支可随相关修复收敛，避免保留没有第二种语义的泛化。
- `result-schema.ts` 的 limits/factory 仅剩一套实际策略，可评估直接共享 schema 与常量；不能以少几行代码为由复制限制或删掉必要校验。
- Gateway 的 `controlBindingForTurn` 未发现消费者；completion fence 的 Gateway 封装及 `commitSessionRoute` 当前只发现测试消费者。先核对公开导出与外部使用，再决定退役，不能仅因仓库内无生产引用就直接删除。
- `Workspace.resolve` 的 `allowSensitive` 未发现当前消费者，属于可审查的绕过开关；`GitDiffOptions.path` 未实际参与实现，需澄清或移除未生效契约。
- surface 状态读路径会重写 machine/mirror，request 路径 helper 反复验证 migration marker，存在职责和 I/O 收敛空间。本轮没有性能 benchmark，不能声称某种改写必然提升延迟。

## 验收边界与后续顺序

12 个 MCP 工具都已声明 `outputSchema`，成功结果使用 `structuredContent`；`read_many` 不再缺失输出架构。这是接口契约检查，不消除上面的访问边界问题。

建议先修复 C2C-035 至 C2C-038，再处理文件打开/资源边界与其余正确性问题；每项沿现有责任模块收敛，避免引入第二套状态或权限判断。结构简化与相关修复一起完成，不另起无边界的重构。

本轮未验证 Windows 原生行为、全部文件系统竞态、真实账号攻击或新的网页端到端流程。七组临时探针不是长期回归测试；对应修复应补入项目测试。合并当前变更也不代表这 15 项开放问题已经解决。
