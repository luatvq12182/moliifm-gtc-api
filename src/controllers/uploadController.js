const asyncHandler = require('../utils/asyncHandler')

const uploadImage = asyncHandler(async function uploadImage(req, res) {
    if (!req.file) {
        res.status(400)
        throw new Error('Không nhận được file ảnh nào.')
    }

    // Trả về đường dẫn tương đối — frontend tự ghép với domain backend khi hiển thị
    const url = `/uploads/images/${req.file.filename}`
    res.status(201).json({ url })
})

const uploadVideo = asyncHandler(async function uploadVideo(req, res) {
  if (!req.file) {
    res.status(400)
    throw new Error('Không nhận được file video nào.')
  }

  const url = `/uploads/videos/${req.file.filename}`
  res.status(201).json({ url })
})

module.exports = { uploadImage, uploadVideo }