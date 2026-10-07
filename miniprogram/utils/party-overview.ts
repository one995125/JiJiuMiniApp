import { formatDuration } from './storage'

export const OVERVIEW_AVATAR_COLORS = [
  '#F5A623', '#E34D59', '#00A870', '#0052D9',
  '#ED7B2F', '#8B5CF6', '#06AED5', '#EC407A',
  '#4CAF50', '#FF5722', '#3F51B5', '#009688',
]

export type BadgeFlags = {
  badgeUnlucky: boolean
  badgeSea: boolean
  badgeDebt: boolean
  badgeLucky: boolean
  badgeOverspeed: boolean
}

export type BadgeId = 'debt' | 'unlucky' | 'sea' | 'lucky' | 'overspeed'

export type BadgeDefinition = {
  id: BadgeId
  name: string
  icon: string
  color: string
  priority: number
  flag: keyof BadgeFlags
}

/**
 * 酒局称号的唯一配置源。
 * NPC 只是总览兜底标签，不纳入这里，避免被“获得新称号”提醒误触发。
 */
export const BADGE_DEFINITIONS: BadgeDefinition[] = [
  {
    id: 'debt',
    name: '养鱼达人',
    icon: '鱼',
    color: '#D94A52',
    priority: 10,
    flag: 'badgeDebt',
  },
  {
    id: 'unlucky',
    name: '倒霉蛋',
    icon: '签',
    color: '#56657E',
    priority: 20,
    flag: 'badgeUnlucky',
  },
  {
    id: 'sea',
    name: '海量',
    icon: '量',
    color: '#12A876',
    priority: 30,
    flag: 'badgeSea',
  },
  {
    id: 'lucky',
    name: '幸运儿',
    icon: '星',
    color: '#E9921B',
    priority: 40,
    flag: 'badgeLucky',
  },
  {
    id: 'overspeed',
    name: '不求人',
    icon: '快',
    color: '#2F6FE4',
    priority: 50,
    flag: 'badgeOverspeed',
  },
]

export type PartyOverviewDisplayPlayer = BadgeFlags & {
  id: string
  name: string
  totalSips: number
  records: IPlayerRecord[]
  color: string
  unitAmount: string
  consumedUnits: number
  selected: boolean
  originalIndex: number
}

export type PartyOverviewRankGroup = {
  key: string
  drinks: number
  shuHeLine: string
  shuPart: string
  hePart: string
  qianPart: string
  players: Array<BadgeFlags & {
    id: string
    name: string
    totalSips: number
    consumedUnits: number
    color: string
    unitAmount: number
    badgeNpc: boolean
  }>
}

export type PartyOverviewRecordLine = {
  playerId: string
  playerName: string
  segments: Array<{ key: string; text: string; kind: 'add' | 'sub' }>
  badgeUnlucky?: boolean
  badgeSea?: boolean
  badgeDebt?: boolean
  badgeLucky?: boolean
  badgeOverspeed?: boolean
  recordLineKey?: string
}

export type PartyOverviewHero = {
  playerId: string
  name: string
  color: string
  photoPath: string
  debtUnits: string
}

export type PartyOverviewData = {
  displayPlayers: PartyOverviewDisplayPlayer[]
  rankingTierGroups: PartyOverviewRankGroup[]
  rankingRecordLines: PartyOverviewRecordLine[]
  durationText: string
  debtChampionHero: PartyOverviewHero | null
}

type BuildPartyOverviewOptions = {
  players: IPlayer[]
  settings: IPartySettings
  smartSort?: boolean
  selectedIds?: string[]
  includeRanking?: boolean
  startTime?: number
  elapsedMs?: number
  playerAvatarPhotos?: Record<string, string>
}

/** 剩余口数折算为计量单位展示文案（与界面「共」口径一致，仅数值）。 */
function formatDebtUnitsLabel(totalSips: number, unitToSip: number): string {
  const u = Math.max(unitToSip || 1, 1)
  const v = totalSips / u
  const t = v.toFixed(1)
  return t.endsWith('.0') ? `${Math.round(v)}` : t
}

/** 记酒折合单位数（与卡片「共」一致）。 */
function grossUnits(totalSips: number, consumedUnits: number, unitToSip: number): number {
  const u = Math.max(unitToSip || 1, 1)
  return (totalSips + consumedUnits * u) / u
}

/** 总览右侧：输=总记酒折合；喝=已减整单位数；欠=输-喝（未结清）。 */
function formatShuHeParts(
  totalSips: number,
  consumedUnits: number,
  unitToSip: number,
  unitLabel: string,
) {
  const g = grossUnits(totalSips, consumedUnits, unitToSip)
  const shuStr = Math.abs(g - Math.round(g)) < 1e-6
    ? `${Math.round(g)}`
    : `${parseFloat(g.toFixed(1))}`
  const heInt = consumedUnits || 0
  const qianVal = g - heInt
  const qianStr = Math.abs(qianVal - Math.round(qianVal)) < 1e-6
    ? `${Math.round(qianVal)}`
    : `${parseFloat(qianVal.toFixed(1))}`
  return {
    shuPart: `输${shuStr}${unitLabel}`,
    hePart: `喝${heInt}${unitLabel}`,
    qianPart: `欠${qianStr}${unitLabel}`,
    shuHeLine: `输${shuStr}${unitLabel} 喝${heInt}${unitLabel} 欠${qianStr}${unitLabel}`,
  }
}

/**
 * 构建实时记酒页和历史详情共用的总览数据。
 *
 * includeRanking 为 false 时只返回玩家卡片所需的 displayPlayers，避免高频点酒时重复计算总览列表。
 * elapsedMs 由历史页传入已结束时长；实时页未传时按 startTime 到当前时间计算。
 */
export function buildPartyOverview(options: BuildPartyOverviewOptions): PartyOverviewData {
  const players = Array.isArray(options.players) ? options.players : []
  const settings = options.settings
  const unitToSip = Math.max(settings.unitToSip || 1, 1)
  const selectedIds = options.selectedIds || []

  const grossById: Record<string, number> = {}
  const consumedById: Record<string, number> = {}
  players.forEach((p: IPlayer) => {
    const consumedUnits = p.consumedUnits || 0
    grossById[p.id] = p.totalSips + consumedUnits * unitToSip
    consumedById[p.id] = consumedUnits
  })

  const grossVals = players.map((p: IPlayer) => grossById[p.id])
  const consumedVals = players.map((p: IPlayer) => consumedById[p.id])
  const maxGross = grossVals.length ? Math.max(...grossVals) : 0
  const minGross = grossVals.length ? Math.min(...grossVals) : 0
  const maxConsumed = consumedVals.length ? Math.max(...consumedVals) : 0
  /** 海量：全场「-1单位」次数最高者；全场最高不足 5 次时不显示；并列最高则多人同获。 */
  const seaBadgeMinConsumed = 5
  const sipVals = players.map((p: IPlayer) => p.totalSips)
  const maxTotalSips = sipVals.length ? Math.max(...sipVals) : 0
  /** 至少两人且每人累计记酒（与「共」一致）均大于 0。 */
  const allHaveWine =
    players.length >= 2 && players.every((p: IPlayer) => grossById[p.id] > 0)

  const badgeUnluckyById: Record<string, boolean> = {}
  const badgeSeaById: Record<string, boolean> = {}
  const badgeDebtById: Record<string, boolean> = {}
  const badgeLuckyById: Record<string, boolean> = {}
  const badgeOverspeedById: Record<string, boolean> = {}
  players.forEach((p: IPlayer) => {
    const g = grossById[p.id]
    const c = consumedById[p.id]
    badgeUnluckyById[p.id] = maxGross > 0 && g === maxGross
    badgeSeaById[p.id] = maxConsumed >= seaBadgeMinConsumed && c === maxConsumed
    badgeDebtById[p.id] = maxTotalSips > 0 && p.totalSips === maxTotalSips
    badgeLuckyById[p.id] = allHaveWine && g === minGross
    badgeOverspeedById[p.id] = p.totalSips < 0
  })

  let displayPlayers = players.map((p: IPlayer, idx: number) => ({
    id: p.id,
    name: p.name,
    totalSips: p.totalSips,
    records: Array.isArray(p.records) ? p.records : [],
    color: OVERVIEW_AVATAR_COLORS[idx % OVERVIEW_AVATAR_COLORS.length],
    unitAmount: grossUnits(p.totalSips, p.consumedUnits || 0, unitToSip).toFixed(1),
    consumedUnits: p.consumedUnits || 0,
    selected: selectedIds.includes(p.id),
    originalIndex: idx,
    badgeUnlucky: badgeUnluckyById[p.id],
    badgeSea: badgeSeaById[p.id],
    badgeDebt: badgeDebtById[p.id],
    badgeLucky: badgeLuckyById[p.id],
    badgeOverspeed: badgeOverspeedById[p.id],
  }))

  if (options.smartSort) {
    displayPlayers = displayPlayers.sort((a, b) => b.totalSips - a.totalSips)
  }

  if (!options.includeRanking) {
    return {
      displayPlayers,
      rankingTierGroups: [],
      rankingRecordLines: [],
      durationText: '0分钟',
      debtChampionHero: null,
    }
  }

  const ranked = players
    .map((p: IPlayer, idx: number) => {
      const cups = grossUnits(p.totalSips, p.consumedUnits || 0, unitToSip)
      const bu = !!badgeUnluckyById[p.id]
      const bs = !!badgeSeaById[p.id]
      const bd = !!badgeDebtById[p.id]
      const bl = !!badgeLuckyById[p.id]
      const bo = !!badgeOverspeedById[p.id]
      return {
        id: p.id,
        name: p.name,
        totalSips: p.totalSips,
        consumedUnits: p.consumedUnits || 0,
        color: OVERVIEW_AVATAR_COLORS[idx % OVERVIEW_AVATAR_COLORS.length],
        /* 总览：喝酒杯数为整数（整杯计数 + 当前欠酒折整杯）。 */
        unitAmount: Math.round(cups),
        badgeUnlucky: bu,
        badgeSea: bs,
        badgeDebt: bd,
        badgeLucky: bl,
        badgeOverspeed: bo,
        /** 总览列表：无任何称号时展示 NPC。 */
        badgeNpc: !bu && !bs && !bd && !bl && !bo,
      }
    })
    .sort((a, b) => {
      const ga = grossUnits(a.totalSips, a.consumedUnits, unitToSip)
      const gb = grossUnits(b.totalSips, b.consumedUnits, unitToSip)
      if (gb !== ga) return gb - ga
      return b.totalSips - a.totalSips
    })

  const rankingTierGroups = ranked.map((p, i) => {
    const parts = formatShuHeParts(p.totalSips, p.consumedUnits, unitToSip, settings.unit)
    return {
      key: `row-${p.id}-${i}`,
      drinks: p.consumedUnits,
      shuHeLine: parts.shuHeLine,
      shuPart: parts.shuPart,
      hePart: parts.hePart,
      qianPart: parts.qianPart,
      players: [p],
    }
  })

  const rankingRecordLines = ranked.map((rp) => {
    const player = players.find((item: IPlayer) => item.id === rp.id)
    const records = player && Array.isArray(player.records) ? player.records : []
    const segments = records.map((rec: IPlayerRecord) => ({
      key: rec.id,
      text: `${rec.action}${rec.amount}`,
      kind: (rec.action === '+' ? 'add' : 'sub') as 'add' | 'sub',
    }))
    const bu = !!badgeUnluckyById[rp.id]
    const bs = !!badgeSeaById[rp.id]
    const bd = !!badgeDebtById[rp.id]
    const bl = !!badgeLuckyById[rp.id]
    const bo = !!badgeOverspeedById[rp.id]
    return {
      playerId: rp.id,
      playerName: rp.name,
      segments,
      badgeUnlucky: bu,
      badgeSea: bs,
      badgeDebt: bd,
      badgeLucky: bl,
      badgeOverspeed: bo,
      recordLineKey: `${rp.id}-${bu ? 1 : 0}${bs ? 1 : 0}${bd ? 1 : 0}${bl ? 1 : 0}${bo ? 1 : 0}`,
    }
  })

  const elapsed = Number.isFinite(Number(options.elapsedMs))
    ? Math.max(Number(options.elapsedMs), 0)
    : Math.max(Date.now() - Number(options.startTime || Date.now()), 0)

  /**
   * 养鱼达人：剩余口数最多者；并列或全场为 0 时，取名单顺序第一位的人，
   * 这样总览图最顶部「养鱼达人 + 头像 + 欠N{unit}」始终都有内容，方便截图分享。
   */
  let debtChampionHero: PartyOverviewHero | null = null
  const champion = maxTotalSips > 0
    ? players.find((p: IPlayer) => p.totalSips === maxTotalSips)
    : players[0]
  if (champion) {
    const playerIndex = players.findIndex((p: IPlayer) => p.id === champion.id)
    const photos = options.playerAvatarPhotos || {}
    debtChampionHero = {
      playerId: champion.id,
      name: champion.name,
      color: OVERVIEW_AVATAR_COLORS[Math.max(playerIndex, 0) % OVERVIEW_AVATAR_COLORS.length],
      photoPath: photos[champion.id] || '',
      debtUnits: formatDebtUnitsLabel(champion.totalSips, unitToSip),
    }
  }

  return {
    displayPlayers,
    rankingTierGroups,
    rankingRecordLines,
    durationText: formatDuration(elapsed),
    debtChampionHero,
  }
}
