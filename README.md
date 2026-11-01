# Magpie TT Media 0.9.0

为 TokenDance 提供 Codex 会话附件读取能力。不修改 Magpie 主程序，不修改 Codex 会话记录。零 npm 依赖，使用 Magpie 的 Bun 插件宿主运行。

## 安装

在 Magpie 设置 → 插件中添加此项目的绝对文件夹路径，启用插件。也可以运行：

```sh
magpie plugin add "$HOME/Desktop/magpie-tt-media"
```

然后打开 Magpie 侧栏的「TT 会话附件」。输入 Codex 会话 UUID 查看图片或视频。添加插件及首次打开页面时由 Magpie 启动插件宿主；不需要独立启动命令。默认本地服务监听 `127.0.0.1:43821`。

使用现有 Magpie Web 服务从手机访问插件页面，附件服务通过 Magpie 的插件服务代理访问，无须向局域网额外开放 43821 端口。Web 页面 URL 含访问令牌，应视为私密链接。

当前截图对应的会话 UUID：`01a1928b-99a7-7ca0-8a60-11ee7af8e1bf`。

## 能力及边界

- 读取 `$CODEX_HOME/sessions` 和 `archived_sessions`，默认 `~/.codex`。
- 提取 `response_item` 的用户、助手、工具内容中的图片/视频 Data URL。
- 识别结构化 `path`、Codex 图片包装的 `path="..."` 和 Markdown 本地图片引用。
- 本地 PNG/JPEG/WebP/GIF/HEIC、MP4/MOV/M4V/WebM；具体解码由客户端支持情况决定。
- 返回原始记录行号、时间、角色和 callID，供 TT 对应消息。同一消息已有内嵌图片覆盖全部图片包装时，跳过包装中的本地原图路径，避免同一附件显示两次；其余附件按来源去重。
- 图片按需读取；本地视频支持 HTTP Range、HEAD，以便播放器拖动。
- `.jsonl.zst` 归档需要系统已安装 `zstd`，否则返回错误。
- 初版仅支持本机 Codex。远程会话、其他客户端和生成视频供应商任务 ID 暂不支持。
- 临时文件已删除时跳过本地引用；若记录同时保存内嵌图片，仍可提取。
- 不抓取远程网址，不读取任意请求传入的文件路径，不在磁盘另存附件。
- 最多缓存 8 条会话；插件重启或缓存淘汰后重新查询会话即可。

## TT 接入

此插件不会自动改变 TT 现有界面，需要 TT 后续接入。

1. 用现有 Magpie Web 登录方式请求 `GET /api/plugin-pages`。
2. 查找 `name == "magpie-tt-media"` 的页面。其 `url` 是页面地址，`service` 是相对该页面地址的服务根路径。按 URL 标准解析两次得到服务根地址，不要硬编码页面令牌。
3. 首次使用先 GET 服务根路径 `/`，触发 Magpie 启动插件宿主；若启动期间返回 502，待页面/服务启动后再读取。
4. 请求根路径下的 `session?agent=codex&id=<UUID>`。
5. 将每个附件的 `url` 相对服务根地址解析，加载图片或视频；不得相对 `/session` 的带查询地址拼接字符串。
6. 当前会话更新后重新查询附件列表。用 `id` 稳定标识附件，结合 `line`、`role`、`timestamp`、`callID` 关联消息；这些不是 TT 当前 turn.index，不能直接当作消息索引。

### 接口

- `GET health` → 插件版本、支持的 agent。
- `GET session?agent=codex&id=<UUID>` → `{agent, session, revision, attachments:[{id,role,line,timestamp,itemType,callID,name,mime,size,kind,url}]}`。
- `GET/HEAD media/<id>` → 二进制附件；可带单段 `Range: bytes=0-1023`。必须先查询其会话，服务才持有对应附件标识。

服务只绑定 loopback。远程访问复用 Magpie Web 的插件页面令牌与网络访问控制；不要把本地服务改成 `0.0.0.0` 后直接暴露。服务仅提供会话记录引用的媒体，并不提供通用文件浏览接口。

## 开发与验证状态

基于本机 Magpie 0.1.2306 源码的插件加载方式、`magpie.page.service` 和 Web 服务代理实现。
已做 JavaScript 语法检查；未运行插件、构建或自动化测试，未安装到当前 Magpie，由用户在 Magpie/手机上验收。

验收：打开插件页，输入上面的会话 UUID，确认 IMG_2815 对应图片可见；在手机 Magpie Web 打开相同页面确认可见；包含本地视频引用的会话可播放并拖动进度。TT 原界面需接入后另行验收。

## 0.3.0：Codex 轮次与工具事件

新增 `GET activity?id=<UUID>&after=<cursor>&epoch=<epoch>`。返回 `epoch`、`cursor`、`reset`、`current`、`turns`、`events`；事件仅保留最近 200 项，轮次最近 30 项。首次读取或游标重置时 `reset=true`，调用方建立基线，不重播历史完成。

轮次按 task_started/task_complete 的 turn_id 配对；显式 turn_aborted/task_aborted 记为取消。缺少开始时 startedAt 为 null，异常退出没有结束记录时不能确认完成。工具按 call_id 配对，返回不代表成功。只识别明确的工具名/exec 内部调用形式；消息记录标为 reply_recorded，不能据此认定正在逐 token 输出。

实时接口只读取明文 jsonl，归档 zst 返回 422。首次扫描后按文件新增字节解析，未完成行留待下一次读取。接口不另存原始日志、命令内容或回复正文。安装更新后关闭再开启插件，TT 才能使用新接口。此版本未编译或运行测试，用户真机验收。

### 会话累计计时（0.3.0）

`/activity` 新增 `completedSeconds`（全部已结束轮次秒数）、`incompleteTurns`（无法完整计时的轮次数）；current 新增 `timingIncomplete`。TT 将可计时的当前轮实时加入累计，排除轮间空闲。

每个会话按 UUID 保存到 `$CODEX_HOME/tt-activity/<UUID>.json`，默认 `~/.codex/tt-activity/`。保存轮次、工具、读取偏移和未完成行，后续按字节增量读取。内存最多 8 个会话不影响磁盘统计；首次无缓存时从原始日志补算全部历史。日志替换或截断时从原始日志重建。最近 30 轮仅是接口显示范围，不限制累计。

插件重启或内存缓存重新加载后，没有结束事件的旧轮次标记计时不完整，不继续按当前时间增长；明确结束事件补齐后恢复完整累计。不会靠静默时长推测结束。新轮开始会重新正常计时。仍不支持实时压缩日志。

### 附件顺序修复（0.3.1）

工具返回数组中的文本参与附件关联；附件新增 userText（所属用户消息）和 toolInput（按 callID 找到的调用输入）。TT 用这些锚点定位轮次与工具，图片随所属内容展示，不再统一追加到会话末尾。需要重新启用插件。

## 0.4.0：Claude 会话图片

`GET /session?agent=claude|claude-desktop&id=<会话 UUID>` 读取 `~/.claude/projects/*/<UUID>.jsonl`（可用 `CLAUDE_CONFIG_DIR` 或插件选项 `claudeHome` 改位置），把用户消息里的 base64 图片作为附件返回，字段与 Codex 一致。Magpie 自己的会话接口只给这些图片留 `[image]`。仅覆盖 Claude Code 及 Claude Desktop Code 标签页的会话文件；普通 Claude Desktop 聊天没有本地会话文件，返回 404。更新后需在 Magpie 关闭再开启插件。

## 0.5.0：Claude 轮次与工具事件

`GET /activity?agent=claude|claude-desktop&id=<会话 UUID>` 返回与 Codex 相同结构的轮次、计时和工具事件。轮次从真实用户提问开始，到 `stop_reason: end_turn` 的 assistant 记录结束；工具按 `tool_use_id` 配对，返回仅表示已返回。子代理记录不计入。进度缓存在 `~/.claude/tt-activity/`。更新后需在 Magpie 关闭再开启插件。

## 0.6.0：动作摘要

工具事件的 `detail` 现在是摘要：Claude 的 Bash 优先用入参 `description`，否则提炼命令（跳过 `cd`/`pwd` 等前缀、变量赋值、heredoc，只取第一条命令）；Read/Edit 取文件名。Codex 命令同样提炼。事件新增 `described`，表示 `detail` 来自描述而非原始命令。

## 0.7.0：Claude 会话保留最新内容

`GET /transcript?agent=claude|claude-desktop&id=<会话 UUID>` 返回与 Magpie `/api/sessions/transcript` 相同结构的 `parts`，但从文件末尾往前收集 40 万字符，保留最新内容（Magpie 自身从开头累计，长会话会丢掉较新的部分）。单个 part 超过 8000 字符会截断并记录 `cut`；子代理记录不计入。更新后需在 Magpie 关闭再开启插件。

## 0.8.0：Codex 会话保留最新内容

`GET /transcript?agent=codex&id=<会话 UUID>` 与 Claude 版同结构，从 rollout 末尾往前收集 40 万字符。转换规则对齐 Magpie：消息、推理摘要、`function_call`/`custom_tool_call`/`local_shell_call` 及其输出，助手部分带上最近的 `turn_context` 模型，支持 `.jsonl.zst`。

## 0.9.0：part 稳定标识

`/transcript` 的每个 part 带 `seq`：该内容在会话文件里的行号乘 1000，加它在这一行内的序号。窗口起点随会话增长向后移动时，同一内容的 `seq` 不变，调用方据此识别内容。

## Kilo 订阅

`GET /kilo` 给 TokenDance 读取 Kilo 订阅。从 `~/.config/magpie/providers.json`（`{providers, groups}`）取出 id 为 `kilo` 的 provider 的 API key，以 `Authorization: Bearer` 请求：

- `GET https://api.kilo.ai/api/trpc/kiloPass.getState`，订阅在 `result.data.subscription`。
- `GET https://api.kilo.ai/api/profile/balance`，返回 `{"balance": number}`。

成功时返回 `tier`、`cadence`、`status`、`cancelAtPeriodEnd`、`startedAt`、`nextBillingAt`、`refillAt`、`currentPeriodBaseCreditsUsd`、`currentPeriodUsageUsd`、`currentPeriodBonusCreditsUsd`、`isBonusUnlocked`、`nextBonusCreditsUsd`、`currentStreakMonths`，以及 `balance`。不返回 stripe id、subscription id，或其他任何 id 与 key。没有配置 kilo，或上游请求失败时，返回带 `error` 字段的 JSON。

## Cursor 用量

`GET /cursor` 给 TokenDance 读取 Cursor 用量明细。每次请求读取 `~/.config/magpie/plugin-auth.json` 的 `cursor.access`（JWT）。令牌刷新由 Magpie 自己的插件负责，此路由不刷新，也不返回或记录 token、邮箱和 id。

- `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo`，取 `planName`、`includedUsagePeriod`、`includedUsageResetsAt`。
- `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`，取本周期起止、`planUsage` 的 auto/api/total 百分比和 `displayMessage`。
- `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents`，从该周期 `billingCycleStart` 起按每页 50 条翻到 `totalUsageEventsCount`。插件按模型汇总全部事件（`cents` 降序），`events` 只留最近 50 条；`kind` 去掉 `USAGE_EVENT_KIND_` 前缀并转小写。
- `GET https://cursor.com/api/usage-summary`，取账单周期、`membershipType`、`individualUsage.plan` 与 `onDemand`。

成功时返回 `plan`、`week`、`month`、`models`、`events`、`totalEvents`、`updatedAt`。未登录 Cursor 返回 404，上游失败返回 502，不重试。
