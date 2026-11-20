# Rica 插件开发手册

这份手册面向 Rica 的插件开发者。内置插件作为 `plugins/*` 下的 pnpm 工作区成员随 Rica 部署。仓库外的受信包可通过部署清单接入角色范围内的只读接口，其他 SDK 能力按重构计划推进。插件中心管理已内置的交付项。

Acme 与 Demo Echo 是本手册的示例插件。各已交付插件的功能、设置和专用 API 由各自包内的手册说明。

## 章节

1. [选择能力与包结构](01-architecture.md)
2. [运行时契约、API 与实现示例](02-runtime.md)
3. [管理契约、宿主 API 与请求示例](03-management.md)
4. [平台读写、凭据与数据库权限](04-platform-safety.md)
5. [控制台契约、组件 API 与系统运行状况](05-console.md)
6. [本地验证、发布与排障](06-verification-release.md)
7. [从零实现并验证一个管理插件](07-worked-example.md)
8. [第三方插件包与 SDK 重构](08-package-sdk.md)

## 从哪里开始

| 我要做的事 | 首先看 |
| --- | --- |
| 接入新的外部模型提供方 | [模型接口与实现示例](02-runtime.md#modelprovider) |
| 增加一个模拟消息协议 | [最小模拟适配器](02-runtime.md#最小模拟适配器) |
| 接入外部平台账号、事件和发言 | [账号实现示例](03-management.md#账号贡献的代码骨架)与[平台读写](04-platform-safety.md) |
| 给插件补配置页面、审批入口或健康节点 | [控制台接入](05-console.md) |
| 准备合并和部署 | [验证与发布](06-verification-release.md) |

系统层约束见[系统设计规范第 17 章](../多平台多身份%20AI%20虚拟角色认知与自主行为系统设计规范.md#sec-17)。阶段目标和历史背景见[插件架构重构计划](../plugin-architecture-refactor.md)。
