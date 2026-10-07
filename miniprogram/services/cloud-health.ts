import {
  CLOUD_FUNCTIONS,
  CLOUD_RESOURCE_APPID,
  CLOUD_RESOURCE_ENV,
  getCloudEnvId,
  isCloudAvailable,
  isSharedCloudEnabled,
} from '../config/cloud'
import { ensureCloudLogin, getCloudClient, CloudLoginState } from './auth'

export type CloudHealthStatus = 'checking' | 'pass' | 'warn' | 'fail'

export type CloudHealthStep = {
  key: 'runtime' | 'login' | 'partyRead' | 'partyWrite'
  title: string
  status: CloudHealthStatus
  message: string
  advice: string
  detail: string
}

export type CloudHealthReport = {
  status: CloudHealthStatus
  summary: string
  checkedAt: string
  envLabel: string
  steps: CloudHealthStep[]
}

type PartyRecordSelfCheck = {
  activeReadable: boolean
  activePartyExists: boolean
  wrote: boolean
  readBack: boolean
  cleaned: boolean
  checkPartyId?: string
  cleanupError?: string
  stats?: {
    playerCount: number
    recordCount: number
    unit: string
    unitToSip: number
    durationMs: number
  } | null
}

type PartyRecordResult = {
  ok: boolean
  data?: {
    record?: unknown
    selfCheck?: PartyRecordSelfCheck
  }
  code?: string
  message?: string
  debug?: string
}

type CloudFailure = {
  message: string
  advice: string
  detail: string
}

type BusinessError = Error & {
  result?: PartyRecordResult
}

function formatCheckedAt(date: Date): string {
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hh = date.getHours().toString().padStart(2, '0')
  const mm = date.getMinutes().toString().padStart(2, '0')
  const ss = date.getSeconds().toString().padStart(2, '0')
  return `${month}月${day}日 ${hh}:${mm}:${ss}`
}

function maskId(id?: string): string {
  if (!id) return '未返回'
  if (id.length <= 10) return id
  return `${id.slice(0, 6)}...${id.slice(-4)}`
}

function stringifyError(error: unknown): string {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message || String(error)
  try {
    return JSON.stringify(error)
  } catch (_err) {
    return String(error)
  }
}

function createBusinessError(result: PartyRecordResult): BusinessError {
  const detail = [
    result.code,
    result.message,
    result.debug,
  ].filter(Boolean).join(' | ')
  const err = new Error(detail || '云函数返回失败') as BusinessError
  err.result = result
  return err
}

function describeCloudFailure(error: unknown, functionName: string): CloudFailure {
  const raw = stringifyError(error)
  const lower = raw.toLowerCase()

  if (raw.includes('UNKNOWN_ACTION') || raw.includes('未知的酒局记录操作')) {
    return {
      message: `${functionName} 云函数不是最新版`,
      advice: `在微信开发者工具中右键 cloudfunctions/${functionName}，选择「上传并部署：云端安装依赖」，部署后重新运行自检。`,
      detail: raw,
    }
  }

  if (
    lower.includes('function not found') ||
    lower.includes('functionname') ||
    lower.includes('function name') ||
    raw.includes('函数不存在') ||
    raw.includes('云函数不存在')
  ) {
    return {
      message: `未找到 ${functionName} 云函数`,
      advice: `确认云函数名称是 ${functionName}，并在共享 CloudBase 环境中完成上传部署；同时检查 miniprogram/config/cloud.ts 的 CLOUD_FUNCTIONS 配置。`,
      detail: raw,
    }
  }

  if (
    lower.includes('unauthorized') ||
    lower.includes('not authorized') ||
    lower.includes('permission') ||
    lower.includes('forbidden') ||
    raw.includes('未授权') ||
    raw.includes('无权限') ||
    raw.includes('权限')
  ) {
    return {
      message: '共享环境未授权或权限不足',
      advice: `在资源方 CloudBase 控制台开启环境共享，把当前小程序 AppID 加入授权；集合权限建议设为仅云函数读写，然后重新预览开发版。`,
      detail: raw,
    }
  }

  if (
    lower.includes('collection') ||
    raw.includes('集合') ||
    raw.includes('database') ||
    raw.includes('db.')
  ) {
    return {
      message: '数据库集合或索引不可用',
      advice: '确认 ji_jiu_users、ji_jiu_parties 集合存在；ji_jiu_parties 需要 ownerOpenid、ownerAppid、status、updatedAt，以及 endedAt + partyId 的历史分页复合索引。',
      detail: raw,
    }
  }

  if (raw.includes('NO_OPENID') || raw.includes('openid')) {
    return {
      message: '未获取到当前用户身份',
      advice: '重新编译进入小程序；若使用共享环境，确认资源方已允许消费方 AppID 调用，并检查 cloudbase_auth、登录云函数是否部署。',
      detail: raw,
    }
  }

  if (
    raw.includes('wx.cloud') ||
    raw.includes('Cloud is not a function') ||
    raw.includes('共享云环境') ||
    lower.includes('resourceenv')
  ) {
    return {
      message: '当前运行环境不支持共享云初始化',
      advice: '使用基础库 2.21.0+ 的微信开发者工具或真机开发版测试；共享环境必须同时配置资源方 AppID 和资源环境 ID。',
      detail: raw,
    }
  }

  return {
    message: `${functionName} 调用失败`,
    advice: '打开微信开发者工具 Console 和云函数日志查看完整 errMsg；优先检查共享环境授权、云函数部署版本、集合权限和网络状态。',
    detail: raw,
  }
}

function makeStep(
  key: CloudHealthStep['key'],
  title: string,
  status: CloudHealthStatus,
  message: string,
  advice: string,
  detail: string,
): CloudHealthStep {
  return { key, title, status, message, advice, detail }
}

function getEnvLabel(): string {
  const mode = isSharedCloudEnabled() ? '共享 CloudBase' : '当前小程序云环境'
  const env = getCloudEnvId() || '动态当前环境'
  return `${mode} · ${env}`
}

function buildRuntimeStep(): CloudHealthStep {
  if (!isCloudAvailable()) {
    return makeStep(
      'runtime',
      '云开发 SDK',
      'fail',
      '当前运行环境没有 wx.cloud',
      '请使用微信开发者工具或真机微信环境运行；H5/浏览器环境无法调用小程序云开发 API。',
      'wx.cloud 不存在',
    )
  }

  if (isSharedCloudEnabled()) {
    return makeStep(
      'runtime',
      '共享环境配置',
      'pass',
      '已启用共享 CloudBase 配置',
      '继续检查资源方授权、登录函数和酒局读写能力。',
      [
        `resourceAppid=${CLOUD_RESOURCE_APPID}`,
        `resourceEnv=${CLOUD_RESOURCE_ENV}`,
        `login=${CLOUD_FUNCTIONS.login}`,
        `partyRecord=${CLOUD_FUNCTIONS.partyRecord}`,
      ].join('\n'),
    )
  }

  return makeStep(
    'runtime',
    '共享环境配置',
    'warn',
    '未配置共享 CloudBase，当前会使用本小程序云环境',
    '如果生产目标是共享环境，请补齐 CLOUD_RESOURCE_APPID 和 CLOUD_RESOURCE_ENV 后再自检。',
    [
      `env=${getCloudEnvId() || 'DYNAMIC_CURRENT_ENV'}`,
      `login=${CLOUD_FUNCTIONS.login}`,
      `partyRecord=${CLOUD_FUNCTIONS.partyRecord}`,
    ].join('\n'),
  )
}

async function checkLogin(): Promise<CloudHealthStep> {
  try {
    const state: CloudLoginState = await ensureCloudLogin(true)
    return makeStep(
      'login',
      '云登录',
      'pass',
      '云登录成功，已拿到当前调用方身份',
      '登录链路正常；继续检查酒局读写。页面只展示脱敏 openid，不暴露完整用户标识。',
      [
        `openid=${maskId(state.openid)}`,
        `appid=${state.appid || '未返回'}`,
        `unionid=${maskId(state.unionid)}`,
      ].join('\n'),
    )
  } catch (err) {
    const failure = describeCloudFailure(err, CLOUD_FUNCTIONS.login)
    return makeStep('login', '云登录', 'fail', failure.message, failure.advice, failure.detail)
  }
}

async function callPartyRecord(action: string, data?: Record<string, any>): Promise<PartyRecordResult> {
  const client = await getCloudClient()
  const res = await client.callFunction({
    name: CLOUD_FUNCTIONS.partyRecord,
    data: {
      action,
      ...(data || {}),
    },
  })
  const result = res.result as PartyRecordResult
  if (!result?.ok) throw createBusinessError(result || { ok: false })
  return result
}

async function checkActivePartyRead(): Promise<CloudHealthStep> {
  try {
    const result = await callPartyRecord('getActive')
    const hasActiveParty = !!result.data?.record
    return makeStep(
      'partyRead',
      '活跃酒局读取',
      'pass',
      hasActiveParty ? '活跃酒局读取正常，当前账号有未结束酒局' : '活跃酒局读取正常，当前账号暂无未结束酒局',
      '读取动作只查询 ownerOpenid + ownerAppid + active，不会修改用户数据。',
      hasActiveParty ? 'getActive 返回 1 条 active 记录' : 'getActive 返回空记录',
    )
  } catch (err) {
    const failure = describeCloudFailure(err, CLOUD_FUNCTIONS.partyRecord)
    return makeStep('partyRead', '活跃酒局读取', 'fail', failure.message, failure.advice, failure.detail)
  }
}

async function checkActivePartyWrite(): Promise<CloudHealthStep> {
  try {
    const result = await callPartyRecord('selfCheck', {
      clientCheckedAt: new Date().toISOString(),
    })
    const selfCheck = result.data?.selfCheck
    if (!selfCheck?.wrote || !selfCheck.readBack) {
      return makeStep(
        'partyWrite',
        '活跃酒局写入',
        'fail',
        '临时酒局写入或读回校验失败',
        '确认 ji_jiu_parties 集合存在，云函数有写入权限，并重新部署最新版 jijiuPartyRecord 云函数。',
        JSON.stringify(selfCheck || result.data || {}, null, 2),
      )
    }

    if (!selfCheck.cleaned) {
      return makeStep(
        'partyWrite',
        '活跃酒局写入',
        'warn',
        '临时酒局写入成功，但清理失败',
        `到 ji_jiu_parties 集合删除 partyId=${selfCheck.checkPartyId || 'cloud-self-check-*'} 的临时记录，并检查云函数删除权限。`,
        selfCheck.cleanupError || JSON.stringify(selfCheck, null, 2),
      )
    }

    return makeStep(
      'partyWrite',
      '活跃酒局写入',
      'pass',
      '临时活跃酒局写入、读回和清理都成功',
      '共享环境的活跃酒局读写链路可用；真实业务仍会按当前 openid 和 AppID 隔离。',
      [
        `checkPartyId=${selfCheck.checkPartyId || '未返回'}`,
        `activeBefore=${selfCheck.activePartyExists ? '有' : '无'}`,
        `records=${selfCheck.stats?.recordCount || 0}`,
      ].join('\n'),
    )
  } catch (err) {
    const failure = describeCloudFailure(err, CLOUD_FUNCTIONS.partyRecord)
    return makeStep('partyWrite', '活跃酒局写入', 'fail', failure.message, failure.advice, failure.detail)
  }
}

function buildReport(steps: CloudHealthStep[]): CloudHealthReport {
  const status: CloudHealthStatus = steps.some(step => step.status === 'fail')
    ? 'fail'
    : (steps.some(step => step.status === 'warn') ? 'warn' : 'pass')
  const summaryMap: Record<CloudHealthStatus, string> = {
    checking: '正在检查云开发状态',
    pass: '共享 CloudBase 当前可用',
    warn: '共享 CloudBase 基本可用，但有需要处理的提醒',
    fail: '共享 CloudBase 存在阻断问题',
  }
  return {
    status,
    summary: summaryMap[status],
    checkedAt: formatCheckedAt(new Date()),
    envLabel: getEnvLabel(),
    steps,
  }
}

/**
 * 运行隐藏的云开发自检。
 *
 * 调用时机：仅自检页点击刷新或首次进入页面时执行。登录会强制刷新缓存，
 * 酒局写入使用云函数 selfCheck 的临时记录，不会影响普通用户的开局和记酒流程。
 */
export async function runCloudHealthCheck(): Promise<CloudHealthReport> {
  const steps: CloudHealthStep[] = [buildRuntimeStep()]
  if (steps[0].status === 'fail') return buildReport(steps)

  steps.push(await checkLogin())
  if (steps[1].status === 'fail') return buildReport(steps)

  steps.push(await checkActivePartyRead())
  steps.push(await checkActivePartyWrite())
  return buildReport(steps)
}
