/**
 * 云开发基础配置。
 *
 * 当前小程序使用其他小程序共享的云开发资源，因此必须同时配置资源方 AppID
 * 和资源环境 ID。两项都为空时，才会回退到当前小程序自己的云环境。
 */
export const CLOUD_RESOURCE_APPID = 'wx754380008b8e5ace'
export const CLOUD_RESOURCE_ENV = 'cloud1-d4gfatip0edd01506'

/**
 * 当前小程序自有云环境 ID，仅在未配置共享环境时使用。
 * 留空时由微信开发者工具选择当前环境。
 */
export const CLOUD_ENV_ID = ''

export const CLOUD_FUNCTIONS = {
  login: 'jijiuLogin',
  partyRecord: 'jijiuPartyRecord',
}

export function isSharedCloudEnabled(): boolean {
  return !!CLOUD_RESOURCE_APPID && !!CLOUD_RESOURCE_ENV
}

export function getCloudEnvId(): string | undefined {
  if (isSharedCloudEnabled()) return CLOUD_RESOURCE_ENV
  if (CLOUD_ENV_ID) return CLOUD_ENV_ID
  const cloud = (wx as any).cloud
  return cloud?.DYNAMIC_CURRENT_ENV || undefined
}

export function isCloudAvailable(): boolean {
  return !!(wx as any).cloud
}
