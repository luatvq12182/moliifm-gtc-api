// Middleware xử lý lỗi tập trung — đặt cuối cùng trong app.js.
// Nhận diện vài loại lỗi phổ biến từ Mongoose để trả message dễ hiểu hơn,
// thay vì luôn trả nguyên message kỹ thuật của MongoDB.
function errorHandler(err, req, res, next) {
  let statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500
  let message = err.message || 'Lỗi hệ thống, vui lòng thử lại sau.'

  if (err.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ message: 'File vượt quá dung lượng cho phép.' })
    return
  }

  // Lỗi trùng khóa unique (vd. email đã tồn tại)
  if (err.code === 11000) {
    statusCode = 409
    const field = Object.keys(err.keyPattern || { field: 1 })[0]
    message = `Giá trị "${field}" đã tồn tại trong hệ thống.`
  }

  // Lỗi validate của Mongoose (thiếu field required, sai enum...)
  if (err.name === 'ValidationError') {
    statusCode = 400
    message = Object.values(err.errors)
      .map((e) => e.message)
      .join(', ')
  }

  // Lỗi truyền sai định dạng ObjectId (vd. id không hợp lệ trên URL)
  if (err.name === 'CastError') {
    statusCode = 400
    message = `Giá trị id không hợp lệ: ${err.value}`
  }

  res.status(statusCode).json({
    message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  })
}

module.exports = errorHandler
