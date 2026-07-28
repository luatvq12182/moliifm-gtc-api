const multer = require('multer')
const path = require('path')
const fs = require('fs')

const uploadDir = path.join(__dirname, '../../uploads/videos')
fs.mkdirSync(uploadDir, { recursive: true })

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname)
        const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`
        cb(null, unique)
    },
})

function fileFilter(req, file, cb) {
    const allowed = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']
    if (!allowed.includes(file.mimetype)) {
        return cb(new Error('Chỉ chấp nhận file video (MP4, WebM, MOV...).'))
    }
    cb(null, true)
}

const uploadVideo = multer({
    storage,
    fileFilter,
    limits: { fileSize: 500 * 1024 * 1024 }, // tối đa 500MB/video
})

module.exports = uploadVideo