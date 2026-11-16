import type { ModelCheckStatus } from '../management/contracts.js'

export const modelCheckLabels: Record<ModelCheckStatus['status'], string> = {
  OK: '模型已返回回复',
  AUTH_FAILED: '授权失败，请核对 API 密钥及模型访问权限。',
  RATE_LIMITED: '服务商限制了请求，请核对额度或稍后重试。',
  MODEL_UNAVAILABLE: '找不到模型或接口，请核对模型 ID 和 API 地址。',
  CONNECTION_FAILED: '连接失败，请核对服务地址和网络后重试。',
  INVALID_OUTPUT: '服务未返回可用文本，请核对模型是否支持文本回复。',
  PROVIDER_ERROR: '模型服务拒绝了请求，请核对模型配置后重试。',
}
