# eftik-dsh-cloud 网关接口文档

> 适用版本：镜像 `eftik-dsh-cloud:0.6.10`（网关 `gateway/1.0`，内核 `@deepseek-ai/dsh 0.1.2-rc.1`）
>
> 镜像 tag 自 0.5.0 起与网关版本对齐（0.5.0 = 网关 v0.5）；镜像自身修订从第三位递增（0.5.1、0.5.2…），网关升版则前两位跟随
> 更新时间：2026-09-09

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
  "dsh": "0.1.2-rc.1",
  "version": "gateway/0.3",
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
| `reasoning` | enum | `balanced` | 推理等级 `low` / `balanced` / `high`。注：内核 0.1.2-rc.1 无原生推理等级配置，当前以系统前导指令模拟，上游支持后切换为真实配置 |
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

## 4. 任务

### POST /chat

提交一个 agent 任务。

**请求体（二选一）**

```jsonc
// 方式一：完整任务文本（适合一次性指令）
{ "task": "在 /workspace 写一个 hello.py 并运行验证" }

// 方式二：消息 + 会话历史（适合多轮对话，历史由业务后端持久化裁剪后传入，建议 ≤20 条）
{
  "message": "刚才写的脚本跑通了吗？",
  "history": [
    { "role": "user", "content": "上一轮用户消息" },
    { "role": "assistant", "content": "上一轮助手回答" }
  ]
}
```

> 提交时的 `settings` 快照会应用到该任务（模型、权限、背景等）。

**返回（200）**

```json
{ "task_id": "t-1788620082854-ioocuv" }
```

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
| `answer` | **正文增量**：headless stdout 的每个 chunk 原样下发，前端累加即得打字机效果。完整正文 = 所有 answer 的 `text` 按序拼接（与 `done.reply` 一致） |
| `thinking` | **思考增量**：headless 打在 stderr 的 `dsh: reasoning:` 段，剥离前缀后下发（ANSI 已清除）。无 reasoning 的模型不会有该事件 |
| `log` | 运行日志行（工具调用等），可展示为"正在干活"动态 |
| `done` | 终态，携带 `reply`/`error`/`elapsed_ms`/`usage`，随后服务端关闭连接 |

- 事件按产生即推（stdout/stderr 到达即发），非定时批量，延迟 ≈ 模型输出延迟
- 断开后可回退用 `GET /task/{task_id}` 补拉全量（`reply` 在任务运行期间即为已产出的部分正文）
- 调用方按 `answer` / `thinking` 分流：正文渲染 markdown，思考渲染为可折叠的思考块

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
