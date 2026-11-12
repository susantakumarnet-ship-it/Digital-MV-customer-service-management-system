import defaultColors from 'tailwindcss/colors';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // slate-500 darkened (#64748b → #586679) so secondary text meets WCAG AA (≥4.5:1) on the
        // light-grey surface as well as on white (found by the axe accessibility check).
        slate: { ...defaultColors.slate, 500: '#586679' },
        navy: {
          50: '#eef2fb',
          100: '#d8e0f3',
          200: '#b0c0e6',
          300: '#7f97d2',
          400: '#4c6bb8',
          500: '#2b4a96',
          600: '#1b3577',
          700: '#132a62',
          800: '#0f2353',
          900: '#0b1f4b',
          950: '#071433',
        },
        royal: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
        },
        teal: {
          50: '#f0fdfa',
          100: '#ccfbf1',
          500: '#14b8a6',
          600: '#0d9488',
          700: '#0f766e',
        },
        surface: '#f3f5f9',
        border: 'rgb(var(--border) / <alpha-value>)',
        primary: { DEFAULT: '#0b1f4b', foreground: '#ffffff' },
        secondary: { DEFAULT: '#1d4ed8', foreground: '#ffffff' },
        accent: { DEFAULT: '#0d9488', foreground: '#ffffff' },
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', '-apple-system', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      borderRadius: { xl: '0.875rem', '2xl': '1.125rem' },
      boxShadow: {
        card: '0 1px 2px rgba(11,31,75,0.06), 0 1px 3px rgba(11,31,75,0.08)',
      },
      keyframes: {
        'slide-in': { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } },
        'slide-in-left': { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(0)' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
      },
      animation: {
        'slide-in': 'slide-in 180ms ease-out',
        'slide-in-left': 'slide-in-left 180ms ease-out',
        'fade-in': 'fade-in 150ms ease-out',
      },
    },
  },
  plugins: [],
};
