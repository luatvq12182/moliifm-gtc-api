require('dotenv').config()
const app = require('./app')
const connectDB = require('./config/db')

const PORT = process.env.PORT || 4000

async function start() {
  try {
    await connectDB()
    app.listen(PORT, () => {
      console.log(`[server] Đang chạy tại http://localhost:${PORT}`)
    })
  } catch (err) {
    console.error('[server] Không thể khởi động:', err.message)
    process.exit(1)
  }
}

start()
