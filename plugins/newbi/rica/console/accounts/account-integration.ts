import { reactive, ref } from 'vue'
import type { z } from '@hono/zod-openapi'
import { formatTime } from '@ricajs/console-shared/console-data'
import { RequestError } from '@ricajs/console-shared/request'
import { connectorAccountRegistration, newbiAccountTest, type newbiAccountCheckView, type newbiAccountRegistrationView, type newbiAccountView } from '../../management/contracts.js'
import { checkAccount, testAccount, type AccountPreview } from './accounts.js'
import { newbiConsole } from '../labels.js'
import Form from './AccountConnectionForm.vue'
import Label from './NewbiAccountLabel.vue'
import Details from './ConnectorAccountStatus.vue'

type Account = z.infer<typeof newbiAccountView>
type Registration = z.infer<typeof newbiAccountRegistrationView>
type AccountRef = Pick<Registration, 'id' | 'instanceKey' | 'newbiProfile'> & { platform: string; status?: string; version?: number }

export const newbiAccounts = {
  Form, Label, Details, platform: newbiConsole.id,
  resumeMessage: '恢复前会核对读取权限。发送仍需独立审批和执行许可。',
  pauseMessage: '暂停后，此账号无法领取新的读取任务或发送许可。',
  resumeError: '恢复未完成。请核对部署中的读取凭据、服务地址和 Agent ID，再重试。',
  label(account: Pick<Registration, 'newbiProfile'>) {
    const profile = account.newbiProfile
    return profile && newbiConsole.name + ' · ' + (profile.username || profile.agentId)
  },
  labelProps: (account: Pick<Registration, 'newbiProfile'>) => account.newbiProfile ? { profile: account.newbiProfile } : undefined,
  use({ base, run, active, refresh, clearError, error }: {
    base(): string; run(task: () => Promise<void>): Promise<void>; active(): boolean; refresh(): Promise<void>
    clearError(): void; error(message: string): void
  }) {
    const available = ref(false)
    const endpoint = ref<string>()
    const credential = ref('')
    const preview = ref<AccountPreview>()
    type AccountCheck = z.infer<typeof newbiAccountCheckView>
    const checks = reactive(new Map<string, AccountCheck & { version?: number }>())
    const checkingAccount = ref<string>()

    function check(account: Pick<Account, 'id'> & { version?: number }) {
      void run(async () => {
        checkingAccount.value = account.id
        checks.delete(account.id)
        try {
          const result = await checkAccount(base(), account.id)
          if (active()) {
            checks.set(account.id, { ...result, version: account.version })
            if (result.verified) await refresh()
          }
        } finally {
          checkingAccount.value = undefined
        }
      })
    }

    function accountCheckLabel(account: Pick<Account, 'id'> & { version?: number }) {
      const check = checks.get(account.id)
      if (!check || check.version !== account.version) return ''
      const result = check.verified ? '读取连接核验通过' : '读取连接核验失败，请核对 Agent ID、地址和读取凭据。'
      return result + ' · ' + formatTime(check.checkedAt)
    }

    async function test() {
      await run(async () => {
        preview.value = undefined
        const input = newbiAccountTest.safeParse({ credential: credential.value.trim() })
        if (!input.success) { error('请输入有效的 Newbi Agent Key。'); return }
        const result = await testAccount(base(), input.data)
        if (active()) preview.value = result
      })
    }

    function registrationError(cause: unknown) {
      if (!(cause instanceof RequestError)) return
      if (cause.code === 'CONNECTOR_VERIFICATION_FAILED' || cause.code === 'PLUGIN_STATE_CONFLICT') {
        preview.value = undefined
        return '无法核验 Newbi 账号。请检查 Agent Key 和插件中心的 API 接入点。'
      }
      if (cause.code === 'ACCOUNT_REGISTERED' || cause.code === 'CONFLICT') return '此 Newbi 账号已登记。'
    }

    const connected = (account: AccountRef) => account.platform === newbiConsole.id && available.value && account.instanceKey === endpoint.value
    return {
      checkingAccount, check, accountCheckLabel, registrationError,
      ready: () => !!preview.value,
      formProps: () => ({ credential: credential.value, preview: preview.value, onTest: test,
        'onUpdate:credential': (value: string) => { credential.value = value; preview.value = undefined; clearError() } }),
      reset() { credential.value = ''; preview.value = undefined },
      parse() {
        return connectorAccountRegistration.safeParse({ platform: newbiConsole.id, credential: credential.value.trim(), agentId: preview.value?.agentId })
      },
      sync(status?: { newbiRegistrationAvailable?: boolean; deployment?: { newbi: { endpoint: string | null } } }) {
        available.value = status?.newbiRegistrationAvailable === true
        endpoint.value = status?.deployment?.newbi.endpoint ?? undefined
      },
      choices(workspace?: { newbiInstalled: boolean }) {
        return workspace?.newbiInstalled || available.value ? [{ label: available.value ? newbiConsole.name : newbiConsole.disabledAccountLabel,
          value: newbiConsole.id, disabled: !available.value }] : []
      },
      canRefreshProfile: (account: AccountRef) => connected(account) && !!account.newbiProfile && !account.newbiProfile.username,
      canCheck: (account: AccountRef) => connected(account) && account.status !== 'REVOKED',
      canPropose: (account: Account, identityStatus?: string, characterStatus?: string) => connected(account)
        && account.status === 'ACTIVE' && identityStatus === 'ACTIVE' && characterStatus === 'ACTIVE',
    }
  },
}
