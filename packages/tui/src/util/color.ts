import { RGBA } from "@opentui/core"

type Palette = { background: { base: RGBA }; text: { base: RGBA } }

export function mix(from: RGBA, to: RGBA, amount: number) {
  return RGBA.fromValues(
    from.r + (to.r - from.r) * amount,
    from.g + (to.g - from.g) * amount,
    from.b + (to.b - from.b) * amount,
    1,
  )
}

// Prefer the theme's own text colors; a mid-tone accent can leave both under 4.5:1, so fall back to black or white.
export function readable(bg: RGBA, theme: Palette) {
  const contrast = (color: RGBA) => {
    const [high, low] = [luminance(bg), luminance(color)].sort((a, b) => b - a)
    return (high + 0.05) / (low + 0.05)
  }
  const candidates = [theme.text.base, theme.background.base, RGBA.fromInts(0, 0, 0), RGBA.fromInts(255, 255, 255)]
  return (
    candidates.find((color) => contrast(color) >= 4.5) ??
    candidates.reduce((a, b) => (contrast(b) > contrast(a) ? b : a))
  )
}

function luminance(color: RGBA) {
  const linear = (channel: number) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}
