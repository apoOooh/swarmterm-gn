/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'rgb(var(--color-border) / calc(var(--color-border-alpha, 1) * <alpha-value>))',
        'pane-border': 'rgb(var(--color-pane-border) / calc(var(--color-pane-border-alpha, 1) * <alpha-value>))',
        input: 'rgb(var(--color-input) / calc(var(--color-input-alpha, 1) * <alpha-value>))',
        ring: 'rgb(var(--color-ring) / calc(var(--color-ring-alpha, 1) * <alpha-value>))',
        broadcast: 'rgb(var(--color-broadcast) / calc(var(--color-broadcast-alpha, 1) * <alpha-value>))',
        zoom: 'rgb(var(--color-zoom) / calc(var(--color-zoom-alpha, 1) * <alpha-value>))',
        activity: 'rgb(var(--color-activity) / calc(var(--color-activity-alpha, 1) * <alpha-value>))',
        background: 'rgb(var(--color-background) / calc(var(--color-background-alpha, 1) * <alpha-value>))',
        canvas: 'rgb(var(--color-canvas) / calc(var(--color-canvas-alpha, 1) * <alpha-value>))',
        foreground: 'rgb(var(--color-foreground) / calc(var(--color-foreground-alpha, 1) * <alpha-value>))',
        primary: {
          DEFAULT: 'rgb(var(--color-primary) / calc(var(--color-primary-alpha, 1) * <alpha-value>))',
          foreground: 'rgb(var(--color-primary-foreground) / calc(var(--color-primary-foreground-alpha, 1) * <alpha-value>))'
        },
        secondary: {
          DEFAULT: 'rgb(var(--color-secondary) / calc(var(--color-secondary-alpha, 1) * <alpha-value>))',
          foreground: 'rgb(var(--color-secondary-foreground) / calc(var(--color-secondary-foreground-alpha, 1) * <alpha-value>))'
        },
        destructive: {
          DEFAULT: 'rgb(var(--color-destructive) / calc(var(--color-destructive-alpha, 1) * <alpha-value>))',
          foreground: 'rgb(var(--color-destructive-foreground) / calc(var(--color-destructive-foreground-alpha, 1) * <alpha-value>))'
        },
        muted: {
          DEFAULT: 'rgb(var(--color-muted) / calc(var(--color-muted-alpha, 1) * <alpha-value>))',
          foreground: 'rgb(var(--color-muted-foreground) / calc(var(--color-muted-foreground-alpha, 1) * <alpha-value>))'
        },
        accent: {
          DEFAULT: 'rgb(var(--color-accent) / calc(var(--color-accent-alpha, 1) * <alpha-value>))',
          foreground: 'rgb(var(--color-accent-foreground) / calc(var(--color-accent-foreground-alpha, 1) * <alpha-value>))'
        },
        popover: {
          DEFAULT: 'rgb(var(--color-popover) / calc(var(--color-popover-alpha, 1) * <alpha-value>))',
          foreground: 'rgb(var(--color-popover-foreground) / calc(var(--color-popover-foreground-alpha, 1) * <alpha-value>))'
        },
        card: {
          DEFAULT: 'rgb(var(--color-card) / calc(var(--color-card-alpha, 1) * <alpha-value>))',
          foreground: 'rgb(var(--color-card-foreground) / calc(var(--color-card-foreground-alpha, 1) * <alpha-value>))'
        }
      },
      borderRadius: {
        lg: 'var(--radius-lg)',
        md: 'var(--radius)',
        sm: 'var(--radius-sm)'
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' }
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' }
        }
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out'
      }
    }
  },
  plugins: [require('tailwindcss-animate')]
}
