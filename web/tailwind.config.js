import daisyui from 'daisyui';

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [
    daisyui,
  ],
  daisyui: {
    themes: [
      {
        dark: {
          "primary": "#38bdf8",
          "secondary": "#a855f7",
          "accent": "#0ea5e9",
          "neutral": "#1e293b",
          "base-100": "#0b0f19",
          "base-200": "#111827",
          "base-300": "#1f2937",
          "info": "#38bdf8",
          "success": "#10b981",
          "warning": "#f59e0b",
          "error": "#ef4444",
        },
      },
      "night",
      "synthwave",
    ],
    darkTheme: "dark",
  },
};

