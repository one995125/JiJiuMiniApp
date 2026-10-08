import { buildPartyOverview } from '../../utils/party-overview'
import {
  SharedPartyPlayer,
  SharedPartySnapshot,
  getSharedParty,
  joinSharedParty,
  listPartyMembers,
} from '../../services/party-cloud'

const POLL_INTERVAL_MS = 4000
const LAST_SHARED_PARTY_KEY = 'lastSharedPartyId'

type MetricRow = {
  id: string
  name: string
  avatarText: string
  color: string
  shu: string
  he: string
  qian: string
  titles: string[]
}

function formatNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

function toPlayer(player: SharedPartyPlayer): IPlayer {
  return {
    id: player.id,
    name: player.name,
    totalSips: Number(player.totalSips || 0),
    consumedUnits: Number(player.consumedUnits || 0),
    records: [],
  }
}

function getTitles(player: any): string[] {
  const titles: string[] = []
  if (player.badgeDebt) titles.push('养鱼达人')
  if (player.badgeUnlucky) titles.push('倒霉蛋')
  if (player.badgeSea) titles.push('海量')
  if (player.badgeLucky) titles.push('幸运儿')
  if (player.badgeOverspeed) titles.push('不求人')
  if (player.badgeNpc) titles.push('NPC')
  return titles
}

function buildRows(snapshot: SharedPartySnapshot): MetricRow[] {
  const overview = buildPartyOverview({
    players: snapshot.players.map(toPlayer),
    settings: snapshot.settings,
    includeRanking: true,
    startTime: snapshot.startTime,
  })
  return overview.rankingTierGroups.map(group => {
    const player = group.players[0]
    const source = snapshot.players.find(item => item.id === player.id)
    const totalSips = Number(source?.totalSips || 0)
    const consumedUnits = Number(source?.consumedUnits || 0)
    const grossUnits = (totalSips + consumedUnits * snapshot.settings.unitToSip) /
      Math.max(snapshot.settings.unitToSip, 1)
    return {
      id: player.id,
      name: player.name,
      avatarText: player.name.slice(0, 1),
      color: player.color,
      shu: formatNumber(grossUnits),
      he: formatNumber(consumedUnits),
      qian: formatNumber(totalSips / Math.max(snapshot.settings.unitToSip, 1)),
      titles: getTitles(player),
    }
  })
}

function formatElapsed(snapshot: SharedPartySnapshot, now = Date.now()): string {
  const end = snapshot.status === 'ended' && snapshot.endedAt
    ? Date.parse(snapshot.endedAt)
    : now
  const currentPause = snapshot.pausedAt ? Math.max(now - Date.parse(snapshot.pausedAt), 0) : 0
  const elapsed = Math.max(
    end - Number(snapshot.startTime || end) - Number(snapshot.pausedDurationMs || 0) - currentPause,
    0,
  )
  const minutes = Math.floor(elapsed / 60000)
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}小时${minutes % 60}分钟` : `${minutes}分钟`
}

function readableError(error: unknown): string {
  return String((error as Error)?.message || '加载失败，请稍后重试')
}

Page({
  data: {
    loading: true,
    joining: false,
    errorMessage: '',
    partyId: '',
    inviteInput: '',
    hasParty: false,
    statusText: '进行中',
    durationText: '0分钟',
    unit: '瓶',
    unitToSip: 30,
    rows: [] as MetricRow[],
    operations: [] as Array<{
      id: string
      time: string
      playerName: string
      deltaText: string
      kind: 'add' | 'sub'
    }>,
    updatedAgoText: '刚刚',
  },

  onLoad(options: Record<string, string>) {
    ;(this as any)._partyViewVisible = true
    const inviteCode = options.invite ? decodeURIComponent(options.invite) : ''
    const partyId = options.partyId ? decodeURIComponent(options.partyId) : ''
    if (inviteCode) {
      this.joinByCode(inviteCode)
      return
    }
    const remembered = partyId || String(wx.getStorageSync(LAST_SHARED_PARTY_KEY) || '')
    if (remembered) {
      this.setData({ partyId: remembered })
      this.refreshSnapshot(true)
      return
    }
    this.setData({ loading: false })
  },

  onShow() {
    ;(this as any)._partyViewVisible = true
    if (this.data.partyId) {
      this.refreshSnapshot(false)
      this.startPolling()
    }
  },

  onHide() {
    ;(this as any)._partyViewVisible = false
    this.stopPolling()
  },

  onUnload() {
    ;(this as any)._partyViewVisible = false
    this.stopPolling()
    this.stopUpdatedAgoTimer()
  },

  onPullDownRefresh() {
    this.refreshSnapshot(true).finally(() => wx.stopPullDownRefresh())
  },

  onInviteInput(event: WechatMiniprogram.Input) {
    this.setData({ inviteInput: event.detail.value.trim() })
  },

  onJoinInputCode() {
    if (!this.data.inviteInput) {
      wx.showToast({ title: '请粘贴房主发来的邀请口令', icon: 'none' })
      return
    }
    this.joinByCode(this.data.inviteInput)
  },

  joinByCode(inviteCode: string) {
    if (this.data.joining) return
    this.setData({ joining: true, loading: true, errorMessage: '' })
    joinSharedParty(inviteCode)
      .then(result => {
        if (!result.partyId) throw new Error('加入结果缺少聚会 ID')
        wx.setStorageSync(LAST_SHARED_PARTY_KEY, result.partyId)
        this.setData({ partyId: result.partyId, joining: false })
        return this.refreshSnapshot(true).then(() => this.startPolling())
      })
      .catch(error => {
        this.setData({ joining: false, loading: false, errorMessage: readableError(error) })
      })
  },

  refreshSnapshot(force = false): Promise<void> {
    const partyId = this.data.partyId
    if (!partyId || (this as any)._snapshotLoading) return Promise.resolve()
    if (!(this as any)._membersResult) {
      return this.refreshMembership()
        .then(() => this.refreshSnapshot(force))
        .catch(error => this.handleSharedLoadError(error, force))
    }
    ;(this as any)._snapshotLoading = true
    return getSharedParty(partyId, 40)
      .then(snapshot => {
        if (!(this as any)._partyViewVisible) return
        const previousDigest = String((this as any)._contentDigest || '')
        if (!force && previousDigest && previousDigest === snapshot.contentDigest) return
        ;(this as any)._contentDigest = snapshot.contentDigest
        ;(this as any)._snapshotUpdatedAt = snapshot.updatedAt || Date.now()
        const rows = buildRows(snapshot)
        const operations = snapshot.operations.map(operation => ({
          id: operation.id,
          time: operation.time || '--:--',
          playerName: operation.playerName,
          deltaText: operation.consumedUnitsDelta > 0
            ? `-${operation.consumedUnitsDelta}${snapshot.settings.unit}（-${operation.amount}口）`
            : `${operation.action}${operation.amount}${operation.unit || '口'}`,
          kind: operation.action === '+' ? 'add' as const : 'sub' as const,
        }))
        this.setData({
          loading: false,
          errorMessage: '',
          hasParty: true,
          statusText: snapshot.status === 'ended' ? '已结束' : '进行中',
          durationText: formatElapsed(snapshot),
          unit: snapshot.settings.unit,
          unitToSip: snapshot.settings.unitToSip,
          rows,
          operations,
          updatedAgoText: this.getUpdatedAgoText(),
        })
        ;(this as any)._snapshot = snapshot
        this.startUpdatedAgoTimer()
      })
      .catch(error => {
        this.handleSharedLoadError(error, force)
      })
      .finally(() => {
        ;(this as any)._snapshotLoading = false
      })
  },

  handleSharedLoadError(error: unknown, force: boolean) {
    if (force || !this.data.hasParty) {
      this.setData({ loading: false, errorMessage: readableError(error) })
    }
  },

  refreshMembership(): Promise<void> {
    const partyId = this.data.partyId
    if (!partyId) return Promise.resolve()
    return listPartyMembers(partyId).then(result => {
      ;(this as any)._membersResult = result
    })
  },

  startPolling() {
    this.stopPolling()
    if (!this.data.partyId || !(this as any)._partyViewVisible) return
    ;(this as any)._pollTimer = setInterval(() => this.refreshSnapshot(false), POLL_INTERVAL_MS)
  },

  stopPolling() {
    if ((this as any)._pollTimer) clearInterval((this as any)._pollTimer)
    ;(this as any)._pollTimer = null
  },

  startUpdatedAgoTimer() {
    this.stopUpdatedAgoTimer()
    ;(this as any)._agoTimer = setInterval(() => {
      const updatedAgoText = this.getUpdatedAgoText()
      const snapshot = (this as any)._snapshot as SharedPartySnapshot | undefined
      const durationText = snapshot ? formatElapsed(snapshot) : this.data.durationText
      const updates: Record<string, string> = {}
      if (updatedAgoText !== this.data.updatedAgoText) updates.updatedAgoText = updatedAgoText
      if (durationText !== this.data.durationText) updates.durationText = durationText
      if (Object.keys(updates).length > 0) this.setData(updates)
    }, 1000)
  },

  stopUpdatedAgoTimer() {
    if ((this as any)._agoTimer) clearInterval((this as any)._agoTimer)
    ;(this as any)._agoTimer = null
  },

  getUpdatedAgoText(): string {
    const updatedAt = Number((this as any)._snapshotUpdatedAt || Date.now())
    const seconds = Math.max(Math.floor((Date.now() - updatedAt) / 1000), 0)
    if (seconds < 3) return '刚刚'
    if (seconds < 60) return `${seconds}秒前`
    return `${Math.floor(seconds / 60)}分钟前`
  },
})
