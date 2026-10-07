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
    /**
     * 当前聚会的单位（杯/瓶/罐），用于"海量"称号文案中提示用户。
     * 不传时回退为"瓶"，仅影响展示。
     */
    settings: {
      type: Object,
      value: { unit: '瓶' },
    },
  },

  methods: {
    onClose() {
      this.triggerEvent('close')
    },

    onVisibleChange(e: WechatMiniprogram.CustomEvent) {
      if (!e.detail.visible) {
        this.triggerEvent('close')
      }
    },
  },
})
