# Agent Note: Eftik 云端 BYOK 与插件目录

[English](2026-09-10-eftik-byok-plugin-directory.md) | 中文

Status: implemented

## Problem

Eftik 云端网关需要支持租户自有的 DeepSeek 凭证，同时不把模型密钥存进 Kitsume 数据库；彼此分离的技能与定时任务界面也缺少统一的产品级插件清单；租户还需要通过 Sealos 应用公网地址访问官方 DSH WebUI。

## Decision

网关把首次启动时的 `DEEPSEEK_API_KEY` 迁移到 Harness 原生的 `$DSH_HOME/.credentials.yaml` 文档，以仅属主可读权限保存，并从长期运行的网关进程环境中移除。经过鉴权的凭证接口只公开配置状态与末尾字符，绝不返回密钥明文；替换操作以原子写入提交。

`GET /plugins` 读取 DSH 真实的 profile 清单。经过鉴权的安装和卸载接口委托给 `dsh plugin --profile <web|headless> add/remove`，profile 对账仍由 DSH 负责。产品请求仅接受 npm 包规格；Git URL 与本地路径会被拒绝，因为它们可能授权安装期构建脚本。操作成功后通过 profile 变更标记自动重载 WebUI 进程。

官方 WebUI 继续只监听回环地址的 3080 端口。独立代理作为工作台唯一公网端口公开 8080，要求输入工作台访问密码；PVC 中仅保存密码的 SHA-256 摘要。代理在执行 DSH 原生启动令牌交换前改写上游 authority。API 网关继续在容器内部使用 8090，并通过同一公网域名下的保留前缀 `/_eftik/api` 对后端提供服务。

## Alternatives considered

**继续使用平台模型密钥。** 这种方案便于统一计费，但平台必须承担 token 计量责任，租户也无法自行控制模型额度。

**将租户密钥存入 Kitsume 数据库。** 这种方案便于重建容器，却扩大了中心化秘密系统的范围，应用数据库泄漏会暴露所有租户密钥。

**把 Skills 和定时任务视为插件。** 这是一种方便的产品分类，但与 DSH 明确的 bundle/profile 契约冲突，因此两者继续作为独立功能。

**开放任意 Git 或本地插件安装。** 这最贴近 CLI 的完整能力，但会向远程租户直接开放安装期构建脚本；产品界面首期只允许 npm 包名和版本。

**让 `dsh web` 直接监听所有网络接口。** DSH 会主动限制非回环监听并校验 Host/Origin authority。保持回环监听能够保留这些安全假设，由密码代理明确承担公网安全边界。

## Consequences

每个工作台 PVC 持有自己的模型凭证、WebUI 密码摘要和 DSH profile 依赖，轮换密钥会作用于后续 Harness 运行。第三方 npm 插件会在租户工作台内执行代码，并不代表平台背书。首次密钥仍会在创建工作台时经过 Sealos 部署 API，因此传输安全与 Sealos 的秘密处理仍属于部署边界。只有 Sealos 返回 8080 公网地址且 API 网关能通过保留前缀响应后，工作台才会进入就绪状态。
