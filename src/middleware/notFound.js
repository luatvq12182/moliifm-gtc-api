function notFound(req, res, next) {
  res.status(404)
  next(new Error(`Không tìm thấy route: ${req.method} ${req.originalUrl}`))
}

module.exports = notFound
