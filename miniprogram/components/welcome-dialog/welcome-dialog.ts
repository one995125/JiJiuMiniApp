Component({
  options: {
    styleIsolation: 'apply-shared',
  },

  properties: {
    visible: {
      type: Boolean,
      value: false,
    },
    darkMode: {
      type: Boolean,
      value: false,
    },
  },

  data: {
    medalGuideVisible: false,
  },

  methods: {
    /** 主按钮：完成三步说明；确认后本机不再自动展示首启引导。 */
    onConfirm() {
      this.triggerEvent('confirm')
    },

    onSkip() {
      this.triggerEvent('skip')
    },

    onShowMedalGuide() {
      this.setData({ medalGuideVisible: true })
    },

    onCloseMedalGuide() {
      this.setData({ medalGuideVisible: false })
    },

    noop() {},
  },
})
