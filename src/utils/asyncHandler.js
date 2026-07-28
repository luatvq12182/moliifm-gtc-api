// Bọc quanh mỗi controller async — tự bắt lỗi và chuyển cho middleware
// errorHandler xử lý tập trung, khỏi phải viết try/catch lặp lại ở từng hàm.
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

module.exports = asyncHandler
