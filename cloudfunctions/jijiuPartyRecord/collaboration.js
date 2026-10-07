const crypto = require('crypto')

const INVITE_KIND = 'invite'
const HANDOVER_KIND = 'handover'
const DEFAULT_OPERATION_LIMIT = 40
const MAX_OPERATION_LIMIT = 50

class CollaborationError extends Error {
  constructor(code, message, data) {
    super(code)
    this.name = 'CollaborationError'
    this.code = code
    this.publicMessage = message || ''
    this.data = data || null
  }
}

function toBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function fromBase64Url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/')
  const padding = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : ''
  return Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8')
}

function requireSecret(secret) {
  const normalized = String(secret || '')
  if (normalized.length < 32) {
    throw new CollaborationError(
      'NO_PERMISSION',
      '共享邀请服务尚未配置，请联系管理员',
    )
  }
  return normalized
}

function signPayload(payload, secret) {
  return toBase64Url(
    crypto.createHmac('sha256', requireSecret(secret)).update(payload).digest().subarray(0, 16),
  )
}

function createSignedCode(kind, fields, secret) {
  const payload = [kind, ...fields.map(value => String(value))].join('|')
  return `${toBase64Url(payload)}.${signPayload(payload, secret)}`
}

function verifySignedCode(code, expectedKind, secret, now = Date.now()) {
  try {
    const [payloadPart, signature] = String(code || '').split('.')
    if (!payloadPart || !signature) throw new Error('MALFORMED')
    const payload = fromBase64Url(payloadPart)
    const expectedSignature = signPayload(payload, secret)
    const actual = Buffer.from(signature)
    const expected = Buffer.from(expectedSignature)
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw new Error('BAD_SIGNATURE')
    }
    const fields = payload.split('|')
    if (fields[0] !== expectedKind) throw new Error('BAD_KIND')
    const expiresAt = Number(fields[2])
    if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('EXPIRED')
    return { fields, expiresAt }
  } catch (err) {
    if (err instanceof CollaborationError) throw err
    throw new CollaborationError('INVITE_EXPIRED', '邀请已失效，请让房主重新生成')
  }
}

function createInviteCode({ partyId, expiresAt, version, secret }) {
  return createSignedCode(INVITE_KIND, [partyId, expiresAt, version], secret)
}

function verifyInviteCode(code, secret, now = Date.now()) {
  const verified = verifySignedCode(code, INVITE_KIND, secret, now)
  return {
    partyId: verified.fields[1],
    expiresAt: verified.expiresAt,
    version: Number(verified.fields[3]),
  }
}

function createHandoverCode({ partyId, targetMemberId, transferId, expiresAt, secret }) {
  return createSignedCode(
    HANDOVER_KIND,
    [partyId, expiresAt, targetMemberId, transferId],
    secret,
  )
}

function verifyHandoverCode(code, secret, now = Date.now()) {
  const verified = verifySignedCode(code, HANDOVER_KIND, secret, now)
  return {
    partyId: verified.fields[1],
    expiresAt: verified.expiresAt,
    targetMemberId: verified.fields[3],
    transferId: verified.fields[4],
  }
}

function parseRecordTimestamp(record, party) {
  const idTimestamp = Number(String(record && record.id || '').split('_')[0])
  if (Number.isFinite(idTimestamp) && idTimestamp > 1000000000000) return idTimestamp

  const rawTime = String(record && record.time || '')
  const parsed = Date.parse(rawTime)
  if (!Number.isNaN(parsed)) return parsed

  const matched = rawTime.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  const partyTime = Date.parse(String(party && party.createdAt || ''))
  if (matched && !Number.isNaN(partyTime)) {
    const date = new Date(partyTime)
    date.setHours(Number(matched[1]), Number(matched[2]), Number(matched[3] || 0), 0)
    return date.getTime()
  }
  // 旧记录若既无时间戳 ID 也无可解析时间，只返回 0，不编造发生时间；
  // 同为 0 时由原数组顺序提供稳定排序。
  return 0
}

function buildOperations(party, limit) {
  let order = 0
  const operations = []
  const players = Array.isArray(party && party.players) ? party.players : []
  players.forEach(player => {
    const records = Array.isArray(player.records) ? player.records : []
    records.forEach(record => {
      order += 1
      const action = record && record.action === '-' ? '-' : '+'
      const amount = Math.max(Number(record && record.amount || 0), 0)
      operations.push({
        id: String(record && record.id || `${player.id}-${order}`),
        playerId: String(player.id || ''),
        playerName: String(player.name || ''),
        time: String(record && record.time || ''),
        timestamp: parseRecordTimestamp(record, party),
        action,
        amount,
        unit: String(record && record.unit || '口'),
        sipDelta: Number.isFinite(Number(record && record.sipDelta))
          ? Number(record.sipDelta)
          : (action === '+' ? amount : -amount),
        consumedUnitsDelta: Math.max(Number(record && record.consumedUnitsDelta || 0), 0),
        order,
      })
    })
  })

  return operations
    .sort((a, b) => b.timestamp - a.timestamp || b.order - a.order)
    .slice(0, limit)
    .map(({ order: _order, ...operation }) => operation)
}

function publicMember(member) {
  return {
    memberId: String(member && member.memberId || ''),
    displayName: String(member && member.displayName || ''),
    role: member && member.role === 'owner' ? 'owner' : 'viewer',
    status: ['active', 'left', 'removed'].includes(member && member.status)
      ? member.status
      : 'active',
    ...(member && member.claimedPlayerId
      ? { claimedPlayerId: String(member.claimedPlayerId) }
      : {}),
  }
}

function buildSharedPartyPayload(record, _members, _callerMember, options = {}) {
  const party = record && record.party ? record.party : {}
  const requestedLimit = Number(options.limit || DEFAULT_OPERATION_LIMIT)
  const operationLimit = Math.max(30, Math.min(
    Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_OPERATION_LIMIT,
    MAX_OPERATION_LIMIT,
  ))
  const players = (Array.isArray(party.players) ? party.players : []).map(player => ({
    id: String(player.id || ''),
    name: String(player.name || ''),
    totalSips: Number(player.totalSips || 0),
    consumedUnits: Math.max(Number(player.consumedUnits || 0), 0),
  }))
  const updatedAt = Number(options.updatedAt || 0)
  const payload = {
    partyId: String(record && record.partyId || party.partyId || ''),
    status: record && record.status === 'ended' ? 'ended' : 'active',
    createdAt: String(party.createdAt || ''),
    startTime: Number(party.startTime || 0),
    endedAt: String(party.endedAt || ''),
    pausedAt: String(party.pausedAt || ''),
    pausedDurationMs: Math.max(Number(party.pausedDurationMs || 0), 0),
    settings: {
      unit: String(party.settings && party.settings.unit || '瓶'),
      unitToSip: Math.max(Number(party.settings && party.settings.unitToSip || 1), 1),
    },
    players,
    operations: buildOperations(party, operationLimit),
    updatedAt,
  }
  payload.contentDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 20)
  return payload
}

function assertPlayerClaimAvailable(members, memberId, playerId) {
  if (!playerId) return true
  const conflict = (Array.isArray(members) ? members : []).find(member => (
    member &&
    member.status === 'active' &&
    member.claimedPlayerId === playerId &&
    member.memberId !== memberId
  ))
  if (conflict) {
    throw new CollaborationError('ALREADY_CLAIMED', '这个名字已被其他成员认领')
  }
  return true
}

module.exports = {
  CollaborationError,
  assertPlayerClaimAvailable,
  buildSharedPartyPayload,
  createHandoverCode,
  createInviteCode,
  publicMember,
  verifyHandoverCode,
  verifyInviteCode,
}
