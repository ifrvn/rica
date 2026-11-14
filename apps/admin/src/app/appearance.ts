export const palettes = {
  sage: { label: '鼠尾草绿', light: ['#3f814a', '#397345'], dark: ['#315b3a', '#396746'], text: { light: '#355539', dark: '#c4e6bf' } },
  terracotta: { label: '陶土橙', light: ['#b34e34', '#a34832'], dark: ['#774438', '#885043'], text: { light: '#833923', dark: '#ffc3ae' } },
  iris: { label: '鸢尾紫', light: ['#7956af', '#6a4b9b'], dark: ['#5a427b', '#664b8a'], text: { light: '#553780', dark: '#e4d4ff' } },
  blue: { label: '雾蓝', light: ['#4a69ad', '#3d5b9e'], dark: ['#384e78', '#415b89'], text: { light: '#304e88', dark: '#c9dcff' } },
} as const

export const darkPrimaryButton = {
  sage: { fill: '#44754d', hover: '#487b52' },
  terracotta: { fill: '#945343', hover: '#9b5949' },
  iris: { fill: '#73569c', hover: '#7c5da6' },
  blue: { fill: '#4969a0', hover: '#5073ab' },
} as const

type Palette = keyof typeof palettes
type Mode = 'system' | 'light' | 'dark'
const key = 'rica.console.appearance'

export function readAppearance(): { palette: Palette; mode: Mode } {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (stored && Object.hasOwn(palettes, stored.palette)) {
      const mode = stored.mode === 'light' || stored.mode === 'dark' ? stored.mode : 'system'
      return { palette: stored.palette, mode }
    }
  } catch {
    // The browser may disallow storage or contain an invalid preference.
  }
  return { palette: 'sage', mode: 'system' }
}

export function saveAppearance(appearance: ReturnType<typeof readAppearance>) {
  try {
    localStorage.setItem(key, JSON.stringify(appearance))
  } catch {
    // The current session can still switch appearance.
  }
}
