import { CLOUD_FUNCTIONS } from '../config/cloud'
import { ensureCloudLogin, getCloudClient } from './auth'

export type CloudPartyRecord = {
  partyId: string
  status: 'active' | 'ended'
  party: IPartyData
  updatedAt?: string
  endedAt?: string
  stats?: {
    playerCount: number
    recordCount: number
    unit: string
    unitToSip: number
    durationMs: number
  }
}

export type CloudPartyPageCursor = string

export type CloudPartyRecordPage = {
  records: CloudPartyRecord[]
  nextCursor: CloudPartyPageCursor
  hasMore: boolean
  limit: number
}

type PartyRecordResult = {
  ok: boolean
  data?: {
    record?: CloudPartyRecord | null
    records?: CloudPartyRecord[]
    nextCursor?: CloudPartyPageCursor
    hasMore?: boolean
    limit?: number
  }
  code?: string
  message?: string
  debug?: string
}

function normalizeCloudParty(party: IPartyData): IPartyData {
  return {
    ...party,
    players: Array.isArray(party.players) ? party.players : [],
    playerAvatarPhotos: {},
  }
}

function callPartyRecord(action: string, data?: Record<string, any>): Promise<PartyRecordResult> {
  return ensureCloudLogin().then(() => getCloudClient()).then(client => client.callFunction({
    name: CLOUD_FUNCTIONS.partyRecord,
    data: {
      action,
      ...(data || {}),
    },
  })).then((res: ICloud.CallFunctionResult) => {
    const result = res.result as PartyRecordResult
    if (!result?.ok) {
      const details = [
        result?.code,
        result?.message || '酒局记录操作失败',
        result?.debug,
      ].filter(Boolean).join(' | ')
      throw new Error(details)
    }
    return result
  })
}

/**
 * 保存当前未结束酒局。
 *
 * 注意：本地 wxfile:// 头像路径不上传云端；跨设备恢复时会回退到文字头像。
 */
export function saveActivePartyToCloud(party: IPartyData): Promise<CloudPartyRecord | null> {
  return callPartyRecord('upsertActive', {
    party: normalizeCloudParty(party),
  }).then(result => result.data?.record || null)
}

export function getActivePartyFromCloud(): Promise<CloudPartyRecord | null> {
  return callPartyRecord('getActive').then(result => result.data?.record || null)
}

export function listActivePartiesFromCloud(limit = 20): Promise<CloudPartyRecord[]> {
  return callPartyRecord('listActive', { limit })
    .then(result => result.data?.records || [])
    .catch(err => {
      const message = String(err?.message || err || '')
      if (message.includes('UNKNOWN_ACTION') || message.includes('未知的酒局记录操作')) {
        return getActivePartyFromCloud().then(record => (record ? [record] : []))
      }
      throw err
    })
}

export function finishPartyInCloud(party: IPartyData): Promise<CloudPartyRecord | null> {
  return callPartyRecord('finish', {
    party: normalizeCloudParty(party),
  }).then(result => result.data?.record || null)
}

export function discardActivePartyInCloud(partyId?: string): Promise<boolean> {
  return callPartyRecord('discardActive', partyId ? { partyId } : undefined).then(() => true)
}

/**
 * 删除一条云端酒局记录。
 *
 * 仅传 partyId，权限校验放在云函数内按 openid/appid 执行；
 * 前端删除成功后再更新列表和本地缓存。
 */
export function deletePartyRecordFromCloud(partyId: string): Promise<boolean> {
  return callPartyRecord('deleteRecord', { partyId }).then(() => true)
}

/**
 * 分页读取已结束酒局。
 *
 * cursor 由云函数生成，前端只负责原样传回；下拉刷新时传空游标，
 * 继续加载时传上一页的 nextCursor，避免再用递增 limit 重复拉取历史数据。
 */
export function listEndedPartiesFromCloud(options: {
  limit?: number
  cursor?: CloudPartyPageCursor
} = {}): Promise<CloudPartyRecordPage> {
  const limit = options.limit || 20
  return callPartyRecord('listEnded', {
    limit,
    cursor: options.cursor || '',
  }).then(result => {
    const records = result.data?.records || []
    const nextCursor = result.data?.nextCursor || ''
    return {
      records,
      nextCursor,
      hasMore: !!(result.data?.hasMore && nextCursor),
      limit: Number(result.data?.limit || limit),
    }
  })
}
