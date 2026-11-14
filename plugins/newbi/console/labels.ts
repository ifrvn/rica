export const newbiAuditLabels = {
  'newbi.account.bind': '绑定连接器账号', 'newbi.reply.create': '创建回复提案',
  'newbi.reply.review': '审批公开回复', 'newbi.reply.close': '结案回复提案',
}

export const newbiConsole = {
  id: 'newbi',
  name: 'Newbi',
  reviewTitle: 'Newbi 平台提案',
  disabledAccountLabel: 'Newbi（请先启用并配置接入点）',
  description: '平台连接器 · 读取与发送分别运行',
  upgradeStep: '先核对受影响账号的在途发送。待核对的结果须用原执行版本和幂等键恢复，或按现有流程结案。',
  serviceNames: { 'connector-reader': 'Newbi 读取', 'connector-executor': 'Newbi 发送' },
  capabilityNames: { 'platform-reader': '读取平台消息', 'platform-reply-executor': '发送已获许可的回复' },
} as const
