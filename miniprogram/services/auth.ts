import {
  CLOUD_FUNCTIONS,
  CLOUD_RESOURCE_APPID,
  CLOUD_RESOURCE_ENV,
  getCloudEnvId,
  isCloudAvailable,
  isSharedCloudEnabled,
} from '../config/cloud'

const LOGIN_CACHE_KEY = [
  'cloudLoginState',
  CLOUD_RESOURCE_APPID || 'current-app',
  getCloudEnvId() || 'current-env',
].join(':')

export type CloudLoginState = {
  loggedIn: boolean
  openid: string
  appid?: string
  unionid?: string
  loginAt: number
}

type LoginFunctionResult = {
  ok: boolean
  data?: {
    openid: string
    appid?: string
    unionid?: string
  }
  code?: string
  message?: string
  debug?: string
}

type CloudClient = {
  init?: () => void | Promise<void>
  callFunction: (options: {
    name: string
    data?: Record<string, any>
  }) => Promise<ICloud.CallFunctionResult>
}

let cloudInitPromise: Promise<CloudClient> | null = null
let loginPromise: Promise<CloudLoginState> | null = null
let cachedLoginState: CloudLoginState | null = null

/**
 * 初始化云开发 SDK。
 *
 * 调用时机：App.onLaunch 以及所有云函数调用前。
 * 共享环境必须通过 wx.cloud.Cloud 创建独立实例，后续登录和数据请求也必须
 * 使用该实例，否则请求会错误地发往当前小程序自己的默认云环境。
 */
export function initCloud(): Promise<CloudClient> {
  if (cloudInitPromise) return cloudInitPromise
  if (!isCloudAvailable()) {
    return Promise.reject(new Error('当前基础库或运行环境不支持 wx.cloud'))
  }

  const rootCloud = (wx as any).cloud

  try {
    if (isSharedCloudEnabled()) {
      if (typeof rootCloud.Cloud !== 'function') {
        return Promise.reject(new Error('当前基础库不支持共享云环境，请升级微信基础库'))
      }

      const sharedClient = new rootCloud.Cloud({
        resourceAppid: CLOUD_RESOURCE_APPID,
        resourceEnv: CLOUD_RESOURCE_ENV,
      }) as CloudClient

      cloudInitPromise = Promise.resolve(sharedClient.init?.()).then(() => sharedClient)
    } else {
      const env = getCloudEnvId()
      const config = env ? { env, traceUser: true } : { traceUser: true }
      rootCloud.init(config)
      cloudInitPromise = Promise.resolve(rootCloud as CloudClient)
    }
  } catch (error) {
    cloudInitPromise = null
    return Promise.reject(error)
  }

  cloudInitPromise = cloudInitPromise.catch(error => {
    cloudInitPromise = null
    throw error
  })
  return cloudInitPromise
}

/**
 * 获取已初始化的云客户端。
 *
 * 返回值可能是当前小程序的 wx.cloud，也可能是共享环境 Cloud 实例；
 * 业务代码不应再直接调用根对象 wx.cloud.callFunction。
 */
export function getCloudClient(): Promise<CloudClient> {
  return initCloud()
}

function readCachedLoginState(): CloudLoginState | null {
  if (cachedLoginState) return cachedLoginState
  const value = wx.getStorageSync(LOGIN_CACHE_KEY) as CloudLoginState | undefined
  if (!value?.loggedIn || !value.openid) return null
  cachedLoginState = value
  return value
}

export function getCloudLoginState(): CloudLoginState | null {
  return readCachedLoginState()
}

/**
 * 静默登录：通过云函数拿 openid，不弹微信头像昵称授权。
 *
 * 失败时抛出错误，页面应降级为本地存储可用，避免影响线下记酒。
 */
export function ensureCloudLogin(force = false): Promise<CloudLoginState> {
  // 冷启动的强制登录进行中时，页面必须复用该请求，不能被旧缓存提前短路。
  if (loginPromise) return loginPromise
  if (!force) {
    const cached = readCachedLoginState()
    if (cached?.openid) return Promise.resolve(cached)
  }

  const pendingLogin = getCloudClient().then(client => client.callFunction({
    name: CLOUD_FUNCTIONS.login,
    data: {},
  })).then((res: ICloud.CallFunctionResult) => {
    const result = res.result as LoginFunctionResult
    if (!result?.ok || !result.data?.openid) {
      const details = [
        result?.code,
        result?.message || '云登录失败',
        result?.debug,
      ].filter(Boolean).join(' | ')
      throw new Error(details)
    }
    const state: CloudLoginState = {
      loggedIn: true,
      openid: result.data.openid,
      appid: result.data.appid,
      unionid: result.data.unionid,
      loginAt: Date.now(),
    }
    cachedLoginState = state
    wx.setStorageSync(LOGIN_CACHE_KEY, state)
    return state
  }).finally(() => {
    loginPromise = null
  })

  loginPromise = pendingLogin
  return pendingLogin
}
