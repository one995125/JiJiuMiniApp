import {
  generateId,
  saveAppSettings,
  loadResumableParty,
  restorePartySetupFromParty,
  clearParty,
  savePartySetup,
  saveDarkMode,
  markOnboardingV1Seen,
  loadHomeStartupStorage,
  shouldShowOnboardingFromStorage,
  AppSettingsData,
  HomeStartupStorage,
  DEFAULT_PARTY_UNIT,
  DEFAULT_UNIT_TO_SIP,
  normalizePartyUnit,
} from '../../utils/storage'
import { deferMenuButtonSafeTopUpdate } from '../../utils/system'
import { SEO_COPY } from '../../utils/seo'
import {
  buildGrowthSharePath,
  buildGrowthTimelineQuery,
  trackGrowthEvent,
} from '../../services/growth-analytics'

const AVATAR_COLORS = [
  '#F5A623', '#E34D59', '#00A870', '#0052D9',
  '#ED7B2F', '#8B5CF6', '#06AED5', '#EC407A',
  '#4CAF50', '#FF5722', '#3F51B5', '#009688',
]

Component({
  data: {
    players: [] as Array<{ id: string; name: string; color: string }>,
    unit: DEFAULT_PARTY_UNIT as IPartySettings['unit'],
    unitToSip: DEFAULT_UNIT_TO_SIP,
    unitSet: true,
    showDialog: false,
    inputName: '',
    editIndex: -1,
    showSipEditor: false,
    sipDraft: '',
    darkMode: false,
    /** 首页首行从系统胶囊下方开始，防止反馈和主题按钮被遮挡。 */
    headerSafeTop: 104,
    /** 首启引导弹窗：新用户首次进入小程序时展示，老用户（已有人员或聚会记录）跳过。 */
    showWelcomeDialog: false,
  },

  lifetimes: {
    attached() {
      wx.showShareMenu({
        menus: ['shareAppMessage', 'shareTimeline'],
      })
      deferMenuButtonSafeTopUpdate(this, 104)
      this.refreshHomeState({ checkWelcome: true })
    },
  },

  pageLifetimes: {
    show() {
      if (!(this as any)._homeDidInitialShow) {
        ;(this as any)._homeDidInitialShow = true
      } else {
        this.refreshHomeState()
      }
      wx.setNavigationBarTitle({ title: SEO_COPY.homeNavTitle })
    },
  },

  methods: {
    /**
     * 首页启动态统一异步读取：一次拿到主题、人员设置、未结束聚会和引导状态。
     * 避免首屏渲染前多次调用同步 storage，也避免重复读取同一个 key。
     */
    refreshHomeState(options?: { checkWelcome?: boolean }) {
      if ((this as any)._homeStateLoading) return
      ;(this as any)._homeStateLoading = true
      loadHomeStartupStorage().then((storage: HomeStartupStorage) => {
        ;(this as any)._homeStateLoading = false
        ;(this as any)._homeStateLoaded = true
        const updates: Record<string, any> = {
          darkMode: storage.darkMode,
          ...this.getSettingsUpdates(storage.settings),
        }
        if (options?.checkWelcome && shouldShowOnboardingFromStorage(storage)) {
          updates.showWelcomeDialog = true
        }
        this.setData(updates)
      })
    },

    onWelcomeConfirm() {
      markOnboardingV1Seen()
      this.setData({ showWelcomeDialog: false })
    },

    onWelcomeSkip() {
      markOnboardingV1Seen()
      this.setData({ showWelcomeDialog: false })
    },

    getSettingsUpdates(settings: AppSettingsData | null): Record<string, any> {
      if (settings) {
        const savedPlayers = Array.isArray(settings.players) ? settings.players : []
        const players = savedPlayers.map((p: { id: string; name: string }, i: number) => ({
          ...p,
          color: AVATAR_COLORS[i % AVATAR_COLORS.length],
        }))
        return {
          players,
          unit: normalizePartyUnit(settings.unit),
          unitToSip: settings.unitToSip || DEFAULT_UNIT_TO_SIP,
          unitSet: true,
        }
      }
      return {
        players: [],
        unit: DEFAULT_PARTY_UNIT,
        unitToSip: DEFAULT_UNIT_TO_SIP,
        unitSet: true,
      }
    },

    persistSettings() {
      saveAppSettings({
        unit: this.data.unit,
        unitToSip: this.data.unitToSip,
        players: this.data.players.map(p => ({ id: p.id, name: p.name })),
      })
    },


    onShowAddDialog() {
      if (this.data.players.length >= 20) {
        wx.showToast({ title: '最多添加20人', icon: 'none' })
        return
      }
      this.setData({ showDialog: true, inputName: '', editIndex: -1 })
    },

    onEditPlayer(e: WechatMiniprogram.TouchEvent) {
      const index = e.currentTarget.dataset.index
      this.setData({
        showDialog: true,
        inputName: this.data.players[index].name,
        editIndex: index,
      })
    },

    onDeletePlayer(e: WechatMiniprogram.TouchEvent) {
      const index = e.currentTarget.dataset.index
      const name = this.data.players[index].name
      wx.showModal({
        title: '确认删除',
        content: `确定要删除「${name}」吗？`,
        confirmColor: '#E34D59',
        success: (res) => {
          if (res.confirm) {
            const players = this.data.players.filter((_: any, i: number) => i !== index)
            const updated = players.map((p: any, i: number) => ({
              ...p,
              color: AVATAR_COLORS[i % AVATAR_COLORS.length],
            }))
            this.setData({ players: updated })
            this.persistSettings()
            wx.showToast({ title: '已删除', icon: 'success' })
          }
        },
      })
    },

    onHideDialog() {
      this.setData({ showDialog: false, inputName: '' })
    },

    onInputName(e: WechatMiniprogram.Input) {
      this.setData({ inputName: e.detail.value })
    },

    onConfirmDialog() {
      const name = this.data.inputName.trim()
      if (!name) {
        wx.showToast({ title: '请输入姓名', icon: 'none' })
        return
      }
      if (name.length > 6) {
        wx.showToast({ title: '姓名最多6个字', icon: 'none' })
        return
      }

      const players = [...this.data.players]

      if (this.data.editIndex >= 0) {
        players[this.data.editIndex] = {
          ...players[this.data.editIndex],
          name,
        }
        this.setData({ players, showDialog: false, inputName: '' })
      } else {
        if (players.length >= 20) {
          wx.showToast({ title: '最多添加20人', icon: 'none' })
          return
        }
        players.push({
          id: generateId(),
          name,
          color: AVATAR_COLORS[players.length % AVATAR_COLORS.length],
        })
        this.setData({ players, showDialog: false, inputName: '' })
      }

      this.persistSettings()
      wx.showToast({
        title: this.data.editIndex >= 0 ? '已修改' : '已添加',
        icon: 'success',
      })
    },

    onSelectUnit(e: WechatMiniprogram.TouchEvent) {
      const unit = normalizePartyUnit(e.currentTarget.dataset.unit)
      const updates: Record<string, any> = { unit, unitSet: true }
      if (!this.data.unitToSip) {
        updates.unitToSip = DEFAULT_UNIT_TO_SIP
      }
      this.setData(updates)
      this.persistSettings()
    },

    /** 主页面不直接放原生 input，避免滚动到固定底栏下方时发生输入层穿透。 */
    onShowSipEditor() {
      if (!this.data.unitSet) {
        wx.showToast({ title: '请先选择单位', icon: 'none' })
        return
      }
      this.setData({
        showSipEditor: true,
        sipDraft: String(this.data.unitToSip || DEFAULT_UNIT_TO_SIP),
      })
    },

    onHideSipEditor() {
      this.setData({ showSipEditor: false, sipDraft: '' })
    },

    onSipDraftInput(e: WechatMiniprogram.Input) {
      this.setData({ sipDraft: e.detail.value })
    },

    onConfirmSipEditor() {
      let val = parseInt(this.data.sipDraft, 10)
      if (isNaN(val) || val < 1) val = 1
      if (val > 99) val = 99
      this.setData({
        unitToSip: val,
        unitSet: true,
        showSipEditor: false,
        sipDraft: '',
      })
      this.persistSettings()
    },

    /** 酒局记录入口：未结束继续、已结束查看总览都统一从这里进入。 */
    onOpenHistory() {
      wx.navigateTo({ url: '../history/history' })
    },

    /**
     * 隐藏诊断入口。
     *
     * 调用时机：长按首页标题区域。普通点击首页标题不会触发，避免干扰用户
     * 添加人员、设置单位和开始聚会的主流程。
     */
    onOpenCloudHealthCheck() {
      wx.navigateTo({ url: '../cloud-health/cloud-health' })
    },

    onStartParty() {
      if (this.data.players.length === 0) {
        wx.showToast({ title: '请至少添加1人', icon: 'none' })
        return
      }
      if (!this.data.unitSet) {
        wx.showToast({ title: '请下滑到设置区选择惩罚单位', icon: 'none' })
        return
      }

      const { players, unit, unitToSip } = this.data
      const saved = loadResumableParty()
      const sameRoster =
        !!saved &&
        saved.players.length === players.length &&
        saved.players.every((sp: IPlayer) => players.some(p => p.id === sp.id))

      /**
       * 已有未完成聚会，但和当前首页人员不一致：开新局会覆盖旧记录，
       * 必须二次确认，避免「我以为只是返回了一下，记录就没了」。
       */
      if (saved && !sameRoster) {
        wx.showModal({
          title: '上次聚会未结束',
          content: `检测到一场未结束的聚会（${saved.players.length}人）。开始新聚会会丢弃旧记录，是否继续？`,
          confirmText: '开新局',
          cancelText: '继续旧局',
          confirmColor: '#E34D59',
          success: (res) => {
            if (res.confirm) {
              clearParty()
              this._writeSetupAndGo(players, unit, unitToSip)
            } else {
              restorePartySetupFromParty(saved)
              wx.navigateTo({ url: '../record/record' })
            }
          },
        })
        return
      }

      this._writeSetupAndGo(players, unit, unitToSip)
    },

    _writeSetupAndGo(
      players: Array<{ id: string; name: string }>,
      unit: string,
      unitToSip: number,
    ) {
      savePartySetup({
        players: players.map(p => ({ id: p.id, name: p.name })),
        unit,
        unitToSip,
      })
      trackGrowthEvent('counter_started', {
        player_count: players.length,
        action_mode: 'home_start',
      })
      wx.navigateTo({ url: '../record/record' })
    },

    /** 切换日夜模式：仅写入本地设置，不影响酒局数据。 */
    onToggleDarkMode() {
      const nextDarkMode = !this.data.darkMode
      this.setData({ darkMode: nextDarkMode })
      saveDarkMode(nextDarkMode)
      wx.showToast({
        title: nextDarkMode ? '已切换夜间模式' : '已切换日间模式',
        icon: 'none',
      })
    },

    onShareAppMessage() {
      const n = this.data.players?.length || 0
      trackGrowthEvent('share_clicked', { share_target: 'friend', entry_page: 'home' })
      return {
        title: n > 0 ? SEO_COPY.activePartyShareTitle(n) : SEO_COPY.shareTitle,
        path: buildGrowthSharePath('/pages/index/index'),
        imageUrl: SEO_COPY.shareImage,
      }
    },

    onShareTimeline() {
      const n = this.data.players?.length || 0
      trackGrowthEvent('share_clicked', { share_target: 'timeline', entry_page: 'home' })
      return {
        title: n > 0 ? SEO_COPY.activePartyShareTitle(n) : SEO_COPY.timelineTitle,
        query: buildGrowthTimelineQuery(),
        imageUrl: SEO_COPY.shareImage,
      }
    },

    noop() {},
  },
})
