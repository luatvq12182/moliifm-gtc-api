require('dotenv').config()
const http = require('http')
const app = require('./app')
const connectDB = require('./config/db')
const { attachPronunciationWs } = require('./lib/pronunciationWs')

const PORT = process.env.PORT || 4000

async function start() {
  try {
    await connectDB()

    // Tạo HTTP server tường minh (thay vì app.listen) để gắn được
    // WebSocket chấm phát âm iFLYTEK vào cùng server/cổng.
    const server = http.createServer(app)
    attachPronunciationWs(server)

    server.listen(PORT, () => {
      console.log(`[server] Đang chạy tại http://localhost:${PORT}`)
    })
  } catch (err) {
    console.error('[server] Không thể khởi động:', err.message)
    process.exit(1)
  }
}

start()