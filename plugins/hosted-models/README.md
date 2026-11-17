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
| `PUT /v1/model-settings` | 本地部署管理员 | 版本。请求体为下面的模型设置字段。 | 200，模型设置视图。 |
| `POST /v1/model-settings/check` | 本地部署管理员 | `{ version: 正整数 }`，必须等于已保存模型设置版本。 | 200，测试结果。 |

| 模型设置字段 | 要求 |
| --- | --- |
| `provider` | 必填。取 `simulated`、`openai`、`anthropic`、`gemini` 或 `openai-compatible`。 |
| `model` | 外部提供方必填。去首尾空白后 1–160 字符，只允许字母、数字、下划线、点、斜线、冒号和连字符。 |
| `apiKey` | 提供方及地址未改变时可复用已有密钥。新配置提供 1–4096 个可见 ASCII 字符。 |
| `baseUrl` | 仅 `openai-compatible` 必填。HTTPS 地址，最长 2048 字符，无用户信息、查询参数或片段。可包含 API 版本路径。 |

选择 `simulated` 时请求只传 `provider`。设置视图为 `{ version: number, provider: string, model: string | null, baseUrl: string | null, hasKey: boolean }`。测试结果为 `{ provider, checkedAt, status, reply }`，`checkedAt` 为 ISO 时间，`reply` 为至多 500 字符或 `null`。`status` 为 `OK`、`AUTH_FAILED`、`RATE_LIMITED`、`MODEL_UNAVAILABLE`、`CONNECTION_FAILED`、`INVALID_OUTPUT` 或 `PROVIDER_ERROR`。HTTP 200 表示测试已完成，需读取结果状态。

## 配置与测试

先对 `id = 'hosted-models'` 执行[安装和启用步骤](../../docs/plugin-development/03-management.md#部署与插件状态)。所有提供方共用该插件的部署状态。在授权的测试环境中使用所选提供方允许的模型 ID 和密钥，核验会调用供应商 API。

部署记录的 `plugins` 只接受 `hosted-models` 这一外部模型插件 ID。旧开发环境升级时，将原先按提供方记录的安装状态收归这个 ID，并保留其他插件条目。发布清单也使用单一的 `model/hosted-models` 组件。

```powershell
$ricaSettings = Invoke-Rica Get '/v1/model-settings'
$ricaModelId = Read-Host 'OpenAI 模型 ID'
$ricaApiKey = Read-Host -MaskInput 'OpenAI API Key'
$ricaSettings = Invoke-Rica Put '/v1/model-settings' -Version $ricaSettings.version `
  -Body @{ provider = 'openai'; model = $ricaModelId; apiKey = $ricaApiKey }
Remove-Variable ricaApiKey
Invoke-Rica Post '/v1/model-settings/check' -Body @{ version = $ricaSettings.version }
```
