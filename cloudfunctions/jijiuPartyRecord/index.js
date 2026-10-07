const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

const db = cloud.database()
const _ = db.command
const {
  CollaborationError,
  assertPlayerClaimAvailable,
  buildSharedPartyPayload,
  createHandoverCode,
  createInviteCode,
  publicMember,
  verifyHandoverCode,
  verifyInviteCode,
} = require('./collaboration')
const PARTY_COLLECTION = 'ji_jiu_parties'
const MEMBER_COLLECTION = 'ji_jiu_party_members'
const DEFAULT_PAGE_SIZE = 10
const MAX_PAGE_SIZE = 50
const DEFAULT_INVITE_TTL_MS = 12 * 60 * 60 * 1000
const MAX_INVITE_TTL_MS = 24 * 60 * 60 * 1000
const HANDOVER_TTL_MS = 10 * 60 * 1000
const INVITE_HMAC_SECRET_ENV = 'JIJIU_INVITE_HMAC_SECRET'

function ok(data) {
  return { ok: true, data }
}

function fail(code, message, debug, data) {
  return { ok: false, code, message, debug, ...(data ? { data } : {}) }
}

function getErrorDetail(err) {
  if (!err) return '未知数据库错误'
  return String(err.errMsg || err.message || err.code || err)
}

function toTimestamp(value) {
  if (!value) return 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  if (value instanceof Date) return value.getTime()

  const raw = value || {}
  if (typeof raw.getTime === 'function') return raw.getTime()
  if (raw.$date) return toTimestamp(raw.$date)
  if (typeof raw.seconds === 'number') return raw.seconds * 1000
  if (typeof raw._seconds === 'number') return raw._seconds * 1000
  return 0
}

function getPageSize(limit) {
  const parsed = Number(limit || DEFAULT_PAGE_SIZE)
  return Math.max(1, Math.min(Number.isFinite(parsed) ? parsed : DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE))
}

/**
 * 获取实际调用方身份。
 *
 * 共享环境使用 FROM_* 字段，资源方本身调用时回退到普通字段。业务查询同时
 * 使用 ownerOpenid 与 ownerAppid，避免同一共享环境内不同小程序的数据
 * 相互可见，并避免占用云数据库的 _openid 等系统字段。
 */
function getCallerIdentity() {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.FROM_OPENID || wxContext.OPENID || ''
  const appid = wxContext.FROM_APPID || wxContext.APPID || ''
  if (!openid || !appid) {
    throw new Error('NO_OPENID')
  }
  return { openid, appid }
}

function sanitizeRecord(record, index) {
  const action = record && record.action === '-' ? '-' : '+'
  const amount = Math.max(Number(record && record.amount ? record.amount : 0), 0)
  const rawSipDelta = Number(record && record.sipDelta)
  const rawConsumedUnitsDelta = Number(record && record.consumedUnitsDelta)
  return {
    id: String(record && record.id
      ? record.id
      : `legacy-${index}-${record && record.time ? record.time : ''}-${action}-${amount}`),
    time: String(record && record.time ? record.time : ''),
    action,
    amount,
    unit: String(record && record.unit ? record.unit : '口'),
    sipDelta: Number.isFinite(rawSipDelta)
      ? rawSipDelta
      : (action === '+' ? amount : -amount),
    consumedUnitsDelta: Number.isFinite(rawConsumedUnitsDelta)
      ? Math.max(0, Math.round(rawConsumedUnitsDelta))
      : 0,
  }
}

function sanitizeParty(party) {
  if (!party || typeof party !== 'object') {
    throw new Error('INVALID_PARTY')
  }
  if (!party.partyId || typeof party.partyId !== 'string') {
    throw new Error('INVALID_PARTY_ID')
  }
  const settings = party.settings || {}
  const unit = ['杯', '瓶', '罐'].includes(settings.unit) ? settings.unit : '瓶'
  const unitToSip = Math.max(1, Math.min(999, Number(settings.unitToSip || 30)))
  const players = Array.isArray(party.players) ? party.players.slice(0, 50).map(p => ({
    id: String(p && p.id ? p.id : ''),
    name: String(p && p.name ? p.name : '').slice(0, 20),
    totalSips: Number(p && p.totalSips ? p.totalSips : 0),
    consumedUnits: Number(p && p.consumedUnits ? p.consumedUnits : 0),
    records: Array.isArray(p && p.records)
      ? p.records.slice(-500).map((record, index) => sanitizeRecord(record, index))
      : [],
  })).filter(p => p.id && p.name) : []

  if (players.length === 0) {
    throw new Error('INVALID_PLAYERS')
  }

  const normalizedParty = {
    partyId: party.partyId,
    createdAt: party.createdAt || new Date().toISOString(),
    updatedAt: party.updatedAt || '',
    endedAt: party.endedAt || '',
    settings: { unit, unitToSip },
    players,
    startTime: Number(party.startTime || Date.now()),
    playerAvatarPhotos: {},
  }
  if (party.pausedAt) normalizedParty.pausedAt = String(party.pausedAt)
  const pausedDurationMs = Number(party.pausedDurationMs || 0)
  if (Number.isFinite(pausedDurationMs) && pausedDurationMs > 0) {
    normalizedParty.pausedDurationMs = pausedDurationMs
  }
  return normalizedParty
}

function countPartyRecords(party) {
  const players = Array.isArray(party && party.players) ? party.players : []
  return players.reduce((sum, p) => (
    sum + (Array.isArray(p.records) ? p.records.length : 0)
  ), 0)
}

function getPartySyncTime(party) {
  if (!party) return 0
  return Math.max(
    toTimestamp(party.updatedAt),
    toTimestamp(party.endedAt),
    toTimestamp(party.createdAt),
  )
}

function getStoredPartyVersion(record) {
  if (!record) return 0
  return Math.max(
    getPartySyncTime(record.party),
    toTimestamp(record.endedAt),
  )
}

function getStoredRecordCount(record) {
  const statsCount = Number(record && record.stats && record.stats.recordCount)
  return Number.isFinite(statsCount) && statsCount >= 0
    ? statsCount
    : countPartyRecords(record && record.party)
}

async function getExistingPartyRecord(partyId) {
  try {
    const res = await db.collection(PARTY_COLLECTION).doc(partyId).get()
    return res && res.data ? res.data : null
  } catch (err) {
    return null
  }
}

function shouldKeepExistingRecord(existing, identity, incomingParty, incomingStats) {
  if (
    !existing ||
    existing.ownerOpenid !== identity.openid ||
    existing.ownerAppid !== identity.appid
  ) {
    return false
  }

  const existingVersion = getStoredPartyVersion(existing)
  const incomingVersion = getPartySyncTime(incomingParty)
  if (existingVersion && incomingVersion && existingVersion > incomingVersion) {
    return true
  }

  /**
   * 兼容极少数同毫秒快照：如果版本相同但云端记录数更多，保留云端。
   * 主要防止“上一轮退出补传”晚到时覆盖用户继续记账后的新快照。
   */
  return existingVersion === incomingVersion &&
    getStoredRecordCount(existing) > Number(incomingStats.recordCount || 0)
}

function buildStats(party, endTime) {
  const recordCount = countPartyRecords(party)
  const startTime = Number(party.startTime || Date.now())
  const referenceTime = endTime || Date.now()
  const pausedAt = toTimestamp(party.pausedAt)
  const settledPausedMs = Math.max(Number(party.pausedDurationMs || 0), 0)
  const currentPausedMs = pausedAt ? Math.max(referenceTime - pausedAt, 0) : 0
  const durationMs = Math.max(referenceTime - startTime - settledPausedMs - currentPausedMs, 0)
  return {
    playerCount: party.players.length,
    recordCount,
    unit: party.settings.unit,
    unitToSip: party.settings.unitToSip,
    durationMs,
  }
}

async function upsertParty(identity, party, status) {
  const now = db.serverDate()
  const endedAtMs = status === 'ended'
    ? (toTimestamp(party.endedAt) || Date.now())
    : 0
  const stats = buildStats(party, endedAtMs || Date.now())
  const data = {
    ownerOpenid: identity.openid,
    ownerAppid: identity.appid,
    partyId: party.partyId,
    status,
    party,
    stats,
    updatedAt: now,
  }
  if (status === 'ended') {
    const endedAt = new Date(endedAtMs || Date.now())
    data.endedAt = endedAt
    data.updatedAt = endedAt
  }

  const existing = await getExistingPartyRecord(party.partyId)
  /**
   * 既有 partyId 只能由原房主继续保存。共享成员即使自行构造旧版写请求，
   * 也不能把同一文档改写到自己名下；新建 partyId 的原有流程保持不变。
   */
  if (
    existing &&
    (existing.ownerOpenid !== identity.openid || existing.ownerAppid !== identity.appid)
  ) {
    throw new CollaborationError('NO_PERMISSION', '共享成员只能查看，不能修改房主账本')
  }
  if (shouldKeepExistingRecord(existing, identity, party, stats)) {
    console.warn('[partyRecord] skip stale upsert', {
      partyId: party.partyId,
      status,
      incomingVersion: getPartySyncTime(party),
      existingVersion: getStoredPartyVersion(existing),
    })
    return {
      partyId: existing.partyId,
      status: existing.status,
      party: existing.party,
      stats: existing.stats,
      updatedAt: existing.updatedAt,
      endedAt: existing.endedAt,
    }
  }

  await db.collection(PARTY_COLLECTION).doc(party.partyId).set({ data })
  return {
    partyId: party.partyId,
    status,
    party,
    stats,
  }
}

async function getActive(identity) {
  const res = await db.collection(PARTY_COLLECTION)
    .where({
      ownerOpenid: identity.openid,
      ownerAppid: identity.appid,
      status: 'active',
    })
    .orderBy('updatedAt', 'desc')
    .limit(1)
    .get()
  return res.data && res.data[0] ? res.data[0] : null
}

async function listActive(identity, limit) {
  const res = await db.collection(PARTY_COLLECTION)
    .where({
      ownerOpenid: identity.openid,
      ownerAppid: identity.appid,
      status: 'active',
    })
    .orderBy('updatedAt', 'desc')
    .limit(limit)
    .get()
  return res.data || []
}

function getRecordPartyId(record) {
  return String(record && (record.partyId || record._id || (record.party && record.party.partyId)) || '')
}

function getEndedSortTime(record) {
  if (!record) return 0
  return Math.max(
    toTimestamp(record.endedAt),
    toTimestamp(record.party && record.party.endedAt),
    toTimestamp(record.updatedAt),
    toTimestamp(record.party && record.party.updatedAt),
    toTimestamp(record.party && record.party.createdAt),
  )
}

function encodeEndedCursor(record) {
  const endedAt = getEndedSortTime(record)
  const partyId = getRecordPartyId(record)
  if (!endedAt || !partyId) return ''
  return Buffer.from(JSON.stringify({ endedAt, partyId }), 'utf8').toString('base64')
}

function decodeEndedCursor(cursor) {
  if (!cursor) return null

  try {
    const raw = JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8'))
    const endedAt = Number(raw && raw.endedAt)
    const partyId = String(raw && raw.partyId ? raw.partyId : '')
    if (!Number.isFinite(endedAt) || endedAt <= 0 || !partyId) {
      throw new Error('INVALID_CURSOR')
    }
    return { endedAt, partyId }
  } catch (err) {
    throw new Error('INVALID_CURSOR')
  }
}

function buildEndedPageCondition(identity, cursor) {
  const baseCondition = {
    ownerOpenid: identity.openid,
    ownerAppid: identity.appid,
    status: 'ended',
  }
  if (!cursor) return baseCondition

  /**
   * 已结束酒局使用“结束时间倒序 + partyId 倒序”做稳定分页。
   * endedAt 负责走复合索引，partyId 只在同一毫秒结束的记录里做兜底排序，
   * 避免继续加载时因为同时间记录重复或漏读。
   */
  const cursorDate = new Date(cursor.endedAt)
  return _.and(
    baseCondition,
    _.or(
      { endedAt: _.lt(cursorDate) },
      { endedAt: cursorDate, partyId: _.lt(cursor.partyId) },
    ),
  )
}

async function listEnded(identity, options) {
  const limit = getPageSize(options && options.limit)
  const cursor = decodeEndedCursor(options && options.cursor)
  const res = await db.collection(PARTY_COLLECTION)
    .where(buildEndedPageCondition(identity, cursor))
    .orderBy('endedAt', 'desc')
    .orderBy('partyId', 'desc')
    .limit(limit + 1)
    .get()
  const rows = res.data || []
  const records = rows.slice(0, limit)
  const nextCursor = rows.length > limit ? encodeEndedCursor(records[records.length - 1]) : ''

  return {
    records,
    nextCursor,
    hasMore: !!nextCursor,
    limit,
  }
}

function buildSelfCheckParty(checkId) {
  const now = Date.now()
  return sanitizeParty({
    partyId: checkId,
    createdAt: new Date(now).toISOString(),
    settings: { unit: '瓶', unitToSip: 30 },
    players: [
      {
        id: 'cloud-self-checker',
        name: '云自检',
        totalSips: 1,
        consumedUnits: 0,
        records: [
          {
            id: `${checkId}-record`,
            time: new Date(now).toISOString(),
            action: '+',
            amount: 1,
            unit: '口',
            sipDelta: 1,
            consumedUnitsDelta: 0,
          },
        ],
      },
    ],
    startTime: now,
    playerAvatarPhotos: {},
  })
}

/**
 * 云开发自检专用动作。
 *
 * 调用时机：仅隐藏自检页主动触发。它先读取当前用户的活跃酒局，再写入一条
 * 独立临时文档并按文档 ID 清理，避免影响用户正在进行的真实酒局。
 */
async function runSelfCheck(identity) {
  const checkId = `cloud-self-check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const result = {
    activeReadable: false,
    activePartyExists: false,
    wrote: false,
    readBack: false,
    cleaned: false,
    checkPartyId: checkId,
    stats: null,
    cleanupError: '',
  }

  try {
    const active = await getActive(identity)
    result.activeReadable = true
    result.activePartyExists = !!active

    const party = buildSelfCheckParty(checkId)
    const record = await upsertParty(identity, party, 'active')
    result.wrote = true
    result.stats = record.stats

    const readBack = await db.collection(PARTY_COLLECTION).doc(checkId).get()
    const data = readBack && readBack.data ? readBack.data : null
    result.readBack = !!(
      data &&
      data.partyId === checkId &&
      data.ownerOpenid === identity.openid &&
      data.ownerAppid === identity.appid &&
      data.status === 'active'
    )
  } finally {
    if (result.wrote) {
      try {
        await db.collection(PARTY_COLLECTION).doc(checkId).remove()
        result.cleaned = true
      } catch (cleanupErr) {
        result.cleanupError = getErrorDetail(cleanupErr)
      }
    }
  }

  return result
}

function getInviteSecret() {
  const secret = process.env[INVITE_HMAC_SECRET_ENV] || ''
  if (String(secret).length < 32) {
    throw new CollaborationError('NO_PERMISSION', '共享邀请服务尚未配置，请联系管理员')
  }
  return secret
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}

function buildMemberDocumentId(identity, partyId) {
  return `${partyId}_${hashText(`${identity.appid}:${identity.openid}`).slice(0, 24)}`
}

function buildMemberId(identity, partyId) {
  return `m_${hashText(`${partyId}:${identity.appid}:${identity.openid}`).slice(0, 18)}`
}

function memberWriteData(member) {
  const data = {
    partyId: String(member.partyId || ''),
    appid: String(member.appid || ''),
    openid: String(member.openid || ''),
    memberId: String(member.memberId || ''),
    role: member.role === 'owner' ? 'owner' : 'viewer',
    displayName: String(member.displayName || (member.role === 'owner' ? '房主' : '同桌成员')).slice(0, 20),
    status: ['active', 'left', 'removed'].includes(member.status) ? member.status : 'active',
    joinedAt: member.joinedAt || new Date(),
    updatedAt: member.updatedAt || new Date(),
  }
  if (member.claimedPlayerId) data.claimedPlayerId = String(member.claimedPlayerId)
  if (member.lastSeenAt) data.lastSeenAt = member.lastSeenAt
  if (Number.isFinite(Number(member.inviteVersion))) data.inviteVersion = Number(member.inviteVersion)
  if (member.pendingTransfer) data.pendingTransfer = member.pendingTransfer
  if (member.handedOverToPartyId) data.handedOverToPartyId = String(member.handedOverToPartyId)
  return data
}

async function getMemberByIdentity(identity, partyId, transaction) {
  const client = transaction || db
  try {
    const result = await client.collection(MEMBER_COLLECTION)
      .doc(buildMemberDocumentId(identity, partyId))
      .get()
    return result && result.data ? result.data : null
  } catch (err) {
    return null
  }
}

async function listPartyMembers(identity, partyId, transaction) {
  const client = transaction || db
  const result = await client.collection(MEMBER_COLLECTION)
    .where({ appid: identity.appid, partyId })
    .limit(100)
    .get()
  return result.data || []
}

async function ensureOwnerMember(record, identity) {
  if (!record || record.ownerOpenid !== identity.openid || record.ownerAppid !== identity.appid) {
    throw new CollaborationError('NO_PERMISSION', '只有房主可以执行此操作')
  }
  const existing = await getMemberByIdentity(identity, record.partyId)
  if (existing) {
    if (existing.status !== 'active' || existing.role !== 'owner') {
      const next = memberWriteData({
        ...existing,
        role: 'owner',
        status: 'active',
        updatedAt: new Date(),
      })
      await db.collection(MEMBER_COLLECTION).doc(existing._id).set({ data: next })
      return { _id: existing._id, ...next }
    }
    return existing
  }

  const now = new Date()
  const memberId = existing && existing.memberId
    ? existing.memberId
    : buildMemberId(identity, invitation.partyId)
  const member = memberWriteData({
    partyId: record.partyId,
    appid: identity.appid,
    openid: identity.openid,
    memberId: buildMemberId(identity, record.partyId),
    role: 'owner',
    displayName: '房主',
    status: 'active',
    joinedAt: now,
    updatedAt: now,
    inviteVersion: 0,
  })
  const docId = buildMemberDocumentId(identity, record.partyId)
  await db.collection(MEMBER_COLLECTION).doc(docId).set({ data: member })
  return { _id: docId, ...member }
}

function assertPartyOwner(record, identity) {
  if (!record || record.ownerOpenid !== identity.openid || record.ownerAppid !== identity.appid) {
    throw new CollaborationError('NO_PERMISSION', '只有房主可以执行此操作')
  }
}

function assertPartyActive(record) {
  if (!record || record.status !== 'active' || (record.party && record.party.endedAt)) {
    throw new CollaborationError('PARTY_ENDED', '本场聚会已经结束')
  }
}

async function requireActiveMember(identity, partyId) {
  const record = await getExistingPartyRecord(partyId)
  if (!record || record.ownerAppid !== identity.appid) {
    throw new CollaborationError('NOT_A_MEMBER', '你还没有加入这场聚会')
  }
  let member = await getMemberByIdentity(identity, partyId)
  if (!member && record.ownerOpenid === identity.openid) {
    member = await ensureOwnerMember(record, identity)
  }
  if (!member || member.status !== 'active') {
    throw new CollaborationError('NOT_A_MEMBER', '你还没有加入这场聚会')
  }
  if (member.handedOverToPartyId) {
    throw new CollaborationError(
      'PARTY_HANDED_OVER',
      '本场已交接给新房主',
      { newPartyId: member.handedOverToPartyId },
    )
  }
  return { record, member }
}

async function assertNotHandedOver(identity, partyId) {
  const member = await getMemberByIdentity(identity, partyId)
  if (member && member.handedOverToPartyId) {
    throw new CollaborationError(
      'PARTY_HANDED_OVER',
      '本场已交接给新房主，原局不能继续记账',
      { newPartyId: member.handedOverToPartyId },
    )
  }
}

async function createInvite(identity, event) {
  const partyId = String(event.partyId || '')
  const inviteSecret = getInviteSecret()
  const record = await getExistingPartyRecord(partyId)
  assertPartyOwner(record, identity)
  assertPartyActive(record)
  const owner = await ensureOwnerMember(record, identity)
  const transaction = await db.startTransaction()
  let inviteVersion = 0
  try {
    const ownerResult = await transaction.collection(MEMBER_COLLECTION).doc(owner._id).get()
    const latestOwner = ownerResult && ownerResult.data ? ownerResult.data : owner
    inviteVersion = Math.max(Number(latestOwner.inviteVersion || 0), 0) + 1
    const updated = memberWriteData({
      ...latestOwner,
      inviteVersion,
      updatedAt: new Date(),
    })
    await transaction.collection(MEMBER_COLLECTION).doc(owner._id).set({ data: updated })
    await transaction.commit()
  } catch (err) {
    try { await transaction.rollback() } catch (rollbackErr) {
      console.warn('[partyRecord] invite rollback failed', getErrorDetail(rollbackErr))
    }
    throw err
  }

  const requestedTtl = Number(event.ttlMs || DEFAULT_INVITE_TTL_MS)
  const ttlMs = Math.max(60 * 1000, Math.min(
    Number.isFinite(requestedTtl) ? requestedTtl : DEFAULT_INVITE_TTL_MS,
    MAX_INVITE_TTL_MS,
  ))
  const expiresAt = Date.now() + ttlMs
  const inviteCode = createInviteCode({
    partyId,
    expiresAt,
    version: inviteVersion,
    secret: inviteSecret,
  })
  return { partyId, inviteCode, expiresAt, role: 'viewer' }
}

async function joinParty(identity, event) {
  const invitation = verifyInviteCode(event.inviteCode, getInviteSecret())
  const record = await getExistingPartyRecord(invitation.partyId)
  assertPartyActive(record)
  if (!record || record.ownerAppid !== identity.appid) {
    throw new CollaborationError('INVITE_EXPIRED', '邀请已失效，请让房主重新生成')
  }
  const ownerIdentity = { openid: record.ownerOpenid, appid: record.ownerAppid }
  const owner = await getMemberByIdentity(ownerIdentity, invitation.partyId)
  if (!owner || Number(owner.inviteVersion || 0) !== invitation.version) {
    throw new CollaborationError('INVITE_EXPIRED', '邀请已失效，请让房主重新生成')
  }

  if (identity.openid === record.ownerOpenid) {
    const ownerMember = await ensureOwnerMember(record, identity)
    return { partyId: invitation.partyId, member: publicMember(ownerMember), joined: false }
  }

  const docId = buildMemberDocumentId(identity, invitation.partyId)
  const existing = await getMemberByIdentity(identity, invitation.partyId)
  if (existing && existing.status === 'removed') {
    throw new CollaborationError('NO_PERMISSION', '你已被房主移出本场聚会')
  }
  if (existing && existing.status === 'active') {
    return { partyId: invitation.partyId, member: publicMember(existing), joined: false }
  }

  const now = new Date()
  const member = memberWriteData({
    ...(existing || {}),
    partyId: invitation.partyId,
    appid: identity.appid,
    openid: identity.openid,
    memberId,
    role: 'viewer',
    displayName: existing && existing.displayName
      ? existing.displayName
      : `同桌成员${memberId.slice(-4).toUpperCase()}`,
    status: 'active',
    joinedAt: existing && existing.joinedAt ? existing.joinedAt : now,
    updatedAt: now,
  })
  await db.collection(MEMBER_COLLECTION).doc(docId).set({ data: member })
  return { partyId: invitation.partyId, member: publicMember(member), joined: true }
}

async function getSharedParty(identity, event) {
  const partyId = String(event.partyId || '')
  const { record, member } = await requireActiveMember(identity, partyId)
  const updatedAt = Math.max(
    toTimestamp(record.updatedAt),
    toTimestamp(record.party && record.party.updatedAt),
    toTimestamp(record.endedAt),
  )
  return {
    snapshot: buildSharedPartyPayload(record, [], member, {
      limit: event.limit,
      updatedAt,
    }),
  }
}

async function listMembers(identity, event) {
  const partyId = String(event.partyId || '')
  const { record, member } = await requireActiveMember(identity, partyId)
  const members = await listPartyMembers(identity, partyId)
  const ownerMember = members.find(item => item.role === 'owner' && item.status === 'active')
  return {
    members: members.filter(item => item.status === 'active').map(publicMember),
    me: publicMember(member),
    ...(record.ownerOpenid === identity.openid && ownerMember && ownerMember.pendingTransfer
      ? {
        pendingTransfer: {
          transferId: ownerMember.pendingTransfer.transferId,
          targetMemberId: ownerMember.pendingTransfer.targetMemberId,
          expiresAt: ownerMember.pendingTransfer.expiresAt,
        },
        handoverCode: createHandoverCode({
          partyId,
          targetMemberId: ownerMember.pendingTransfer.targetMemberId,
          transferId: ownerMember.pendingTransfer.transferId,
          expiresAt: ownerMember.pendingTransfer.expiresAt,
          secret: getInviteSecret(),
        }),
      }
      : {}),
  }
}

function assertPlayerExists(record, playerId) {
  if (!playerId) return
  const exists = Array.isArray(record && record.party && record.party.players) &&
    record.party.players.some(player => player.id === playerId)
  if (!exists) throw new CollaborationError('NO_PERMISSION', '认领的参与者不存在')
}

async function setMemberClaim(identity, options) {
  const partyId = String(options.partyId || '')
  const playerId = String(options.playerId || '')
  const record = await getExistingPartyRecord(partyId)
  assertPartyActive(record)
  if (!record || record.ownerAppid !== identity.appid) {
    throw new CollaborationError('NOT_A_MEMBER', '你还没有加入这场聚会')
  }
  assertPlayerExists(record, playerId)
  if (options.ownerCorrection) assertPartyOwner(record, identity)

  const transaction = await db.startTransaction()
  try {
    const members = await listPartyMembers(identity, partyId, transaction)
    let target = null
    if (options.ownerCorrection) {
      target = members.find(item => item.memberId === options.targetMemberId)
    } else {
      target = members.find(item => item.openid === identity.openid)
    }
    if (!target || target.status !== 'active') {
      throw new CollaborationError('NOT_A_MEMBER', '目标成员不在本场聚会中')
    }
    assertPlayerClaimAvailable(members, target.memberId, playerId)
    const next = memberWriteData({
      ...target,
      claimedPlayerId: playerId || undefined,
      updatedAt: new Date(),
    })
    await transaction.collection(MEMBER_COLLECTION).doc(target._id).set({ data: next })
    await transaction.commit()
    return { member: publicMember(next) }
  } catch (err) {
    try { await transaction.rollback() } catch (rollbackErr) {
      console.warn('[partyRecord] claim rollback failed', getErrorDetail(rollbackErr))
    }
    const detail = getErrorDetail(err)
    if (detail.includes('duplicate') || detail.includes('DUPLICATE') || detail.includes('-502005')) {
      throw new CollaborationError('ALREADY_CLAIMED', '这个名字已被其他成员认领')
    }
    throw err
  }
}

async function leaveParty(identity, event) {
  const partyId = String(event.partyId || '')
  const { member } = await requireActiveMember(identity, partyId)
  if (member.role === 'owner') {
    throw new CollaborationError('NO_PERMISSION', '房主不能直接离开，请先转让本场')
  }
  const next = memberWriteData({
    ...member,
    claimedPlayerId: undefined,
    status: 'left',
    updatedAt: new Date(),
  })
  await db.collection(MEMBER_COLLECTION).doc(member._id).set({ data: next })
  return { left: true }
}

async function removeMember(identity, event) {
  const partyId = String(event.partyId || '')
  const record = await getExistingPartyRecord(partyId)
  assertPartyOwner(record, identity)
  assertPartyActive(record)
  const members = await listPartyMembers(identity, partyId)
  const target = members.find(item => item.memberId === String(event.memberId || ''))
  if (!target || target.status !== 'active') {
    throw new CollaborationError('NOT_A_MEMBER', '目标成员不在本场聚会中')
  }
  if (target.role === 'owner') {
    throw new CollaborationError('NO_PERMISSION', '不能移除房主本人')
  }
  const next = memberWriteData({
    ...target,
    claimedPlayerId: undefined,
    status: 'removed',
    updatedAt: new Date(),
  })
  await db.collection(MEMBER_COLLECTION).doc(target._id).set({ data: next })
  return { removed: true }
}

function createTransferredPartyRecord(oldRecord, newPartyId, newOwner, now) {
  const sourceParty = sanitizeParty(oldRecord.party)
  const party = {
    ...sourceParty,
    partyId: newPartyId,
    updatedAt: now.toISOString(),
    endedAt: '',
  }
  delete party.pausedAt
  const stats = buildStats(party, now.getTime())
  return {
    ownerOpenid: newOwner.openid,
    ownerAppid: newOwner.appid,
    partyId: newPartyId,
    status: 'active',
    party,
    stats,
    updatedAt: now,
  }
}

async function initiateHandover(identity, event) {
  const partyId = String(event.partyId || '')
  const targetMemberId = String(event.targetMemberId || '')
  const record = await getExistingPartyRecord(partyId)
  assertPartyOwner(record, identity)
  assertPartyActive(record)
  const owner = await ensureOwnerMember(record, identity)
  const members = await listPartyMembers(identity, partyId)
  const target = members.find(item => item.memberId === targetMemberId && item.status === 'active')
  if (!target || target.role === 'owner') {
    throw new CollaborationError('NO_PERMISSION', '请选择一名已加入的同桌成员')
  }
  const now = Date.now()
  const pendingTransfer = {
    transferId: `tr_${now}_${crypto.randomBytes(5).toString('hex')}`,
    targetMemberId,
    expiresAt: now + HANDOVER_TTL_MS,
    createdAt: now,
  }
  const nextOwner = memberWriteData({
    ...owner,
    pendingTransfer,
    updatedAt: new Date(now),
  })
  await db.collection(MEMBER_COLLECTION).doc(owner._id).set({ data: nextOwner })
  const handoverCode = createHandoverCode({
    partyId,
    targetMemberId,
    transferId: pendingTransfer.transferId,
    expiresAt: pendingTransfer.expiresAt,
    secret: getInviteSecret(),
  })
  return { pendingTransfer, handoverCode }
}

async function cancelHandover(identity, event) {
  const partyId = String(event.partyId || '')
  const transferId = String(event.transferId || '')
  const transaction = await db.startTransaction()
  try {
    const recordResult = await transaction.collection(PARTY_COLLECTION).doc(partyId).get()
    const record = recordResult && recordResult.data
    assertPartyOwner(record, identity)
    assertPartyActive(record)
    const ownerDocId = buildMemberDocumentId(identity, partyId)
    const ownerResult = await transaction.collection(MEMBER_COLLECTION).doc(ownerDocId).get()
    const owner = ownerResult && ownerResult.data
    if (!owner || !owner.pendingTransfer || owner.pendingTransfer.transferId !== transferId) {
      throw new CollaborationError('NO_PERMISSION', '该交接已取消或已失效')
    }
    const next = memberWriteData({
      ...owner,
      pendingTransfer: undefined,
      updatedAt: new Date(),
    })
    await transaction.collection(MEMBER_COLLECTION).doc(ownerDocId).set({ data: next })
    await transaction.commit()
    return { cancelled: true }
  } catch (err) {
    try { await transaction.rollback() } catch (rollbackErr) {
      console.warn('[partyRecord] cancel handover rollback failed', getErrorDetail(rollbackErr))
    }
    throw err
  }
}

async function confirmHandover(identity, event) {
  const handover = verifyHandoverCode(event.handoverCode, getInviteSecret())
  const transaction = await db.startTransaction()
  try {
    const partyResult = await transaction.collection(PARTY_COLLECTION).doc(handover.partyId).get()
    const oldRecord = partyResult && partyResult.data
    if (!oldRecord) throw new CollaborationError('PARTY_ENDED', '原聚会不存在或已结束')
    assertPartyActive(oldRecord)

    const members = await listPartyMembers(identity, handover.partyId, transaction)
    const target = members.find(item => item.memberId === handover.targetMemberId)
    const owner = members.find(item => item.role === 'owner' && item.status === 'active')
    if (!target || target.status !== 'active' || target.openid !== identity.openid) {
      throw new CollaborationError('NO_PERMISSION', '只有被指定的成员可以确认交接')
    }
    const pending = owner && owner.pendingTransfer
    if (
      !pending ||
      pending.transferId !== handover.transferId ||
      pending.targetMemberId !== handover.targetMemberId ||
      Number(pending.expiresAt || 0) <= Date.now()
    ) {
      throw new CollaborationError('INVITE_EXPIRED', '交接邀请已失效，请让房主重新发起')
    }

    const now = new Date()
    const newPartyId = `handover_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`
    const newRecord = createTransferredPartyRecord(
      oldRecord,
      newPartyId,
      { openid: identity.openid, appid: identity.appid },
      now,
    )
    const endedParty = {
      ...oldRecord.party,
      endedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }
    const endedRecord = {
      ownerOpenid: oldRecord.ownerOpenid,
      ownerAppid: oldRecord.ownerAppid,
      partyId: oldRecord.partyId,
      status: 'ended',
      party: endedParty,
      stats: buildStats(endedParty, now.getTime()),
      updatedAt: now,
      endedAt: now,
    }

    await transaction.collection(PARTY_COLLECTION).doc(newPartyId).set({ data: newRecord })
    await transaction.collection(PARTY_COLLECTION).doc(handover.partyId).set({ data: endedRecord })

    for (const sourceMember of members) {
      if (sourceMember.status !== 'active') continue
      const oldMember = memberWriteData({
        ...sourceMember,
        role: 'viewer',
        pendingTransfer: undefined,
        handedOverToPartyId: newPartyId,
        updatedAt: now,
      })
      await transaction.collection(MEMBER_COLLECTION).doc(sourceMember._id).set({ data: oldMember })

      const newIdentity = { appid: sourceMember.appid, openid: sourceMember.openid }
      const newMember = memberWriteData({
        partyId: newPartyId,
        appid: sourceMember.appid,
        openid: sourceMember.openid,
        memberId: buildMemberId(newIdentity, newPartyId),
        role: sourceMember.memberId === target.memberId ? 'owner' : 'viewer',
        claimedPlayerId: sourceMember.claimedPlayerId,
        displayName: sourceMember.memberId === target.memberId
          ? '房主'
          : sourceMember.displayName,
        status: 'active',
        joinedAt: now,
        updatedAt: now,
        inviteVersion: sourceMember.memberId === target.memberId ? 0 : undefined,
      })
      const newMemberDocId = buildMemberDocumentId(newIdentity, newPartyId)
      await transaction.collection(MEMBER_COLLECTION).doc(newMemberDocId).set({ data: newMember })
    }

    await transaction.commit()
    return {
      partyId: newPartyId,
      record: {
        partyId: newRecord.partyId,
        status: newRecord.status,
        party: newRecord.party,
        stats: newRecord.stats,
        updatedAt: now.toISOString(),
      },
    }
  } catch (err) {
    try { await transaction.rollback() } catch (rollbackErr) {
      console.warn('[partyRecord] handover rollback failed', getErrorDetail(rollbackErr))
    }
    throw err
  }
}

async function transferOwnership(identity, event) {
  const mode = String(event.mode || '')
  if (mode === 'initiate') return initiateHandover(identity, event)
  if (mode === 'cancel') return cancelHandover(identity, event)
  if (mode === 'confirm') return confirmHandover(identity, event)
  throw new CollaborationError('NO_PERMISSION', '交接操作无效')
}

exports.main = async (event = {}) => {
  let identity = null
  try {
    identity = getCallerIdentity()
  } catch (err) {
    return fail(
      'NO_OPENID',
      '登录已失效，请重新进入小程序',
      '检查 cloudbase_auth、环境共享授权和 partyRecord 云函数是否都已部署。',
    )
  }

  const action = event.action || ''

  try {
    if (action === 'upsertActive') {
      const party = sanitizeParty(event.party)
      await assertNotHandedOver(identity, party.partyId)
      const record = await upsertParty(identity, party, 'active')
      return ok({ record })
    }

    if (action === 'finish') {
      const party = sanitizeParty(event.party)
      await assertNotHandedOver(identity, party.partyId)
      const record = await upsertParty(identity, party, 'ended')
      return ok({ record })
    }

    if (action === 'getActive') {
      const record = await getActive(identity)
      return ok({ record })
    }

    if (action === 'listActive') {
      const limit = getPageSize(event.limit)
      const records = await listActive(identity, limit)
      return ok({ records })
    }

    if (action === 'selfCheck') {
      const selfCheck = await runSelfCheck(identity)
      return ok({ selfCheck })
    }

    if (action === 'discardActive') {
      const partyId = event.partyId ? String(event.partyId) : ''
      const condition = {
        ownerOpenid: identity.openid,
        ownerAppid: identity.appid,
        status: 'active',
      }
      await db.collection(PARTY_COLLECTION)
        .where(partyId ? { ...condition, partyId } : condition)
        .remove()
      return ok({ removed: true })
    }

    if (action === 'deleteRecord') {
      const partyId = event.partyId ? String(event.partyId) : ''
      if (!partyId) {
        throw new Error('INVALID_PARTY_ID')
      }

      /**
       * 删除必须在云函数内按调用方身份过滤。
       * 文档 _id 就是 partyId，先按 ID 读取再校验 owner，避免为删除动作增加额外索引要求。
       */
      const existing = await getExistingPartyRecord(partyId)
      if (!existing) {
        return ok({ removed: false })
      }
      if (
        existing.ownerOpenid !== identity.openid ||
        existing.ownerAppid !== identity.appid
      ) {
        throw new Error('NO_PERMISSION')
      }
      await db.collection(PARTY_COLLECTION).doc(partyId).remove()
      return ok({ removed: true })
    }

    if (action === 'listEnded') {
      return ok(await listEnded(identity, {
        limit: event.limit,
        cursor: event.cursor,
      }))
    }

    if (action === 'getSharedParty') {
      return ok(await getSharedParty(identity, event))
    }

    if (action === 'createInvite') {
      return ok(await createInvite(identity, event))
    }

    if (action === 'joinParty') {
      return ok(await joinParty(identity, event))
    }

    if (action === 'leaveParty') {
      return ok(await leaveParty(identity, event))
    }

    if (action === 'listMembers') {
      return ok(await listMembers(identity, event))
    }

    if (action === 'claimPlayer') {
      return ok(await setMemberClaim(identity, {
        partyId: event.partyId,
        playerId: event.playerId,
        ownerCorrection: false,
      }))
    }

    if (action === 'updateMemberClaim') {
      return ok(await setMemberClaim(identity, {
        partyId: event.partyId,
        playerId: event.playerId,
        targetMemberId: String(event.memberId || ''),
        ownerCorrection: true,
      }))
    }

    if (action === 'removeMember') {
      return ok(await removeMember(identity, event))
    }

    if (action === 'transferOwnership') {
      return ok(await transferOwnership(identity, event))
    }

    return fail('UNKNOWN_ACTION', '未知的酒局记录操作', '请检查前端传入的 action。')
  } catch (err) {
    console.error('[partyRecord] failed', action, err)
    const messageMap = {
      INVALID_PARTY: '酒局数据格式错误',
      INVALID_PARTY_ID: '酒局 ID 缺失',
      INVALID_PLAYERS: '酒局人员不能为空',
      INVALID_CURSOR: '分页游标无效，请下拉刷新后重试',
      NOT_A_MEMBER: '你还没有加入这场聚会',
      NO_PERMISSION: '没有权限执行此操作',
      INVITE_EXPIRED: '邀请已失效，请让房主重新生成',
      ALREADY_CLAIMED: '这个名字已被其他成员认领',
      PARTY_ENDED: '本场聚会已经结束',
      PARTY_HANDED_OVER: '本场已交接给新房主',
    }
    const errorCode = err.code || err.message || 'PARTY_RECORD_FAILED'
    const publicMessage = err.publicMessage || messageMap[errorCode] ||
      (action === 'selfCheck' ? '云开发自检失败' : '云端酒局记录保存失败')
    return fail(
      errorCode,
      publicMessage,
      `${getErrorDetail(err)}；请确认 ji_jiu_parties、ji_jiu_party_members 集合与所需索引已创建。`,
      err.data || null,
    )
  }
}
