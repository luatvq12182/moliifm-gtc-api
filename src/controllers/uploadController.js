const crypto = require('crypto')
const asyncHandler = require('../utils/asyncHandler')
const { compressVideo, getJob } = require('../lib/videoProcessor')

const uploadImage = asyncHandler(async function uploadImage(req, res) {
  if (!req.file) {
    res.status(400)
    throw new Error('Không nhận được file ảnh nào.')
  }

  const url = `/uploads/images/${req.file.filename}`
  res.status(201).json({ url })
})

const uploadVideo = asyncHandler(async function uploadVideo(req, res) {
  if (!req.file) {
    res.status(400)
    throw new Error('Không nhận được file video nào.')
  }

  // Trả về ngay + kích hoạt nén ngầm phía sau. Frontend sẽ poll trạng thái
  // qua jobId cho tới khi nén xong mới lấy URL cuối cùng.
  const jobId = crypto.randomUUID()
  compressVideo(jobId, req.file.path)

  res.status(202).json({ jobId })
})

const getVideoJobStatus = asyncHandler(async function getVideoJobStatus(req, res) {
  const job = getJob(req.params.jobId)
  if (!job) {
    res.status(404)
    throw new Error('Không tìm thấy tiến trình nén này (có thể server vừa khởi động lại).')
  }
  res.json(job)
})

module.exports = { uploadImage, uploadVideo, getVideoJobStatus }