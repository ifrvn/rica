export const palettes = {
  sage: { label: '鼠尾草绿', light: ['#3f814a', '#397345'], dark: ['#315b3a', '#396746'] },
  terracotta: { label: '陶土橙', light: ['#b34e34', '#a34832'], dark: ['#774438', '#885043'] },
  iris: { label: '鸢尾紫', light: ['#7956af', '#6a4b9b'], dark: ['#5a427b', '#664b8a'] },
} as const

type Palette = keyof typeof palettes
type Mode = 'light' | 'dark'
const key = 'rica.console.appearance'

export function readAppearance(): { palette: Palette; mode: Mode } {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (stored && Object.hasOwn(palettes, stored.palette)) {
      return { palette: stored.palette, mode: stored.mode === 'dark' ? 'dark' : 'light' }
    }
  } catch {
    // The browser may disallow storage or contain an invalid preference.
  }
  return { palette: 'sage', mode: 'light' }
}

export function saveAppearance(appearance: ReturnType<typeof readAppearance>) {
  try {
    localStorage.setItem(key, JSON.stringify(appearance))
  } catch {
    // The current session can still switch appearance.
  }
}
