const multer = require('multer')
const path = require('path')
const fs = require('fs')
const { AUDIO_EXTS } = require('../lib/examTest')

/**
 * Nhận file đề (PDF) và file nghe cho "Luyện thi HSK 3.0". Ghi thẳng xuống đĩa
 * (thư mục tạm trong storage/, ngoài uploads/ nên không ai tải được), giống
 * uploadMaterial.
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

const byExt = (exts, message) => (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(1).toLowerCase()
    if (!exts.includes(ext)) return cb(new Error(message))
    cb(null, true)
}

const uploadExamPdf = multer({
    storage,
    fileFilter: byExt(['pdf'], 'Đề thi chỉ nhận file PDF.'),
    limits: { fileSize: 100 * 1024 * 1024, files: 1 },
})

const uploadExamAudio = multer({
    storage,
    fileFilter: byExt(AUDIO_EXTS, `File nghe chỉ nhận ${AUDIO_EXTS.map((e) => '.' + e).join(', ')}.`),
    limits: { fileSize: 150 * 1024 * 1024, files: 1 },
})

module.exports = { uploadExamPdf, uploadExamAudio }
