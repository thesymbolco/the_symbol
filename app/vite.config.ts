import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const appRoot = path.dirname(fileURLToPath(import.meta.url))

/**
 * 개발 서버에서만: POST /api/alma/refresh-member → 회원 단가 스크립트 실행 후 public/alma-prices-member.json 갱신
 * (프로덕션 정적 호스팅에는 없음 — 그때는 터미널에서 npm run scrape:alma:member 사용)
 */
function almaRefreshPlugin(): Plugin {
  return {
    name: 'alma-refresh-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'POST') {
          next()
          return
        }
        const pathname = req.url?.split('?')[0] ?? ''
        const scriptRel = pathname === '/api/alma/refresh-member' ? 'scripts/fetch-alma-member-prices.mjs' : null
        if (!scriptRel) {
          next()
          return
        }

        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        const child = spawn(process.execPath, [path.join(appRoot, scriptRel)], {
          cwd: appRoot,
          env: process.env,
        })
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (d: Buffer) => {
          stdout += d.toString()
        })
        child.stderr?.on('data', (d: Buffer) => {
          stderr += d.toString()
        })
        child.on('error', (err) => {
          res.statusCode = 500
          res.end(
            JSON.stringify({
              ok: false,
              error: err.message,
              stdout,
              stderr,
            }),
          )
        })
        child.on('close', (code) => {
          if (code === 0) {
            res.statusCode = 200
            res.end(JSON.stringify({ ok: true, stdout, stderr }))
          } else {
            res.statusCode = 500
            res.end(
              JSON.stringify({
                ok: false,
                error: `스크립트 종료 코드 ${code}`,
                stdout,
                stderr,
              }),
            )
          }
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), almaRefreshPlugin()],
  resolve: {
    alias: {
      tslib: path.join(appRoot, 'src/vendor/tslib.ts'),
    },
  },
})
