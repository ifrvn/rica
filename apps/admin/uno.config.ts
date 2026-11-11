import { defineConfig } from 'unocss'
import presetAttributify from '@unocss/preset-attributify'
import presetIcons from '@unocss/preset-icons'
import presetWind4 from '@unocss/preset-wind4'

export default defineConfig({
  presets: [presetWind4(), presetAttributify(), presetIcons()],
})
