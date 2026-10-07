import {
  CloudHealthReport,
  CloudHealthStatus,
  CloudHealthStep,
  runCloudHealthCheck,
} from '../../services/cloud-health'
import { loadDarkMode } from '../../utils/storage'
import { deferStatusBarHeightUpdate } from '../../utils/system'

type TagTheme = 'default' | 'primary' | 'success' | 'warning' | 'danger'

type DisplayStep = CloudHealthStep & {
  icon: string
  color: string
  statusText: string
  tagTheme: TagTheme
}

type ReportTone = {
  icon: string
  color: string
  statusText: string
  tagTheme: TagTheme
}

const EMPTY_REPORT: CloudHealthReport = {
  status: 'checking',
  summary: '尚未开始自检',
  checkedAt: '',
  envLabel: '待检测',
  steps: [],
}

function getStatusTone(status: CloudHealthStatus): ReportTone {
  if (status === 'pass') {
    return { icon: 'check-circle', color: '#00A870', statusText: '通过', tagTheme: 'success' }
  }
  if (status === 'warn') {
    return { icon: 'error-circle', color: '#D98D00', statusText: '提醒', tagTheme: 'warning' }
  }
  if (status === 'fail') {
    return { icon: 'close-circle', color: '#D94A52', statusText: '失败', tagTheme: 'danger' }
  }
  return { icon: 'loading', color: '#E9921B', statusText: '检测中', tagTheme: 'primary' }
}

function decorateStep(step: CloudHealthStep): DisplayStep {
  const tone = getStatusTone(step.status)
  return {
    ...step,
    icon: tone.icon,
    color: tone.color,
    statusText: tone.statusText,
    tagTheme: tone.tagTheme,
  }
}

function formatNow(): string {
  const date = new Date()
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hh = date.getHours().toString().padStart(2, '0')
  const mm = date.getMinutes().toString().padStart(2, '0')
  const ss = date.getSeconds().toString().padStart(2, '0')
  return `${month}月${day}日 ${hh}:${mm}:${ss}`
}

function buildUnexpectedFailureReport(error: unknown): CloudHealthReport {
  const detail = error instanceof Error ? error.message : String(error || '未知错误')
  return {
    status: 'fail',
    summary: '自检页面运行失败',
    checkedAt: formatNow(),
    envLabel: '页面异常',
    steps: [
      {
        key: 'runtime',
        title: '自检页面',
        status: 'fail',
        message: '页面执行自检时发生异常',
        advice: '打开微信开发者工具 Console 查看页面堆栈；如果是编译后第一次运行，请先重新编译小程序。',
        detail,
      },
    ],
  }
}

function buildClipboardText(report: CloudHealthReport): string {
  const lines = [
    `云开发自检：${report.summary}`,
    `检测时间：${report.checkedAt || '未记录'}`,
    `环境：${report.envLabel}`,
    '',
  ]
  report.steps.forEach((step: CloudHealthStep, index: number) => {
    lines.push(`${index + 1}. ${step.title}：[${step.status}] ${step.message}`)
    if (step.advice) lines.push(`   建议：${step.advice}`)
    if (step.detail) lines.push(`   详情：${step.detail}`)
  })
  return lines.join('\n')
}

Component({
  data: {
    statusBarHeight: 20,
    darkMode: false,
    checking: false,
    report: EMPTY_REPORT,
    steps: [] as DisplayStep[],
    summaryIcon: 'loading',
    summaryColor: '#E9921B',
    summaryStatusText: '未开始',
    summaryTagTheme: 'default' as TagTheme,
  },

  lifetimes: {
    attached() {
      deferStatusBarHeightUpdate(this, 20)
      this.setData({ darkMode: loadDarkMode() })
      this.runCheck()
    },
  },

  pageLifetimes: {
    show() {
      this.setData({ darkMode: loadDarkMode() })
      wx.setNavigationBarTitle({ title: '云开发自检' })
    },
  },

  methods: {
    /**
     * 执行云开发自检。
     *
     * 调用时机：页面首次进入和用户点击「重新自检」时。自检会强制刷新登录，
     * 并通过云函数写入/清理临时记录，因此不要在普通业务页面自动调用。
     */
    runCheck() {
      if (this.data.checking) return
      const checkingTone = getStatusTone('checking')
      this.setData({
        checking: true,
        report: {
          ...EMPTY_REPORT,
          summary: '正在检查共享 CloudBase',
          checkedAt: formatNow(),
        },
        steps: [],
        summaryIcon: checkingTone.icon,
        summaryColor: checkingTone.color,
        summaryStatusText: checkingTone.statusText,
        summaryTagTheme: checkingTone.tagTheme,
      })

      runCloudHealthCheck()
        .then((report: CloudHealthReport) => {
          this.applyReport(report)
        })
        .catch(err => {
          this.applyReport(buildUnexpectedFailureReport(err))
        })
        .finally(() => {
          this.setData({ checking: false })
        })
    },

    applyReport(report: CloudHealthReport) {
      const tone = getStatusTone(report.status)
      this.setData({
        report,
        steps: report.steps.map((step: CloudHealthStep) => decorateStep(step)),
        summaryIcon: tone.icon,
        summaryColor: tone.color,
        summaryStatusText: tone.statusText,
        summaryTagTheme: tone.tagTheme,
      })
    },

    onBack() {
      wx.navigateBack({
        fail: () => wx.redirectTo({ url: '../index/index' }),
      })
    },

    onRefresh() {
      this.runCheck()
    },

    onCopyReport() {
      if (!this.data.report.steps.length) {
        wx.showToast({ title: '暂无自检报告', icon: 'none' })
        return
      }
      wx.setClipboardData({
        data: buildClipboardText(this.data.report),
        success: () => {
          wx.showToast({ title: '报告已复制', icon: 'success' })
        },
      })
    },
  },
})
