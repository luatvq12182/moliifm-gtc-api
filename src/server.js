require('dotenv').config()
const http = require('http')
const app = require('./app')
const connectDB = require('./config/db')
const { checkIndexes } = require('./lib/checkIndexes')
const { attachPronunciationWs } = require('./lib/pronunciationWs')
const { startMaintenanceLoop } = require('./lib/practiceCleanup')
const { backfillLessonAttemptStatus } = require('./lib/lessonProgress')

const PORT = process.env.PORT || 4000

async function start() {
  try {
    await connectDB()

    // Soát chỉ mục ngay sau khi kết nối. Chỉ cảnh báo vào log, KHÔNG chặn khởi
    // động: máy chủ vẫn phải phục vụ được, chỉ là người vận hành cần biết có
    // việc phải làm. Xem lib/checkIndexes.js.
    await checkIndexes(require('mongoose').connection)

    // Lượt học tạo trước khi có "đang học dở" chưa có trạng thái — gắn cho
    // chúng là đã hoàn thành. Chạy được nhiều lần, lần sau không còn gì để sửa.
    await backfillLessonAttemptStatus()

    // Tạo HTTP server tường minh (thay vì app.listen) để gắn được
    // WebSocket chấm phát âm iFLYTEK vào cùng server/cổng.
    const server = http.createServer(app)
    attachPronunciationWs(server)

    // Dọn kho ghi âm luyện nói theo chu kỳ: xoá lượt đọc "tạm" không thuộc
    // lượt học nào, nén bản ghi đã giữ sang AAC, quét file mồ côi. Xem
    // lib/practiceCleanup.js.
    startMaintenanceLoop()

    server.listen(PORT, () => {
      console.log(`[server] Đang chạy tại http://localhost:${PORT}`)
    })
  } catch (err) {
    console.error('[server] Không thể khởi động:', err.message)
    process.exit(1)
  }
}

start()