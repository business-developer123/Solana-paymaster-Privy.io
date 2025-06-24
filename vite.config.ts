import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // This is needed for some libraries that expect process.env
    global: 'globalThis',
  },
  resolve: {
    alias: {
      // Polyfill Node.js built-ins for browser environment
      buffer: 'buffer',
    },
  },
  optimizeDeps: {
    include: [
      'buffer',
    ],
  },
  esbuild: {
    // This helps with polyfill issues
    define: {
      global: 'globalThis',
    },
  },
}) 