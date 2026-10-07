const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
})

const db = cloud.database()
const _ = db.command
const PARTY_COLLECTION = 'ji_jiu_parties'
const DEFAULT_PAGE_SIZE = 10
const MAX_PAGE_SIZE = 50

function ok(data) {
  return { ok: true, data }
}

function fail(code, message, debug) {
  return { ok: false, code, message, debug }
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
      const record = await upsertParty(identity, party, 'active')
      return ok({ record })
    }

    if (action === 'finish') {
      const party = sanitizeParty(event.party)
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

    return fail('UNKNOWN_ACTION', '未知的酒局记录操作', '请检查前端传入的 action 是否为 upsertActive/getActive/listActive/selfCheck/finish/discardActive/deleteRecord/listEnded。')
  } catch (err) {
    console.error('[partyRecord] failed', action, err)
    const messageMap = {
      INVALID_PARTY: '酒局数据格式错误',
      INVALID_PARTY_ID: '酒局 ID 缺失',
      INVALID_PLAYERS: '酒局人员不能为空',
      INVALID_CURSOR: '分页游标无效，请下拉刷新后重试',
      NO_PERMISSION: '没有权限删除这条酒局记录',
    }
    return fail(
      err.message || 'PARTY_RECORD_FAILED',
      messageMap[err.message] || (action === 'selfCheck' ? '云开发自检失败' : '云端酒局记录保存失败'),
      `${getErrorDetail(err)}；请确认 ji_jiu_parties 集合和复合索引已创建。`,
    )
  }
}
