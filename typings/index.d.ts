/// <reference path="./types/index.d.ts" />

interface IPlayerRecord {
  /** 单条记录稳定 ID，用于个人记录撤回和撤销栈关联。 */
  id: string
  time: string
  action: '+' | '-'
  amount: number
  unit: string
  /** 本次操作对玩家当前口数产生的有符号变化。 */
  sipDelta: number
  /** 本次操作对已喝整单位数产生的变化，普通加减口数为 0。 */
  consumedUnitsDelta: number
}

interface IPlayer {
  id: string
  name: string
  totalSips: number
  consumedUnits: number
  records: IPlayerRecord[]
}

interface IPartySettings {
  unit: '杯' | '瓶' | '罐'
  unitToSip: number
}

interface IPartyData {
  partyId: string
  createdAt: string
  updatedAt?: string
  endedAt?: string
  settings: IPartySettings
  players: IPlayer[]
  startTime?: number
  /** 玩家自定义头像本地路径（wxfile://），用于总览养鱼达人等 */
  playerAvatarPhotos?: Record<string, string>
}

interface IAppOption {
  globalData: {
    partyData?: IPartyData
    cloudLogin?: {
      loggedIn: boolean
      openid: string
      loginAt: number
    }
    /** 小程序退后台时正在把当前酒局封存为已结束，记录页延迟云保存应跳过。 */
    partyEndingByLifecycle?: boolean
  }
}
