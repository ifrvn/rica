# Rica 插件开发手册

先根据运行方式、权限和数据边界选择接入方式。Rica 支持随宿主交付的内置实现、部署者安装的固定版本 npm 包和通过 HTTP 接入的独立服务。

| 我想做什么 | 阅读入口 |
| --- | --- |
| 选择接入方式，设计数据边界和迁移 | [插件架构与最佳实践](01-architecture.md) |
| 从零安装受信 npm 包，接入管理、Worker、账号或独立服务 | [第三方插件 SDK 与远程服务协议](08-package-sdk.md) |
| 增加内置模型提供方或模拟平台适配器 | [运行时契约与实现示例](02-runtime.md) |
| 修改宿主管理 API、权限或内置插件装配 | [宿主管理契约与 HTTP 请求示例](03-management.md) |
| 接入外部平台读取、审批、发送或对账 | [平台读写、凭据与权限](04-platform-safety.md) |
| 修改内置设置、审批组件或健康节点 | [内置插件控制台](05-console.md)与[控制台使用及维护](../console.md) |
| 在隔离环境验证和发布插件 | [本地验证、发布与排障](06-verification-release.md) |

现有实现可参考 [Newbi](../../plugins/newbi/README.md) 和[外部模型插件](../../plugins/hosted-models/README.md)。
