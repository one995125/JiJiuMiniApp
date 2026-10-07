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

export type SharedPartyMember = {
  memberId: string
  displayName: string
  role: 'owner' | 'viewer'
  status: 'active' | 'left' | 'removed'
  claimedPlayerId?: string
}

export type SharedPartyPlayer = {
  id: string
  name: string
  totalSips: number
  consumedUnits: number
}

export type SharedPartyOperation = {
  id: string
  playerId: string
  playerName: string
  time: string
  timestamp: number
  action: '+' | '-'
  amount: number
  unit: string
  sipDelta: number
  consumedUnitsDelta: number
}

export type SharedPartySnapshot = {
  partyId: string
  status: 'active' | 'ended'
  createdAt: string
  startTime: number
  endedAt?: string
  pausedAt?: string
  pausedDurationMs: number
  settings: IPartySettings
  players: SharedPartyPlayer[]
  operations: SharedPartyOperation[]
  updatedAt: number
  contentDigest: string
}

export type PartyMembersResult = {
  members: SharedPartyMember[]
  me: SharedPartyMember
  pendingTransfer?: {
    transferId: string
    targetMemberId: string
    expiresAt: number
  }
  handoverCode?: string
}

export type CloudPartyPageCursor = string

export type CloudPartyRecordPage = {
  records: CloudPartyRecord[]
  nextCursor: CloudPartyPageCursor
  hasMore: boolean
  limit: number
}

type PartyRecordData = {
  record?: CloudPartyRecord | null
  records?: CloudPartyRecord[]
  nextCursor?: CloudPartyPageCursor
  hasMore?: boolean
  limit?: number
  snapshot?: SharedPartySnapshot
  member?: SharedPartyMember
  members?: SharedPartyMember[]
  me?: SharedPartyMember
  partyId?: string
  inviteCode?: string
  expiresAt?: number
  joined?: boolean
  pendingTransfer?: PartyMembersResult['pendingTransfer']
  handoverCode?: string
  newPartyId?: string
}

type PartyRecordResult = {
  ok: boolean
  data?: PartyRecordData
  code?: string
  message?: string
  debug?: string
}

/** 云函数业务错误。页面只展示 message，并按 code 做交接跳转等安全处理。 */
export class PartyCloudError extends Error {
  code: string
  data?: PartyRecordData

  constructor(code: string, message: string, data?: PartyRecordData) {
    super(message)
    this.name = 'PartyCloudError'
    this.code = code
    this.data = data
  }
}

export function isPartyCloudError(error: unknown, code?: string): error is PartyCloudError {
  const target = error as PartyCloudError
  return !!target && target.name === 'PartyCloudError' && (!code || target.code === code)
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
    data: { action, ...(data || {}) },
  })).then((res: ICloud.CallFunctionResult) => {
    const result = res.result as PartyRecordResult
    if (!result?.ok) {
      if (result?.debug) console.warn('[party cloud]', action, result.debug)
      throw new PartyCloudError(
        result?.code || 'PARTY_RECORD_FAILED',
        result?.message || '酒局记录操作失败',
        result?.data,
      )
    }
    return result
  })
}

/** 保存当前未结束酒局；本地头像路径不会上传。 */
export function saveActivePartyToCloud(party: IPartyData): Promise<CloudPartyRecord | null> {
  return callPartyRecord('upsertActive', { party: normalizeCloudParty(party) })
    .then(result => result.data?.record || null)
}

export function getActivePartyFromCloud(): Promise<CloudPartyRecord | null> {
  return callPartyRecord('getActive').then(result => result.data?.record || null)
}

export function listActivePartiesFromCloud(limit = 20): Promise<CloudPartyRecord[]> {
  return callPartyRecord('listActive', { limit })
    .then(result => result.data?.records || [])
    .catch(err => {
      if (isPartyCloudError(err, 'UNKNOWN_ACTION')) {
        return getActivePartyFromCloud().then(record => (record ? [record] : []))
      }
      throw err
    })
}

export function finishPartyInCloud(party: IPartyData): Promise<CloudPartyRecord | null> {
  return callPartyRecord('finish', { party: normalizeCloudParty(party) })
    .then(result => result.data?.record || null)
}

export function discardActivePartyInCloud(partyId?: string): Promise<boolean> {
  return callPartyRecord('discardActive', partyId ? { partyId } : undefined).then(() => true)
}

export function deletePartyRecordFromCloud(partyId: string): Promise<boolean> {
  return callPartyRecord('deleteRecord', { partyId }).then(() => true)
}

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

/** 房主生成 viewer 邀请；重复生成会使上一枚短码失效。 */
export function createPartyInvite(partyId: string): Promise<{
  partyId: string
  inviteCode: string
  expiresAt: number
}> {
  return callPartyRecord('createInvite', { partyId }).then(result => ({
    partyId: String(result.data?.partyId || partyId),
    inviteCode: String(result.data?.inviteCode || ''),
    expiresAt: Number(result.data?.expiresAt || 0),
  }))
}

/** 受邀用户加入只读局；成员身份只由云函数 OPENID 判定。 */
export function joinSharedParty(inviteCode: string): Promise<{
  partyId: string
  member: SharedPartyMember
  joined: boolean
}> {
  return callPartyRecord('joinParty', { inviteCode }).then(result => ({
    partyId: String(result.data?.partyId || ''),
    member: result.data?.member as SharedPartyMember,
    joined: !!result.data?.joined,
  }))
}

export function getSharedParty(partyId: string, limit = 40): Promise<SharedPartySnapshot> {
  return callPartyRecord('getSharedParty', { partyId, limit }).then(result => {
    if (!result.data?.snapshot) {
      throw new PartyCloudError('PARTY_RECORD_FAILED', '共享账本数据为空')
    }
    return result.data.snapshot
  })
}

export function listPartyMembers(partyId: string): Promise<PartyMembersResult> {
  return callPartyRecord('listMembers', { partyId }).then(result => ({
    members: result.data?.members || [],
    me: result.data?.me as SharedPartyMember,
    pendingTransfer: result.data?.pendingTransfer,
    handoverCode: result.data?.handoverCode,
  }))
}

/** playerId 传空字符串表示跳过或取消认领。 */
export function claimSharedPlayer(partyId: string, playerId = ''): Promise<SharedPartyMember> {
  return callPartyRecord('claimPlayer', { partyId, playerId })
    .then(result => result.data?.member as SharedPartyMember)
}

export function updateMemberClaim(
  partyId: string,
  memberId: string,
  playerId = '',
): Promise<SharedPartyMember> {
  return callPartyRecord('updateMemberClaim', { partyId, memberId, playerId })
    .then(result => result.data?.member as SharedPartyMember)
}

export function leaveSharedParty(partyId: string): Promise<boolean> {
  return callPartyRecord('leaveParty', { partyId }).then(() => true)
}

export function removePartyMember(partyId: string, memberId: string): Promise<boolean> {
  return callPartyRecord('removeMember', { partyId, memberId }).then(() => true)
}

export function initiateOwnershipTransfer(
  partyId: string,
  targetMemberId: string,
): Promise<{
  pendingTransfer: NonNullable<PartyMembersResult['pendingTransfer']>
  handoverCode: string
}> {
  return callPartyRecord('transferOwnership', {
    mode: 'initiate',
    partyId,
    targetMemberId,
  }).then(result => ({
    pendingTransfer: result.data?.pendingTransfer as NonNullable<PartyMembersResult['pendingTransfer']>,
    handoverCode: String(result.data?.handoverCode || ''),
  }))
}

export function cancelOwnershipTransfer(partyId: string, transferId: string): Promise<boolean> {
  return callPartyRecord('transferOwnership', {
    mode: 'cancel',
    partyId,
    transferId,
  }).then(() => true)
}

export function confirmOwnershipTransfer(handoverCode: string): Promise<CloudPartyRecord> {
  return callPartyRecord('transferOwnership', {
    mode: 'confirm',
    handoverCode,
  }).then(result => {
    if (!result.data?.record) {
      throw new PartyCloudError('PARTY_RECORD_FAILED', '交接结果为空')
    }
    return result.data.record
  })
}
