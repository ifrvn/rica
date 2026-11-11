import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import UnoCSS from 'unocss/vite'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    vue(),
    UnoCSS({ configFile: fileURLToPath(new URL('./uno.config.ts', import.meta.url)) }),
    {
      name: 'rica-local-admin-origin',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const port = server.config.server.port
          if ((req.method === 'GET' || req.method === 'HEAD') &&
            req.headers.host === '127.0.0.1:' + port && req.url?.split('?')[0] === '/') {
            res.writeHead(307, { Location: 'http://localhost:' + port + '/', 'Cache-Control': 'no-store' })
            res.end()
            return
          }
          next()
        })
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/health': 'http://127.0.0.1:3000', '/v1': 'http://127.0.0.1:3000' },
  },
})
