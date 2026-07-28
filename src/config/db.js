const mongoose = require('mongoose')

async function connectDB() {
  const uri = process.env.MONGO_URI

  if (!uri) {
    throw new Error('Thiếu biến môi trường MONGO_URI trong file .env')
  }

  mongoose.connection.on('connected', () => {
    console.log('[mongo] Đã kết nối MongoDB')
  })

  mongoose.connection.on('error', (err) => {
    console.error('[mongo] Lỗi kết nối MongoDB:', err.message)
  })

  await mongoose.connect(uri)
}

module.exports = connectDB
