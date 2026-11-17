# Rica 外部模型插件

[宿主请求约定与 PowerShell 会话](../../docs/plugin-development/03-management.md#建立-powershell-会话)

## 代码入口

- [providers/](providers/) 负责提供方地址、配置校验、HTTP 请求和响应解析。
- [rica/model.ts](rica/model.ts) 组装角色提示和公开证据，将提供方回复转换为 Rica 草稿。
- [rica/management/](rica/management/) 负责配置存储、管理路由和连接测试，[rica/console/](rica/console/) 负责控制台设置与健康状态。
- [index.ts](index.ts) 提供服务端入口，[shared](rica/shared.ts) 提供共用契约和提供方目录，[console](rica/console/index.ts) 提供控制台入口。

## 管理 HTTP API

| 方法与路径 | 权限 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| `GET /v1/model-settings` | 本地部署管理员 | 无 | 200，模型设置视图。 |
| `PUT /v1/model-settings` | 本地部署管理员 | 版本。传入下表字段，省略 `id` 时添加新配置。 | 200，模型设置视图。 |
| `PUT /v1/model-settings/active` | 本地部署管理员 | 版本。传入 `{ id }`，用保存后的配置 ID 设置部署默认，传 `null` 则默认使用本地模型。 | 200，模型设置视图。 |
| `DELETE /v1/model-settings/{id}` | 本地部署管理员 | 版本。移除指定配置及密钥，如果它是部署默认则切回本地模型。 | 200，模型设置视图。 |
| `POST /v1/model-settings/check` | 本地部署管理员 | `{ id, version }`，测试指定配置。 | 200，测试结果。 |

| 模型设置字段 | 要求 |
| --- | --- |
| `id` | 编辑已有配置时必填。 |
| `name` | 配置名称，去首尾空白后 1–80 字符。 |
| `provider` | 必填。取 `openai`、`anthropic`、`gemini`、`deepseek` 或 `openai-compatible`。已有配置的接入类型固定。 |
| `model` | 必填。去首尾空白后 1–160 字符，只允许字母、数字、下划线、点、斜线、冒号和连字符。 |
| `apiKey` | 编辑同一份配置且地址未改变时可复用这份配置的密钥。新配置提供 1–4096 个可见 ASCII 字符。 |
| `baseUrl` | 仅 `openai-compatible` 必填。HTTPS 地址，最长 2048 字符，无用户信息、查询参数或片段。可包含 API 版本路径。 |

设置视图包含 `version`、`defaultProfileId` 和 `profiles`。每条配置返回 `id`、`name`、`provider`、`model`、`baseUrl` 和 `hasKey`。测试结果包含 `id`、`provider`、`checkedAt`、`status` 和 `reply`。时间采用 ISO 格式，回复为最多 500 字符或 `null`。`status` 为 `OK`、`AUTH_FAILED`、`RATE_LIMITED`、`MODEL_UNAVAILABLE`、`CONNECTION_FAILED`、`INVALID_OUTPUT` 或 `PROVIDER_ERROR`。HTTP 200 表示测试已完成，需读取结果状态。

在身份的「公开草稿模型」字段选择已保存的配置。API 字段 `roleProfile.draftModelProfile` 接受配置 ID 或 `simulated`，省略时使用部署默认。多个身份可以选择同一份配置，修改该配置会影响所有引用它的身份。需要独立修改时，在插件卡片内新建一份配置。移除配置后，仍引用它的身份后续使用本地模型，直到重新指定配置。私密模拟草稿始终使用本地模型。

## 配置与测试

选择 DeepSeek 时使用官方 Chat Completions 地址，填入模型 ID（例如 `deepseek-flash`）和 API 密钥即可。草稿和连接测试使用非思考模式，给回复正文保留输出预算。[DeepSeek API 文档](https://api-docs.deepseek.com/api/create-chat-completion/)

先对 `id = 'hosted-models'` 执行[安装和启用步骤](../../docs/plugin-development/03-management.md#部署与插件状态)。所有提供方共用该插件的部署状态。在授权的测试环境中使用所选提供方允许的模型 ID 和密钥，核验会调用供应商 API。

部署记录的 `plugins` 只接受 `hosted-models` 这一外部模型插件 ID。旧开发环境升级时，将原先按提供方记录的安装状态收归这个 ID，并保留其他插件条目。发布清单也使用单一的 `model/hosted-models` 组件。

```powershell
$ricaSettings = Invoke-Rica Get '/v1/model-settings'
$ricaModelId = Read-Host 'OpenAI 模型 ID'
$ricaApiKey = Read-Host -MaskInput 'OpenAI API Key'
$ricaSettings = Invoke-Rica Put '/v1/model-settings' -Version $ricaSettings.version `
  -Body @{ name = 'OpenAI 草稿'; provider = 'openai'; model = $ricaModelId; apiKey = $ricaApiKey }
Remove-Variable ricaApiKey
$ricaProfile = $ricaSettings.profiles[-1]
Invoke-Rica Post '/v1/model-settings/check' -Body @{ id = $ricaProfile.id; version = $ricaSettings.version }
```
