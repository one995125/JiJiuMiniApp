import {
  deletePartyRecordFromCloud,
  discardActivePartyInCloud,
  listActivePartiesFromCloud,
  listEndedPartiesFromCloud,
  CloudPartyRecord,
} from '../../services/party-cloud'
import {
  clearParty,
  clearPendingEndedParty,
  formatDuration,
  loadDarkMode,
  loadParty,
  restorePartySetupFromParty,
  saveParty,
} from '../../utils/storage'
import { deferStatusBarHeightUpdate } from '../../utils/system'
import { buildPartyOverview, PartyOverviewData } from '../../utils/party-overview'
import { getPartyElapsedMs } from '../../utils/party-lifecycle'

const PAGE_SIZE = 10
const ACTIVE_PAGE_SIZE = 50
const HISTORY_AVATAR_LIMIT = 5
const AVATAR_COLORS = [
  '#F5A623', '#E34D59', '#00A870', '#0052D9',
  '#ED7B2F', '#8B5CF6', '#06AED5', '#EC407A',
  '#4CAF50', '#FF5722', '#3F51B5', '#009688',
]

type HistoryPartyStatus = 'active' | 'ended'

type HistoryAvatarItem = {
  key: string
  name: string
  color: string
  photoPath: string
}

type HistoryPartyItem = {
  partyId: string
  status: HistoryPartyStatus
  party: IPartyData
  playerCount: number
  recordCount: number
  durationMs: number
  durationText: string
  unit: string
  primaryTimeLabel: string
  timeHint: string
  summary: string
  avatarPlayers: HistoryAvatarItem[]
  avatarOverflow: boolean
}

const EMPTY_OVERVIEW: PartyOverviewData = {
  displayPlayers: [],
  rankingTierGroups: [],
  rankingRecordLines: [],
  durationText: '0分钟',
  debtChampionHero: null,
}

function toTimestamp(value: unknown): number {
  if (!value) return 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  if (value instanceof Date) return value.getTime()

  const raw = value as {
    getTime?: () => number
    $date?: unknown
    seconds?: number
    _seconds?: number
  }
  if (typeof raw.getTime === 'function') return raw.getTime()
  if (raw.$date) return toTimestamp(raw.$date)
  if (typeof raw.seconds === 'number') return raw.seconds * 1000
  if (typeof raw._seconds === 'number') return raw._seconds * 1000
  return 0
}

function formatDateTime(timestamp: number): string {
  if (!timestamp) return '时间未知'
  const d = new Date(timestamp)
  const year = d.getFullYear()
  const month = d.getMonth() + 1
  const date = d.getDate()
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const now = new Date()
  if (year === now.getFullYear()) {
    return `${month}月${date}日 ${hh}:${mm}`
  }
  return `${year}年${month}月${date}日 ${hh}:${mm}`
}

function countRecords(party: IPartyData): number {
  return (party.players || []).reduce(
    (sum: number, player: IPlayer) => sum + (Array.isArray(player.records) ? player.records.length : 0),
    0,
  )
}

function getRecordCount(record: CloudPartyRecord): number {
  const statsCount = Number(record.stats?.recordCount)
  return Number.isFinite(statsCount) && statsCount >= 0 ? statsCount : countRecords(record.party)
}

function getPlayerCount(record: CloudPartyRecord): number {
  const statsCount = Number(record.stats?.playerCount)
  const players = Array.isArray(record.party?.players) ? record.party.players : []
  return Number.isFinite(statsCount) && statsCount >= 0 ? statsCount : players.length
}

function getRecordVersion(record: CloudPartyRecord): number {
  return Math.max(
    toTimestamp(record.party?.updatedAt),
    toTimestamp(record.updatedAt),
    toTimestamp(record.party?.endedAt),
    toTimestamp(record.endedAt),
    toTimestamp(record.party?.createdAt),
  )
}

function buildLocalActiveRecord(party: IPartyData | null): CloudPartyRecord | null {
  if (!party || party.endedAt || !Array.isArray(party.players) || party.players.length === 0) return null

  const now = Date.now()
  return {
    partyId: party.partyId,
    status: 'active',
    party,
    updatedAt: party.updatedAt || party.createdAt,
    stats: {
      playerCount: party.players.length,
      recordCount: countRecords(party),
      unit: party.settings.unit,
      unitToSip: party.settings.unitToSip,
      durationMs: getPartyElapsedMs(party, now),
    },
  }
}

function shouldPreferRecord(candidate: CloudPartyRecord, existing: CloudPartyRecord): boolean {
  const candidateVersion = getRecordVersion(candidate)
  const existingVersion = getRecordVersion(existing)
  if (candidateVersion && existingVersion && candidateVersion !== existingVersion) {
    return candidateVersion > existingVersion
  }

  /**
   * 兜底比较记录数和人数：刚返回历史页时云端可能还没完成 upsert，
   * 本地会先拿到新增玩家/计数，必须避免旧云快照把本地新进度覆盖掉。
   */
  const candidateRecordCount = getRecordCount(candidate)
  const existingRecordCount = getRecordCount(existing)
  if (candidateRecordCount !== existingRecordCount) return candidateRecordCount > existingRecordCount

  return getPlayerCount(candidate) > getPlayerCount(existing)
}

function mergeActiveRecordsWithLocal(
  activeRecords: CloudPartyRecord[],
  localActiveParty: IPartyData | null,
): CloudPartyRecord[] {
  const localRecord = buildLocalActiveRecord(localActiveParty)
  if (!localRecord) return activeRecords

  const merged = activeRecords.slice()
  const sameIndex = merged.findIndex(record => (record.partyId || record.party?.partyId) === localRecord.partyId)
  if (sameIndex >= 0) {
    if (shouldPreferRecord(localRecord, merged[sameIndex])) {
      merged[sameIndex] = localRecord
    }
  } else {
    merged.unshift(localRecord)
  }

  return merged.sort((a, b) => getRecordVersion(b) - getRecordVersion(a))
}

function getPartyDuration(record: CloudPartyRecord, displayStatus: HistoryPartyStatus): number {
  const party = record.party
  if (displayStatus === 'active') {
    return getPartyElapsedMs(party)
  }

  const endedAt = toTimestamp(record.endedAt) || toTimestamp(record.updatedAt) || toTimestamp(party.endedAt)
  if (endedAt && (Number(party.pausedDurationMs || 0) > 0 || !!party.pausedAt)) {
    return getPartyElapsedMs(party, endedAt)
  }
  const statsDuration = Number(record.stats?.durationMs)
  if (Number.isFinite(statsDuration) && statsDuration >= 0) return statsDuration

  const startAt = Number(party.startTime || Date.parse(party.createdAt) || 0)
  if (!startAt || !endedAt) return 0
  return Math.max(endedAt - startAt, 0)
}

function buildAvatarPlayers(party: IPartyData): HistoryAvatarItem[] {
  const players = Array.isArray(party.players) ? party.players : []
  const photos = party.playerAvatarPhotos || {}
  return players.slice(0, HISTORY_AVATAR_LIMIT).map((player: IPlayer, index: number) => ({
    key: String(player.id || `player-${index}`),
    name: player.name || '?',
    color: AVATAR_COLORS[index % AVATAR_COLORS.length],
    photoPath: photos[player.id] || '',
  }))
}

function normalizeHistoryRecord(record: CloudPartyRecord): HistoryPartyItem | null {
  const party = record.party
  if (!party || !Array.isArray(party.players) || party.players.length === 0) return null

  const partyId = record.partyId || party.partyId
  const status: HistoryPartyStatus = record.status === 'active' ? 'active' : 'ended'
  const stats = record.stats
  const playerCount = Number(stats?.playerCount) || party.players.length
  const recordCount = Number(stats?.recordCount) || countRecords(party)
  const unit = stats?.unit || party.settings.unit
  const durationMs = getPartyDuration(record, status)
  const startAt = Number(party.startTime || Date.parse(party.createdAt) || 0)
  const durationText = formatDuration(durationMs)
  const primaryTimeLabel = formatDateTime(startAt)

  return {
    partyId,
    status,
    party,
    playerCount,
    recordCount,
    durationMs,
    durationText,
    unit,
    primaryTimeLabel,
    timeHint: '开始时间',
    summary: `${playerCount}人 · ${recordCount}条记录 · ${durationText}`,
    avatarPlayers: buildAvatarPlayers(party),
    avatarOverflow: party.players.length > HISTORY_AVATAR_LIMIT,
  }
}

function buildResumableParty(party: IPartyData): IPartyData {
  const resumedParty: IPartyData = { ...party }
  delete resumedParty.endedAt
  delete resumedParty.updatedAt
  return resumedParty
}

function resolveResumableParty(selected: HistoryPartyItem): IPartyData {
  const localActiveRecord = buildLocalActiveRecord(loadParty())
  const selectedRecord = buildLocalActiveRecord(selected.party)
  if (
    localActiveRecord &&
    selectedRecord &&
    localActiveRecord.partyId === selectedRecord.partyId &&
    shouldPreferRecord(localActiveRecord, selectedRecord)
  ) {
    return localActiveRecord.party
  }
  return selected.party
}

function uniqueHistoryItems(items: HistoryPartyItem[]): HistoryPartyItem[] {
  const seen: Record<string, boolean> = {}
  return items.filter(item => {
    if (seen[item.partyId]) return false
    seen[item.partyId] = true
    return true
  })
}

function isDeleteRecordUnsupportedError(err: unknown): boolean {
  const message = String((err as { message?: string })?.message || err || '')
  return message.includes('UNKNOWN_ACTION') || message.includes('未知的酒局记录操作')
}

Component({
  data: {
    statusBarHeight: 20,
    darkMode: false,
    records: [] as HistoryPartyItem[],
    activeCount: 0,
    endedCount: 0,
    endedCursor: '',
    hasMore: true,
    loading: false,
    loadingMore: false,
    refreshing: false,
    deletingPartyId: '',
    errorText: '',
    detailVisible: false,
    selectedRecord: null as HistoryPartyItem | null,
    selectedOverview: EMPTY_OVERVIEW,
    showMedalGuide: false,
  },

  lifetimes: {
    attached() {
      deferStatusBarHeightUpdate(this, 20)
      this.setData({ darkMode: loadDarkMode() })
      this.loadHistory({ reset: true })
      ;(this as any)._historyHasShown = false
    },

    detached() {
      ;(this as any)._historyVisible = false
      this.clearShowRefreshTimer()
    },
  },

  pageLifetimes: {
    show() {
      ;(this as any)._historyVisible = true
      this.setData({ darkMode: loadDarkMode() })
      wx.setNavigationBarTitle({ title: '酒局记录' })
      if ((this as any)._historyHasShown) {
        this.refreshHistoryAfterShow()
        return
      }
      ;(this as any)._historyHasShown = true
    },

    hide() {
      ;(this as any)._historyVisible = false
      this.clearShowRefreshTimer()
    },
  },

  methods: {
    clearShowRefreshTimer() {
      if ((this as any)._historyShowRefreshTimer) {
        clearTimeout((this as any)._historyShowRefreshTimer)
        ;(this as any)._historyShowRefreshTimer = null
      }
    },

    /**
     * 从记录页返回或从后台回到历史页时自动刷新。
     * 第二次延迟刷新用于兜底云函数 finish/upsert 落库稍晚的场景，避免用户不下拉刷新就看不到最新记录。
     */
    refreshHistoryAfterShow() {
      this.clearShowRefreshTimer()
      this.loadHistory({ reset: true }).finally(() => {
        if (!(this as any)._historyVisible) return
        this.clearShowRefreshTimer()
        ;(this as any)._historyShowRefreshTimer = setTimeout(() => {
          ;(this as any)._historyShowRefreshTimer = null
          this.loadHistory({ reset: true })
        }, 800)
      })
    },

    /**
     * 酒局记录分页加载。
     *
     * 未结束酒局每次取最新 50 条并置顶；已结束酒局使用云端 nextCursor
     * 继续读取下一页，不再通过递增 limit 重复拉取前面的历史记录。
     */
    loadHistory(options?: { reset?: boolean }): Promise<void> {
      if (this.data.loading || this.data.loadingMore) return Promise.resolve()
      const reset = !!options?.reset
      if (!reset && !this.data.hasMore) return Promise.resolve()

      const cursor = reset ? '' : this.data.endedCursor
      this.setData(reset
        ? {
            loading: true,
            errorText: '',
            endedCursor: '',
            hasMore: true,
          }
        : {
            loadingMore: true,
            errorText: '',
          })

      return Promise.all([
        listActivePartiesFromCloud(ACTIVE_PAGE_SIZE),
        listEndedPartiesFromCloud({ limit: PAGE_SIZE, cursor }),
      ])
        .then(([activeRecords, endedPage]) => {
          const localActiveParty = loadParty()
          const mergedActiveRecords = mergeActiveRecordsWithLocal(activeRecords, localActiveParty)
          const activeItems = mergedActiveRecords
            .map((record: CloudPartyRecord) => normalizeHistoryRecord(record))
            .filter((item: HistoryPartyItem | null): item is HistoryPartyItem => !!item)
          const endedItems = endedPage.records
            .map((record: CloudPartyRecord) => normalizeHistoryRecord(record))
            .filter((item: HistoryPartyItem | null): item is HistoryPartyItem => !!item)
          const displayActiveItems = activeItems.filter(item => item.status === 'active')
          const activeIds = displayActiveItems.reduce((map: Record<string, boolean>, item) => {
            map[item.partyId] = true
            return map
          }, {})
          const loadedEndedItems = reset
            ? []
            : this.data.records.filter((item: HistoryPartyItem) => item.status === 'ended')
          const displayEndedItems = uniqueHistoryItems([
            ...activeItems.filter(item => item.status === 'ended'),
            ...loadedEndedItems,
            ...endedItems,
          ]).filter(item => !activeIds[item.partyId])
          this.setData({
            records: [...displayActiveItems, ...displayEndedItems],
            activeCount: displayActiveItems.length,
            endedCount: displayEndedItems.length,
            endedCursor: endedPage.nextCursor,
            hasMore: endedPage.hasMore,
            loading: false,
            loadingMore: false,
            refreshing: false,
          })
        })
        .catch(err => {
          console.error('[history records] failed', err)
          this.setData({
            loading: false,
            loadingMore: false,
            refreshing: false,
            errorText: '酒局记录加载失败，请稍后重试',
          })
        })
    },

    onBack() {
      wx.navigateBack({
        fail: () => wx.redirectTo({ url: '../index/index' }),
      })
    },

    onRefresh() {
      this.loadHistory({ reset: true })
    },

    onPullRefresh() {
      this.setData({ refreshing: true })
      this.loadHistory({ reset: true })
    },

    onReachBottom() {
      this.loadHistory()
    },

    onLoadMore() {
      this.loadHistory()
    },

    /**
     * 长按历史卡片删除云端记录。
     *
     * 调用时机：用户在历史列表长按某张酒局卡片。删除动作必须二次确认；
     * 云端按 openid/appid 校验归属，本地只在云端删除成功后更新列表，避免误导用户。
     */
    onDeleteRecord(e: WechatMiniprogram.TouchEvent) {
      const partyId = String(e.currentTarget.dataset.partyId || '')
      const selected = this.data.records.find((item: HistoryPartyItem) => item.partyId === partyId)
      if (!selected || this.data.deletingPartyId) return

      ;(this as any)._historySuppressTapPartyId = partyId
      setTimeout(() => {
        if ((this as any)._historySuppressTapPartyId === partyId) {
          ;(this as any)._historySuppressTapPartyId = ''
        }
      }, 500)

      wx.showModal({
        title: '删除酒局记录',
        content: selected.status === 'active'
          ? '这场未结束酒局会从云端历史和本地继续记录中删除，删除后不可恢复。'
          : '这条已结束酒局会从云端历史中删除，删除后不可恢复。',
        confirmText: '删除',
        confirmColor: '#E34D59',
        cancelText: '取消',
        success: res => {
          if (!res.confirm) return
          this.deleteHistoryRecord(selected)
        },
      })
    },

    deleteHistoryRecord(selected: HistoryPartyItem): Promise<void> {
      this.setData({ deletingPartyId: selected.partyId })
      wx.showLoading({ title: '正在删除', mask: true })

      const deleteTask = deletePartyRecordFromCloud(selected.partyId)
        .catch(err => {
          if (selected.status === 'active' && isDeleteRecordUnsupportedError(err)) {
            /**
             * 兼容尚未部署 deleteRecord 的旧云函数：
             * 旧版本已经支持 discardActive，未结束酒局可以回退删除。
             * 已结束酒局必须部署新版云函数后才能删除。
             */
            return discardActivePartyInCloud(selected.partyId)
          }
          throw err
        })

      return deleteTask
        .then(() => {
          const localParty = loadParty()
          if (localParty?.partyId === selected.partyId) {
            clearParty()
          }
          clearPendingEndedParty(selected.partyId)

          const records = this.data.records.filter((item: HistoryPartyItem) => item.partyId !== selected.partyId)
          const activeCount = records.filter((item: HistoryPartyItem) => item.status === 'active').length
          const endedCount = records.filter((item: HistoryPartyItem) => item.status === 'ended').length
          const updates: Record<string, any> = {
            records,
            activeCount,
            endedCount,
            deletingPartyId: '',
          }
          if (this.data.selectedRecord?.partyId === selected.partyId) {
            updates.detailVisible = false
            updates.selectedRecord = null
            updates.selectedOverview = EMPTY_OVERVIEW
            updates.showMedalGuide = false
          }
          this.setData(updates)
          wx.hideLoading()
          wx.showToast({ title: '已删除', icon: 'success' })
        })
        .catch(err => {
          console.warn('[history delete] failed', err)
          this.setData({ deletingPartyId: '' })
          wx.hideLoading()
          if (isDeleteRecordUnsupportedError(err)) {
            wx.showModal({
              title: '需要重新部署云函数',
              content: '当前云端 jijiuPartyRecord 还是旧版本，不支持删除已结束酒局。请在微信开发者工具中重新上传并部署该云函数后再试。',
              showCancel: false,
              confirmText: '知道了',
            })
            return
          }
          wx.showToast({ title: '删除失败，请稍后重试', icon: 'none' })
        })
    },

    onResumeParty(e: WechatMiniprogram.TouchEvent) {
      const partyId = String(e.currentTarget.dataset.partyId || '')
      const selected = this.data.records.find((item: HistoryPartyItem) => item.partyId === partyId)
      if (!selected) {
        wx.showToast({ title: '酒局记录不存在', icon: 'none' })
        return
      }

      const resumedParty = buildResumableParty(resolveResumableParty(selected))
      saveParty(resumedParty)
      restorePartySetupFromParty(resumedParty)
      wx.navigateTo({ url: '../record/record' })
    },

    onOpenDetail(e: WechatMiniprogram.TouchEvent) {
      const partyId = String(e.currentTarget.dataset.partyId || '')
      if ((this as any)._historySuppressTapPartyId === partyId) return
      const selected = this.data.records.find((item: HistoryPartyItem) => item.partyId === partyId)
      if (!selected) {
        wx.showToast({ title: '记录不存在', icon: 'none' })
        return
      }

      const overview = buildPartyOverview({
        players: selected.party.players,
        settings: selected.party.settings,
        includeRanking: true,
        startTime: selected.party.startTime,
        elapsedMs: selected.durationMs,
        playerAvatarPhotos: selected.party.playerAvatarPhotos || {},
      })
      this.setData({
        selectedRecord: selected,
        selectedOverview: overview,
        detailVisible: true,
      })
    },

    onCloseDetail() {
      this.setData({
        detailVisible: false,
        showMedalGuide: false,
      })
    },

    onDetailVisibleChange(e: WechatMiniprogram.CustomEvent) {
      if (!e.detail.visible) this.onCloseDetail()
    },

    onShowMedalGuide() {
      this.setData({ showMedalGuide: true })
    },

    onHideMedalGuide() {
      this.setData({ showMedalGuide: false })
    },

    noop() {},
  },
})
