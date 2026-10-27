const multer = require('multer')
const path = require('path')
const fs = require('fs')
const { ALLOWED_EXTS } = require('../lib/materialConvert')

/**
 * Nhận file slide (PowerPoint / PDF) cho chức năng "Học liệu khoá học".
 *
 * Ghi thẳng xuống ĐĨA (thư mục tạm trong storage/), không giữ trong RAM: một
 * file PowerPoint có ảnh dễ lên vài chục MB. Controller chuyển file từ đây
 * sang thư mục của bộ slide; file tạm nào sót lại (request lỗi giữa chừng) nằm
 * ngoài uploads/ nên không ai tải được.
 */
const tmpDir = path.join(__dirname, '../../storage/tmp-uploads')
fs.mkdirSync(tmpDir, { recursive: true })

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, tmpDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase()
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`)
    },
})

// Kiểm theo ĐUÔI file chứ không theo mimetype: trình duyệt gửi mimetype của
// .pptx rất thất thường (có máy gửi application/octet-stream).
function fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).slice(1).toLowerCase()
    if (!ALLOWED_EXTS.includes(ext)) {
        return cb(new Error('Chỉ nhận file PowerPoint (.pptx, .ppt), OpenDocument (.odp) hoặc PDF.'))
    }
    cb(null, true)
}

const uploadMaterial = multer({
    storage,
    fileFilter,
    limits: { fileSize: 100 * 1024 * 1024, files: 1 }, // tối đa 100MB/file
})

module.exports = uploadMaterial
