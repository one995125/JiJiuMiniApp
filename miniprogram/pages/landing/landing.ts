import { deferStatusBarHeightUpdate } from '../../utils/system'
import { SEO_COPY } from '../../utils/seo'
import { loadDarkMode, saveDarkMode } from '../../utils/storage'
import {
  buildGrowthSharePath,
  buildGrowthTimelineQuery,
  trackGrowthEvent,
} from '../../services/growth-analytics'

Component({
  data: {
    darkMode: false,
    statusBarHeight: 44,
  },

  lifetimes: {
    /**
     * 搜索介绍页启动时机：
     * 1. 从微信搜索进入时，展示可索引的产品介绍；
     * 2. 从分享进入时，承接用户理解成本；
     * 3. 用户点击主按钮后再进入首页开始添加人员。
     */
    attached() {
      this.setData({ darkMode: loadDarkMode() })
      wx.setNavigationBarTitle({ title: SEO_COPY.landingNavTitle })
      deferStatusBarHeightUpdate(this, 44)
    },
  },

  methods: {
    /** 切换日夜模式，并与首页、记酒页、历史页共用同一个本地开关。 */
    onToggleDarkMode() {
      const nextDarkMode = !this.data.darkMode
      this.setData({ darkMode: nextDarkMode })
      saveDarkMode(nextDarkMode)
      wx.showToast({
        title: nextDarkMode ? '已切换夜间模式' : '已切换日间模式',
        icon: 'none',
      })
    },

    /** 进入首页开始设置聚会，使用 redirectTo 避免搜索落地页停留在返回栈中。 */
    onStartTap() {
      wx.redirectTo({ url: '../index/index?from=seo_landing' })
    },

    /** 返回首页，给已经熟悉小程序的用户一个轻路径。 */
    onHomeTap() {
      wx.redirectTo({ url: '../index/index?from=landing_home' })
    },

    onShareAppMessage() {
      trackGrowthEvent('share_clicked', { share_target: 'friend', entry_page: 'landing' })
      return {
        title: SEO_COPY.landingShareTitle,
        path: buildGrowthSharePath('/pages/landing/landing'),
        imageUrl: SEO_COPY.shareImage,
      }
    },

    onShareTimeline() {
      trackGrowthEvent('share_clicked', { share_target: 'timeline', entry_page: 'landing' })
      return {
        title: SEO_COPY.landingTimelineTitle,
        query: buildGrowthTimelineQuery(),
        imageUrl: SEO_COPY.shareImage,
      }
    },
  },
})
