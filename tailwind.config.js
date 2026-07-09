/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Skyrim Anime Fantasy palette
        dragon: {
          50:  '#fff5f0',
          100: '#ffe8d6',
          200: '#ffc9a8',
          300: '#ffa070',
          400: '#ff6a2e',
          500: '#ff4500',
          600: '#e03000',
          700: '#b82200',
          800: '#8f1900',
          900: '#6e1400',
        },
        soul: {
          50:  '#f0f4ff',
          100: '#d9e3ff',
          200: '#b3c8ff',
          300: '#80a6ff',
          400: '#4d7dff',
          500: '#2255e0',
          600: '#1a3eb8',
          700: '#132e8f',
          800: '#0d2070',
          900: '#081650',
        },
        void: {
          50:  '#f5f0ff',
          100: '#e8d9ff',
          200: '#cdb3ff',
          300: '#a880ff',
          400: '#7d4dff',
          500: '#5522e0',
          600: '#3e1ab8',
          700: '#2e138f',
          800: '#200d70',
          900: '#160850',
        },
        dark: {
          50:  '#f0f0f2',
          100: '#d4d4d8',
          200: '#a1a1aa',
          300: '#71717a',
          400: '#52525b',
          500: '#3f3f46',
          600: '#27272a',
          700: '#1c1c1f',
          800: '#141416',
          900: '#0a0a0c',
          950: '#050507',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Cinzel', 'serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-conic': 'conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))',
        'dragon-breath': 'linear-gradient(135deg, #ff4500 0%, #e03000 25%, #5522e0 75%, #2255e0 100%)',
        'soul-gem': 'linear-gradient(135deg, #7d4dff 0%, #4d7dff 50%, #80a6ff 100%)',
        'night-sky': 'linear-gradient(180deg, #050507 0%, #0a0a14 50%, #0d1428 100%)',
      },
      boxShadow: {
        'dragon': '0 0 20px rgba(255, 69, 0, 0.4), 0 0 60px rgba(255, 69, 0, 0.2)',
        'soul': '0 0 20px rgba(77, 125, 255, 0.4), 0 0 60px rgba(77, 125, 255, 0.2)',
        'void': '0 0 20px rgba(125, 77, 255, 0.4), 0 0 60px rgba(125, 77, 255, 0.2)',
        'card': '0 4px 24px rgba(0, 0, 0, 0.6)',
        'glow': '0 0 15px rgba(255, 255, 255, 0.1)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'float': 'float 6s ease-in-out infinite',
        'shimmer': 'shimmer 2s linear infinite',
        'spin-slow': 'spin 8s linear infinite',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        }
      }
    },
  },
  plugins: [],
}
