const multer = require('multer')
const path = require('path')
const fs = require('fs')

// Lưu file thẳng vào ổ đĩa VPS, không qua cloud storage — đơn giản, phù hợp
// quy mô hiện tại. Nếu sau này cần scale (nhiều server, CDN...), đây là chỗ
// cần thay bằng S3/Cloudinary thay vì diskStorage.
const uploadDir = path.join(__dirname, '../../uploads/images')
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
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    if (!allowed.includes(file.mimetype)) {
        return cb(new Error('Chỉ chấp nhận file ảnh (PNG, JPG, WEBP, GIF).'))
    }
    cb(null, true)
}

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 }, // tối đa 5MB/ảnh
})

module.exports = upload