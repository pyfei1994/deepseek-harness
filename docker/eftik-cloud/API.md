# eftik-dsh-cloud 网关接口文档

> 适用版本：镜像 `eftik-dsh-cloud:0.6.20`（网关 `gateway/1.7`，内核 `@deepseek-ai/dsh 0.1.5-rc.2`）
>
> 镜像 tag 自 0.5.0 起与网关版本对齐（0.5.0 = 网关 v0.5）；镜像自身修订从第三位递增（0.5.1、0.5.2…），网关升版则前两位跟随
> 更新时间：2026-09-13

网关运行在每个用户的 DSH 工作台容器内，监听容器 `0.0.0.0:8090`，是业务后端（kitsume）操作工作台的唯一入口。业务方不直接接触 dsh CLI。

---

## 1. 基础约定

### 1.1 鉴权

所有接口（无例外）要求请求头携带工作台 token：

```
X-GW-Token: <gwToken>
```

- `gwToken` 由业务后端在**创建工作台时生成**（建议 128-bit 随机 hex），通过 Applaunchpad 的 `env` 注入容器，同时存入业务库（`ek_dsh_workspace.gw_token`）
- 缺失或错误一律返回 `401 {"error":"invalid gateway token"}`
- token 等于容器的"远程执行权"，**只存后端，永不下发前端、不打日志**

### 1.2 基础地址

| 阶段 | 地址 |
|------|------|
| M1（后端在集群外） | Sealos 分配的公网地址，如 `https://xxxxxxxx.sealoshzh.site`（端口 `isPublic: true`） |
| M2（后端迁入集群） | Applaunchpad `privateAddress`，如 `http://dsh-u8f3a2-8090-xxx.ns-xxxx:8090`（`isPublic: false`，公网零暴露） |

### 1.3 统一错误格式

```json
{ "error": "人类可读的错误描述" }
```

| HTTP 状态码 | 含义 |
|------------|------|
| 200 | 成功 |
| 400 | 参数错误（缺失/超长/非法枚举值） |
| 401 | token 缺失或错误 |
| 404 | 任务不存在 / 路径不存在 |
| 500 | 网关内部错误（含 dsh 启动失败） |

### 1.4 执行模型

- 任务**异步**：`/chat` 提交后立即返回 `task_id`，通过 `/task/:id` 或 `/task/:id/stream` 获取结果
- 任务在容器内**串行**执行（同一时刻一个 agent 任务），后续提交状态为 `queued`
- 单任务超时 **10 分钟**（容器环境变量 `DSH_TIMEOUT_MS` 毫秒可调），超时状态 `timeout`
- 任务结果保存在容器内存中，容器重启后清空；跨任务的对话记忆由业务后端持久化并通过 `history` 传回

---

## 2. 健康检查

### GET /health

**返回**

```json
{
  "ok": true,
  "dsh": "0.1.5-rc.2",
  "version": "gateway/1.7",
  "jobs": 0
}
```

| 字段 | 说明 |
|------|------|
| `ok` | 固定 true（能响应即健康） |
| `dsh` | 内核版本 |
| `version` | 网关版本（排查线上容器镜像用） |
| `jobs` | 网关内存中的任务数 |

> 创建工作台后的就绪探测即调用此接口。

---

## 3. 工作台设置

工作台级设置，持久化在容器 `GW_SETTINGS_PATH`（默认 `/home/node/.dsh/eftik-settings.json`，在 **dsh-home PVC** 上、workspace 之外，容器重建不丢）。设置在**提交任务时**生效快照——进行中的任务不受影响。

### 产品模式（多租户上线必开）

创建容器时注入环境变量 `GW_PRODUCT_MODE=1` 后，设置接口按「平台 / 用户」两级权限工作：

| 环境变量 | 说明 |
|----------|------|
| `GW_PRODUCT_MODE=1` | 开启产品模式（不设则网关行为同 0.3，demo 用） |
| `GW_ADMIN_TOKEN` | 平台管理令牌，请求头 `X-GW-Admin` 携带者视为平台（由 kitsume 后端持有，**与 gwToken 分开保管**） |
| `GW_PRESET_BACKGROUND` / `GW_PRESET_MEMORY` | 平台预设角色背景/记忆（建议经 Sealos env `secretKeyRef` 注入），作为默认值，用户不可见不可改 |
| `GW_WORKDIR` | dsh 执行工作目录，默认 `/workspace`（spawn cwd 锁定 + 系统前导声明） |
| `GW_SETTINGS_PATH` | 设置文件路径，默认 `/home/node/.dsh/eftik-settings.json` |

产品模式下的访问规则：

| 字段 | 用户（仅 X-GW-Token） | 平台（额外 X-GW-Admin） |
|------|----------------------|------------------------|
| `model` / `provider` / `reasoning` | 可改 | 可改 |
| `permissionMode` | **锁定为部署值**（`DSH_PERMISSION_MODE`，默认 workspace-write），改 `danger-full-access` 会被静默忽略 | 可改 |
| `background` / `memory` | **GET 不返回、POST 修改被忽略** | 可读可写 |

配合 `permissionMode=workspace-write`（dsh 官方沙箱：只允许写工作区）+ spawn `cwd=/workspace` + 设置文件移出 workspace，实现：**用户只能在 workspace 内办公，且看不到、改不了平台预设的角色与记忆**。

> 说明：任务前导 `<system-context>` 会注入保密指令（禁止模型复述系统设定），但大模型没有 100% 防社工泄露的保证；预设中不要放敏感凭据，敏感数据只走平台侧。

### 设置字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `model` | string | `""`（内核默认 `deepseek-v4-flash`） | 大模型名称，如 `deepseek-v4-flash`。通过 `--patch` 覆盖内核 `agent-default-model` 插件 |
| `provider` | string | `""`（即 `deepseek-official`） | 模型提供方，一般不填 |
| `permissionMode` | enum | `workspace-write` | 权限档位（官方原生预设，sandbox + 审批策略联动）：<br>`read-only` 只读沙箱，不可写文件不可执行写操作<br>`workspace-write` 可读写工作区、执行命令（默认）<br>`danger-full-access` 全权访问 + 免审批自动执行（产品模式下用户锁定，不可选） |
| `reasoning` | enum | `high` | 推理强度 `off` / `low` / `high` / `max`（与 dsh `llm-deepseek` provider 的 `reasoningEffort` 值域一致，可由 `GW_PRESET_REASONING` 预设）。**真实生效**：SDK profile 经 `initialize.reasoningEffort` 下发，headless profile 经 patch `agent-default-model.config.reasoningEffort` 下发。`off` 关闭思考（此时不产出 `thinking` 事件）。旧值 `balanced` 读盘时自动映射为 `high` |
| `background` | string ≤32KB | `""`（可由 `GW_PRESET_BACKGROUND` 预设） | 角色背景/人设，每次任务前注入 `<system-context>`。产品模式仅平台可读写 |
| `memory` | string ≤32KB | `""`（可由 `GW_PRESET_MEMORY` 预设） | 长期记忆（事实、偏好），注入方式同上。产品模式仅平台可读写 |

### GET /settings

读取当前设置。

- 非产品模式 / 平台请求：返回全部字段
- 产品模式 + 用户请求：不返回 `background`/`memory`，附加 `permissionModeLocked: true`、`presetLocked: true`

### POST /settings

部分更新（只传要改的字段），服务端合并后持久化，返回更新后的设置（用户视角已脱敏）。

**请求示例**

```bash
curl -X POST https://<工作台地址>/settings \
  -H "X-GW-Token: <gwToken>" \
  -H "X-GW-Admin: <adminToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash",
    "permissionMode": "workspace-write",
    "reasoning": "high",
    "background": "你叫狐仙，是狐分身产品的AI助手，说话简洁专业，永远用中文。",
    "memory": "用户是苏州易飞钛科创始人，偏好直接给结论。"
  }'
```

**参数校验失败示例（400）**

```json
{ "error": "permissionMode 须为 read-only / workspace-write / danger-full-access" }
```

### DELETE /settings

重置为默认值（平台 env 预设保留），返回重置后的设置。

---

## 3.5 会话（gateway/1.2）

一次「会话」= 一条连续对话线程。**会话元信息由网关记账**（落 `GW_SESSIONS_PATH`，默认 `/home/node/.dsh/eftik-sessions.json`），**上下文由 dsh 内核按 `sessionId` 维护**。

> 为什么要网关自己记账：dsh SDK 协议只有 `initialize` / `session/prompt` / `shutdown` 三个方法，既没有「列会话」也没有「删会话」，内核的会话存储不对外暴露。所以网关另存一份元信息（标题/时间/消息数/消息正文），既能给业务方做会话列表，也能做记录回看。

### GET /sessions

会话列表，按 `updatedAt` 倒序。

```json
{
  "sessions": [
    {
      "id": "s-m1k2x9-a7f3d2",
      "title": "帮我写一个 Python 脚本批量重命名文件…",
      "createdAt": 1788620082854,
      "updatedAt": 1788620100000,
      "messageCount": 4,
      "preview": "好的，这是一个批量重命名脚本…"
    }
  ]
}
```

### POST /sessions

新建会话。会话真正产生上下文是在首次 `/chat` 带该 `sessionId` 时（dsh 惰性创建）。

**请求体（可选）**

```json
{ "title": "自定义标题（省略则由首条消息自动生成）" }
```

**返回（200）**：`{ "id", "title", "createdAt" }`

### GET /sessions/{id}

单个会话的全部消息（正序），供「查看会话记录」。

```json
{
  "id": "s-m1k2x9-a7f3d2",
  "title": "帮我写一个 Python 脚本…",
  "createdAt": 1788620082854,
  "updatedAt": 1788620100000,
  "messages": [
    { "role": "user", "content": "帮我写一个脚本", "createdAt": 1788620082854 },
    { "role": "assistant", "content": "好的，这是脚本…", "createdAt": 1788620090000 }
  ]
}
```

### DELETE /sessions/{id}

删除会话记录，并终止其正在运行的任务。

**删除语义（重要）**：SDK 协议没有删会话方法，所以本接口**两侧都清**：

1. **网关侧记账** —— `/sessions` 列表的数据源；
2. **内核磁盘上的会话目录** —— `<DSH_HOME>/sessions/--workspace--/<sessionId>/`
   （含 `session.vox.jsonl.zstd` 与 `session.lock`）。

第 2 步自 **gateway/1.7** 起是必需的：sdk-session-resume 插件创建会话时会优先
`resume` 磁盘上的已有会话，若只删网关记账，用户删除会话后新建同 id 会把旧上下文
整个捞回来（表现为「删了还在」）。实现见 `purgeKernelSessionDir()`；若该会话有任务
正在运行，会先 SIGKILL 任务、再延迟 1.5s 重试一次删除（等锁释放）。

> gateway/1.6 及更早版本只删网关记账（当时的假设是「被删的 sessionId 不会再被使用」），
> 该假设在 gateway/1.7 引入 resume 后不再成立，故补上第 2 步。

**返回（200）**：`{ "ok": true }`；不存在返回 404。

---

## 4. 任务

### POST /chat

提交一个 agent 任务。

**请求体（三选一）**

```jsonc
// 方式一：完整任务文本（适合一次性指令）
{ "task": "在 /workspace 写一个 hello.py 并运行验证" }

// 方式二：会话续聊（推荐，gateway/1.2+）——只发本条消息，历史由 dsh 内核承接
{ "message": "刚才写的脚本跑通了吗？", "sessionId": "s-m1k2x9-a7f3d2" }

// 方式三：旧式全量历史（无 sessionId 时兼容保留；历史由业务后端持久化裁剪后传入，建议 ≤20 条）
{
  "message": "刚才写的脚本跑通了吗？",
  "history": [
    { "role": "user", "content": "上一轮用户消息" },
    { "role": "assistant", "content": "上一轮助手回答" }
  ]
}
```

> **`sessionId` 的存在与否决定上下文怎么来**：
> - **带 `sessionId`**：dsh 内核按该 id 自己记着上文，网关**只把本条消息**拼上系统前导发过去。prompt 长度不随对话轮数增长，也避免了「每次提问重发全部历史」的浪费。
> - **不带 `sessionId`**：退回旧行为，由调用方传 `history` 全量拼接。
>
> 提交时的 `settings` 快照会应用到该任务（模型、权限、推理强度、背景等）。

**可选字段**

| 字段 | 类型 | 说明 |
|------|------|------|
| `task` | string | 完整任务文本（与 `message` 二选一） |
| `message` | string | 本条用户消息 |
| `sessionId` | string | 会话 id。给出时本轮消息会记入该会话（不存在则自动建），并且只发本条消息 |
| `history` | array | 全量会话历史（**仅在不带 `sessionId` 时生效**） |
| `profile` | string | 覆盖 dsh profile：`"headless"` 强制一次性输出（无逐字流式）。默认走 `sdk` 真流式 |

**返回（200）**

```json
{ "task_id": "t-1788620082854-ioocuv", "session_id": "s-m1k2x9-a7f3d2" }
```

`session_id` 在不带该字段提交时为 `null`。

**错误**：400（无 task 且无 message / 拼装后超 20 万字符 / JSON 非法）

### GET /task/{task_id}

轮询任务状态与结果。

**返回**

```json
{
  "status": "done",
  "reply": "已完成，hello.py 输出：hello world",
  "error": "",
  "events": [
    { "t": 1788620083000, "text": "dsh: reasoning:" },
    { "t": 1788620083500, "text": "The user wants me to create a script..." }
  ],
  "elapsed_ms": 15230,
  "usage": {"calls":3,"inputTokens":812,"outputTokens":460,"totalTokens":1272,
            "cacheReadTokens":512,"cacheWriteTokens":300,"reasoningTokens":120}
}
```

| 字段 | 说明 |
|------|------|
| `status` | `queued` → `running` → `done` / `failed` / `timeout`（终态） |
| `reply` | agent 最终回答（仅 done 有值） |
| `error` | 失败原因（failed/timeout 时有值） |
| `events` | 执行过程日志行（思考/工具调用，最多 200 条），可展示为"分身正在干活"动态 |
| `elapsed_ms` | 耗时（运行中为已耗时） |
| `usage` | 任务级 token 消耗汇总（运行中/未采集为 `null`）。字段为 provider 精确上报值：`inputTokens` 未命中缓存输入、`outputTokens` 输出（含 reasoning）、`cacheReadTokens` 缓存命中（单价约为普通输入 1/10，计费建议三段分开）、`cacheWriteTokens` 缓存写入、`totalTokens` 官方总计、`calls` LLM 调用次数 |

### GET /task/{task_id}/stream

SSE 实时流（推荐，实现逐字打字机效果）。每个事件以 `event:` + `data:` 两行发出：

```
event: thinking
data: {"text":"用户想要一个脚本…","t":1788620083000}

event: answer
data: {"text":"好的","t":1788620083100}

event: answer
data: {"text":"，我来","t":1788620083350}

event: done
data: {"status":"done","reply":"好的，我来写一个。","error":"","elapsed_ms":15230,"usage":{...}}
```

| 事件 | 含义 |
|------|------|
| `answer` | **正文增量**：SDK `session.event` → `assistant/chunk` 中 `chunk.type === "text-delta"` 的 `chunk.text`，原样下发，前端累加即得打字机效果。完整正文 = 所有 answer 的 `text` 按序拼接（与 `done.reply` 一致） |
| `thinking` | **思考增量**：同一路径下 `chunk.type === "reasoning-delta"` 的 `chunk.text`，剥离标签后下发（ANSI 已清除）。仅在 `settings.reasoning` 非 `off` 且所选模型支持思考时才产出 |
| `log` | 运行日志行（工具调用 `tool/start`/`tool/end`、`step/start`、`turn/start` 等），可展示为"正在干活"动态 |
| `done` | 终态，携带 `reply`/`error`/`elapsed_ms`/`usage`，随后服务端关闭连接 |

- **流式来源**：网关默认以 `--profile sdk` 启动 dsh，走 stdio JSON-RPC；`session.event` 通知按 chunk 推送，延迟 ≈ 模型 token 输出延迟（实测首片 1.3–2.2s）
- 任务终态由 `turn/end` 事件决定（SDK 是常驻会话，`turn/end` 后网关补发 `shutdown` 并兜底 kill），`done` 事件随之发出
- 断开后可回退用 `GET /task/{task_id}` 补拉全量（`reply` 在任务运行期间即为已产出的部分正文）
- 调用方按 `answer` / `thinking` 分流：正文渲染 markdown，思考渲染为可折叠的思考块
- 兼容开关：`DSH_FORCE_HEADLESS=1` 或请求体 `{"profile":"headless"}` 可退回 headless（**无逐字流式**，仅在任务结束一次性给出完整正文，或从 stdout 分块下发）

### DELETE /task/{task_id}

取消任务（尽力 SIGKILL dsh 进程），返回 `{"ok": true}`。

---

## 5. 工作区文件

浏览与下载 `/workspace` 内的文件（网关直接读 PVC，不经过 dsh）。**路径安全**：仅限 workspace
内部——posix normalize 把 `..` 消解在虚拟根内 + `startsWith` 校验 + realpath 二次校验防符号
链接逃逸；单文件下载上限默认 200MB（`GW_MAX_DOWNLOAD_MB` 可调）。

### GET /files?path=/{dir}

列出目录内容。

**返回（200）**

```json
{
  "path": "/",
  "entries": [
    { "name": "sub", "type": "dir", "size": 0, "mtime": 1788671820398 },
    { "name": "hello.txt", "type": "file", "size": 12, "mtime": 1788671820376 }
  ]
}
```

- `path` 不传默认根目录 `/`；目录优先排序，同名按名称排序
- 错误：400（路径越界 / 目标不是目录）、404（路径不存在）、401（token 错误）

### GET /files/download?path=/{file}

下载文件，`application/octet-stream` 流式响应，带 `Content-Length` 与 RFC 5987 编码的
`Content-Disposition`（支持中文文件名）。

```bash
curl -O -J -H "X-GW-Token: <gwToken>" "https://<工作台地址>/files/download?path=/hello.txt"
```

- 错误：400（路径越界 / 目标是目录 / 超过大小上限）、404（文件不存在）

> 上传接口暂未提供（M2 按需设计：multipart + 配额校验）。

### GET /storage

工作区容量。`usedBytes` 为 `/workspace` 内实际文件大小（递归 du 语义，跳过符号链接），
`totalBytes`/`freeBytes` 取挂载点 statfs（PVC 配额）。供业务方（kitsume）在小程序/中台展示存储用量。

**返回（200）**

```json
{
  "path": "/workspace",
  "usedBytes": 1288490188,
  "totalBytes": 5368709120,
  "freeBytes": 4080218932,
  "usedPct": 24
}
```

| 字段 | 说明 |
|------|------|
| `path` | 统计的挂载点（= GW_WORKDIR） |
| `usedBytes` | /workspace 内实际文件总大小（du 语义） |
| `totalBytes` | 文件系统总容量（PVC 大小） |
| `freeBytes` | 非特权用户可写空间（bavail，扣除保留块） |
| `usedPct` | 已用百分比（四舍五入） |

```bash
curl -H "X-GW-Token: <gwToken>" "https://<工作台地址>/storage"
```

### 技能（gateway/0.9）

技能 = 可复用的指令模板（名称 + 图标 + 描述 + prompt）。已启用技能注入每次任务的系统前导
（能力指引）；`POST /chat` 传 `skillId` 可直接按技能执行。持久化于 `/home/node/.dsh/eftik-skills.json`（PVC）。

```
GET    /skills                 -> {"skills":[{id,name,icon,description,prompt,enabled,createdAt,updatedAt}]}
POST   /skills                 {name, icon?, description?, prompt, enabled?} -> skill
PUT    /skills/{id}            部分更新（同上字段可选）
DELETE /skills/{id}            -> {ok:true}
```

`POST /chat` 新增可选 `skillId`：`{skillId, message?}` → 以技能 prompt 为主指令执行任务。

### 定时任务（gateway/0.9）

网关内置 30s 调度 tick，到期任务自动以 `{task: prompt}` 提交执行（与手动任务同一串行队列，
token 消耗同样经 usage-probe 统计）。持久化于 `/home/node/.dsh/eftik-tasks.json`（PVC）。

```
GET    /tasks                  -> {"tasks":[{id,name,icon,description,prompt,schedule,enabled,
                                          lastRunAt,lastStatus,lastError,runs[≤10],createdAt,updatedAt}]}
POST   /tasks                  {name, icon?, description?, prompt, schedule, enabled?} -> task
PUT    /tasks/{id}             部分更新
DELETE /tasks/{id}             -> {ok:true}
POST   /tasks/{id}/run         立即执行一次 -> {task_id}
GET    /tasks/{id}/runs        -> {taskId,lastStatus,lastRunAt,runs[≤10]}
```

schedule 三种形态：

| type | 字段 | 说明 |
|------|------|------|
| `interval` | `minutes` 1~10080 | 每 N 分钟执行一次 |
| `daily` | `time` "HH:MM" | 每天固定时刻 |
| `weekly` | `days` [0-6]、`time` | 每周指定天（0=周日），按容器本地时区（生产建议 env TZ=Asia/Shanghai）|

run 记录：`{id(网关任务id), at, status(done/failed/timeout/running), error, reply(前500字)}`。
容器重启后 `running` 态超过 10 分钟会被调度器标记为 failed（中断）。

---

## 6. 业务后端对接流程（kitsume）

```
1. 用户点"创建工作台"
   后端：生成 gwToken → Applaunchpad POST /apps（镜像 eftik-dsh-cloud:x.y.z，
        env 注入 GW_TOKEN + DEEPSEEK_API_KEY(secretKeyRef)，storage 双 PVC，
        ports: [{number:8090, protocol:"http", isPublic: true|M1、false|M2}])
        → 落库 ek_dsh_workspace
2. 轮询 GET /apps/{name}（Sealos）至 running，拿到 publicAddress/privateAddress
3. 就绪探测：GET {网关地址}/health
4. 对话：
   小程序 → POST kitsume /v1/dsh/workspaces/{id}/chat
   后端：扣积分 → 查 ek_dsh_chat_message 最近 ≤20 条 → 转发 POST /chat（message+history）
        → task_id 落库 ek_dsh_chat_task → 小程序轮询 kitsume 的 task 接口
   后端收到 done：reply 落 ek_dsh_chat_message，回传小程序
5. 闲置：SnailJob 扫描 → Applaunchpad POST /apps/{name}/pause（PVC 保留）
```

**流式链路**：kitsume 后端订阅 `GET /task/{task_id}/stream`，把 `answer` / `thinking` 增量经
小程序上下文（WebSocket 或 SSE）透传，前端用 TDesign `t-chat-markdown` 渲染并显示流式光标；
网关 `done` 到达后，后端把最终 reply 落 `ek_dsh_chat_message` 并下发收尾事件。

---

## 7. 版本记录

| 网关版本 | 镜像 tag | 变更 |
|----------|----------|------|
| gateway/0.1 | 1.0.0 | 首版：chat/task/health，X-GW-Token 鉴权，串行队列 |
| gateway/0.2 | 1.1.0 | `history` 会话历史入参；SSE 实时流；health 带版本号 |
| gateway/0.3 | 1.2.0 | `/settings` 三接口：模型切换（--patch agent-default-model）、permissionMode 官方三档、reasoning 模拟档位、background/memory 人设记忆（PVC 持久化） |
| gateway/0.4 | 1.3.0 | 产品模式 `GW_PRODUCT_MODE`：permissionMode 锁定部署值、background/memory 仅平台（X-GW-Admin）可读写、env 预设注入；设置文件移出 workspace（/home/node/.dsh/，含旧路径自动迁移）；spawn cwd 锁定 /workspace；系统前导注入保密指令与工作目录约定 |
| gateway/0.5 | 0.5.0 | 工作区文件接口：GET /files 目录列表、GET /files/download 流式下载（防穿越/防符号链接逃逸，下载上限 `GW_MAX_DOWNLOAD_MB` 默认 200MB） |
| gateway/0.6 | 0.6.0 | 任务级 token 消耗：/task 与 SSE done 新增 `usage` 字段。经外挂插件 usage-probe（--patch 注入，零内核改动）监听 assistant/message 的 provider 精确 usage 累加落盘，网关读取后随任务返回 |
| gateway/0.7 | 0.6.2 | 工作区容量：GET /storage 返回 /workspace 挂载点 statfs 统计（usedBytes/totalBytes/freeBytes/usedPct），供小程序与中台展示存储用量 |
| gateway/0.8 | 0.6.3 | 修复空工作区已用虚高：usedBytes 改为递归统计 /workspace 实际文件大小（du 语义），totalBytes/freeBytes 仍取 statfs PVC 配额；共享存储池上 statfs used 会计入同盘其他数据 |
| gateway/0.9 | 0.6.4 | 技能与定时任务：/skills、/tasks CRUD + 网关内置 30s 调度器（interval/daily/weekly）、手动触发与执行记录；已启用技能注入系统前导，/chat 支持 skillId |
| gateway/1.0 | 1.0.0 | DeepSeek 凭证管理（/credentials/deepseek，不返回明文）、统一插件视图（/plugins）；生产镜像首次发布 |
| gateway/1.1 | 1.1.0 | `/task/{id}/stream` SSE 真流式（`answer` / `thinking` / `log` / `done`），正文与思考分道下发，支持打字机与可折叠思考块 |
| gateway/1.2 | 1.2.0 | **会话管理**：`/sessions` 列表/新建/删除 + `/sessions/{id}` 记录回看；`/chat` 新增 `sessionId`（同会话只发新消息，历史由 dsh 内核按 sessionId 承接，不再全量重发）。**修复推理未生效**：`reasoning` 值域对齐 provider（off/low/high/max），并真正经 `initialize.reasoningEffort` / patch `agent-default-model` 下发，此前只是提示词等级、深度思考块恒为空 |
| gateway/1.3 | 1.3.0 | 镜像 `0.6.13`：内核升级 `@deepseek-ai/dsh 0.1.2-rc.1 → 0.1.5-rc.1`。**修复「cannot create effect on inactive context」**：`--patch` 覆盖 `agent-default-model` 时 `provider`/`model` 均为必填，原逻辑仅在 `settings.model` 非空时才写 provider，导致「默认设置（model/provider 空串 + reasoning=high）」生成 `config:{reasoningEffort}` → 插件树加载失败 → cordis 判死 fiber → sdk profile 残余插件 `ctx.effect()` 抛 `INACTIVE_EFFECT` 且前端无正文。现改为发 patch 前双双补齐内核默认值，并在 `normalizeSettings` 中把空串归一为 `null` |
| gateway/1.4 | 1.4.0 | 镜像 `0.6.14`：**适配 dsh 0.1.5 的事件结构变更**。① 正文位置从 `message.text` 改为 `message.content[].text`（数组，需筛 `type==="text"`），原实现导致 `reply` 恒为空（「转圈结束但空屏」）；② 新版**取消 `assistant/chunk` 事件**，增量改放 `assistant/message.stream` 的 `text-chunks`/`reasoning-chunks`（`dt[]` 间隔 + `texts[]` 批量），网关新增 `replayAssistantStream` 按 `dt` 缩放回放成打字机增量；③ `turn/end` 新增 `reason` 解析：dsh 在模型失败时（Key 失效/限流/AUTH）不发 JSON-RPC error 而是照常 `turn/end` 并把原因藏在 `data.reason.error`，原实现一律置 `done` 把失败伪装成成功，现按 `reason` 报 `failed` 并透出原始 message；④ 无错误且无正文时不再静默 `done`，明确报错便于诊断 |
| gateway/1.5 | 1.5.0 | 镜像 `0.6.15`：**修复打字机增量被终态吞掉（竞态）**。`assistant/message`（触发回放定时器）与 `turn/end`（置 `done`）在同一批 stdout 行里前后脚到达，而 `streamTask` 是「读到终态即发 `done` 并 `break`」的模型 —— 它在第一个回放定时器触发前就退出了，实测 SSE 里 `answer`/`thinking` 事件数为 **0**（`done` 却在 1.74s 就到达）。修复：新增 `markJobFinished`，把「终态对订阅方可见的时刻」记为 `settledAt = replayUntil`（回放队列预计跑完时刻）；`job.status` 仍立即置位（HTTP 轮询 `/task/{id}` 不受影响），`streamTask` 与 `waitStream` 只在 `Date.now() >= settledAt` 时才发终态。实测：`count to five` → `answer` 9 条；`sqrt(2) 证明` → `thinking` 81 条 + `answer` 785 条，`done` 严格收尾且仅晚 ~0.1s |
| gateway/1.7 | 1.7.0 | 镜像 `0.6.17`：**修复跨进程复用会话 id 报 `session "..." already exists`（第二句必炸）**。根因：SDK profile 的 `createSession(sessionId)` 只调 `ctx.agents.create()`，**没有 resume 分支**；而内核有磁盘会话持久化（`dsh-session-persistence-jsonl`，`/home/node/.dsh/sessions/--workspace--/<sid>/`），新进程启动会把磁盘会话恢复进内存 store，于是同一 sessionId 第二次创建时 `SessionStore.prepare(id)` 命中 `store.has(sessionId)` 直接抛错。对照 Web profile 用的 `dsh-api-session-controller`：它有正确的三步判定 `createOrAdopt`（内存 live → 磁盘 `sessionQuery.observeSession` + `agents.resume` → `create`），所以 Web 端可以随意切换会话、续聊、回看。**修复方式（零内核文件改动）**：新增外挂插件 `sdk-session-resume.js`，经 `--patch` insert 注入 sdk profile，在插件加载时替换 `HarnessSdkJsonRpcServer.prototype.createSession`，把 Web 端 `createOrAdopt` 的语义补上（内存 → 磁盘 resume → create 三步；cwd 不一致时明确报错不降级，避免同一 id 出现两个会话）。实测（真实 API Key，跨进程两轮）：第 1 轮 `磁盘无会话，走 create`，第 2 轮 `resume 成功`；第 2 轮仅发「暗号是什么」即正确答出第 1 轮设定的暗号，且 `usage.cacheReadTokens=7040` 证明上下文由内核侧续接、**未经网关拼 history**。该插件为纯外挂，上游在 SDK profile 补上 resume 后删除 patch entry 即回归官方实现 |
| gateway/1.7 | 1.7.1 | 镜像 `0.6.20`：**修复工作台 Web 端打不开 —— `ERR_TOO_MANY_REDIRECTS`（输了密码后进入死循环）**。根因：`web-ui.js` 用「请求里有没有 cookie」判断是否需要注入 `dsh web` 的 launch token（`if (target === '/' && !req.headers.cookie)`）。而浏览器在同域下必然带着无关 cookie（同域小程序通道、Sealos 平台自身等），条件恒为假 → 从不注入 token → 上游 `dsh web` 鉴权失败 → `303 location: /`（上游刻意抹掉 token）→ 浏览器带着同一批 cookie 再请求 → 再 303，无限循环。**修复（两处）**：① 新增 `hasDshCookie()`，用 `/(?:^|;\s*)dsh-auth-[^=]+=/` 精确识别 dsh 自己的 cookie，不再拿「有无任意 cookie」当判据；请求侧仅在无 dsh cookie 且 URL 无 token 时注入（且不再限于 `/`）。② **响应侧 3xx 兜底**：上游 3xx 且 `Location` 指向本域却没有 token 时补上 token，让浏览器下一跳用 token 换取合法 cookie；但若本次响应已下发 `set-cookie`（认证交接已完成）则原样放行。③ **响应侧 401 兜底**：浏览器持有「名字像 dsh-auth-* 但已失效」的 cookie（如 `dsh web` 重启后 launchToken 变了）时，请求侧会因 `hasDshCookie` 为真而跳过注入，上游直接回 401（非 303），3xx 兜底覆盖不到 → 用户被挡在门外。此时用带 token 的 URL 自动重试一次。**必须限制为无请求体方法（GET/HEAD）**，且重试前要 `req.resume()` + `proxy.destroy()` 让原始连接落地，否则连接一直挂着，客户端表现为超时（`HTTP=000`）。

> ⚠️ **踩坑记录一（务必保留此判据）**：曾尝试把请求侧改成「只要 URL 无 token 就总是注入」，想一举解决脏 cookie 的 401 —— **结果在生产上造出新的死循环**：上游 `dsh web` 每次拿到带 token 的请求都会**重新种 cookie 并 303 `/`**，于是 `hop1 303 → hop2 303 → …` 永不收敛（实测 20 跳）。**所以「已有 dsh cookie 就跳过注入」这一步绝不能省**，脏 cookie 的 401 必须走上面的「401 兜底重试」路径解决，而不是靠无条件注入。

> ⚠️ **踩坑记录二**：**验证必须跑真实的 `web-ui.js`，不能用手抄的副本或凭想象写 mock。** mock 若没复刻「带 token 一律重种 cookie + 303」这一上游行为，就测不出死循环；手抄副本曾漏掉 `req.resume()` 导致 401 重试挂起。本次最终验证方式：把 `web-ui.js` 复制到独立目录（避开仓库根的 `type: module` 干扰），用 `sed` 把 `startWeb();` 换成 `launchToken = 'SECRET';` 跳过 spawn，再配一个如实复刻生产行为的 mock 上游（3998）+ cookie jar 跟随重定向脚本。

> 实测（node mock 按生产行为复刻 + 浏览器 cookie jar 跟随重定向，上限 20 跳）：修复前「带无关 cookie」「带脏 dsh cookie」均 20 跳死循环；修复后四场景全部收敛 —— 无 cookie 2 跳 / 带无关 cookie 2 跳 / 带脏 cookie 2 跳 / 带合法 cookie 1 跳，均 200。生产实测 A、B 两场景均 `303 → 200`（2 跳） |
| gateway/1.6 | 1.6.0 | 镜像 `0.6.16`：内核升级 `@deepseek-ai/dsh 0.1.5-rc.1 → 0.1.5-rc.2`（合并上游 `0.1.5-rc.2` 到 `eftik-cloud`，冲突仅 `.gitignore`，gateway 定制 3493 行完整保留；rc.2 的 `text-chunks`/`reasoning-chunks` 结构与 rc.1 一致，gateway/1.5 的事件适配直接适用）。**修复对话记录恒为空 / 每次进入都是新会话**：原 `POST /chat` 仅在 `body.sessionId` 非空时才落会话记录，未给出时 `sessionStore = null` → `GET /sessions` 永远返回空数组；且同一路径下内核 sessionId 退化为 `task-<id>`，多轮对话实际断链。现改为：未带 sessionId 且是对话请求（有 `message`、非一次性 `task`）时，网关自己生成一个会话 id，正常走记账 + 传给内核 + 随响应回传 `session_id`。配套中台侧 `DshWorkspaceService` 改用 `chatRaw()` 认下回传的 `session_id` 并补写首轮 user 消息归属（原 `chat()` 只取 `task_id` 把 session_id 丢弃）。一次性任务与已有 sessionId 的调用方行为完全不变 |
