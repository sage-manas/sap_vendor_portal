// Both directions' tokens. The generator and the contrast check read this file,
// so what is checked is exactly what is rendered.
module.exports = {
  ledger: {
    name: 'A · Ledger',
    fonts: {
      href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap',
      sans: "'IBM Plex Sans', system-ui, sans-serif",
      mono: "'IBM Plex Mono', ui-monospace, monospace",
    },
    radius: [6, 10, 14],
    rowH: 40,
    sidebar: 'light',
    light: {
      canvas: '#F6F7F9', surface: '#FFFFFF', subtle: '#EFF1F4', hover: '#F3F5F8',
      border: '#E2E5EA', borderStrong: '#C9CED6', inputBorder: '#858E9C',
      fg: '#0E1726', fgMuted: '#465163', fgSubtle: '#636D7D',
      accent: '#1E4FD0', accentFg: '#FFFFFF', accentText: '#1A45B8', accentTint: '#EAF0FD',
      success: '#2B7550', warning: '#8A5A0F', danger: '#B02F27', info: '#2A6496',
      successTint: '#E7F3EC', warningTint: '#FBF1DF', dangerTint: '#FBE9E7', infoTint: '#E6F0F8',
      navBg: '#FFFFFF', navFg: '#465163', navActiveBg: '#EFF1F4', navActiveFg: '#0E1726', navIdentity: '#EFF1F4',
    },
    dark: {
      canvas: '#0B0F15', surface: '#11161E', subtle: '#171D27', hover: '#1A2130',
      border: '#232B37', borderStrong: '#323C4B', inputBorder: '#5E6A7D',
      fg: '#E7EBF1', fgMuted: '#A9B2C0', fgSubtle: '#8A94A4',
      accent: '#7C9DFF', accentFg: '#0B0F15', accentText: '#9AB4FF', accentTint: '#1A2440',
      success: '#62C08F', warning: '#D9A54C', danger: '#F07C72', info: '#72AADB',
      successTint: '#14261D', warningTint: '#2A2112', dangerTint: '#2E1715', infoTint: '#132232',
      navBg: '#0E131A', navFg: '#A9B2C0', navActiveBg: '#1A2130', navActiveFg: '#E7EBF1', navIdentity: '#171D27',
    },
  },
  graphite: {
    name: 'B · Graphite',
    fonts: {
      href: null, // Geist is already self-hosted in src/app/fonts
      sans: "'Geist', system-ui, sans-serif",
      mono: "'Geist Mono', ui-monospace, monospace",
    },
    radius: [4, 6, 10],
    rowH: 36,
    sidebar: 'dark',
    light: {
      canvas: '#FAFAFA', surface: '#FFFFFF', subtle: '#F4F4F5', hover: '#F4F4F5',
      border: '#E4E4E7', borderStrong: '#D4D4D8', inputBorder: '#8A8A93',
      fg: '#18181B', fgMuted: '#4F4F57', fgSubtle: '#6B6B74',
      accent: '#0D6B5B', accentFg: '#FFFFFF', accentText: '#0B5E50', accentTint: '#E5F2EF',
      success: '#25704A', warning: '#865A0C', danger: '#AE2F2F', info: '#2D5F8F',
      successTint: '#E6F2EB', warningTint: '#FAF0DC', dangerTint: '#FAE8E8', infoTint: '#E6EEF6',
      navBg: '#18181B', navFg: '#A1A1AA', navActiveBg: '#27272A', navActiveFg: '#FAFAFA', navIdentity: '#27272A',
    },
    dark: {
      canvas: '#09090B', surface: '#111113', subtle: '#18181B', hover: '#1C1C20',
      border: '#26262B', borderStrong: '#36363D', inputBorder: '#62626B',
      fg: '#F4F4F5', fgMuted: '#A8A8B1', fgSubtle: '#8B8B95',
      accent: '#3FB89F', accentFg: '#09090B', accentText: '#5CC9B1', accentTint: '#12241F',
      success: '#5DBE88', warning: '#D6A446', danger: '#EF7A72', info: '#74A6D6',
      successTint: '#13241A', warningTint: '#282010', dangerTint: '#2C1616', infoTint: '#132130',
      navBg: '#0E0E10', navFg: '#A1A1AA', navActiveBg: '#1F1F23', navActiveFg: '#FAFAFA', navIdentity: '#1F1F23',
    },
  },
};
