/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: { primary: '#101b2c', secondary: '#16243a', tertiary: '#1c2d46', hover: '#243854' },
        border: { DEFAULT: '#30425f', hover: '#4a6385' },
        accent: { DEFAULT: '#79b8ff', hover: '#a5d0ff' },
        success: '#70d1b4', warning: '#f2c47e', danger: '#ff9ca8',
        text: { primary: '#eaf1fb', secondary: '#b8c7dd', muted: '#a4b5ce' }
      },
      fontFamily: {
        sans: ['Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI', 'system-ui', 'sans-serif'],
        mono: ['Cascadia Code', 'Consolas', 'monospace']
      }
    }
  },
  plugins: []
}
