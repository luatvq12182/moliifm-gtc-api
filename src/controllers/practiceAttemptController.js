const fs = require('fs')
const PracticeAttempt = require('../models/PracticeAttempt')
const Student = require('../models/Student')
const asyncHandler = require('../utils/asyncHandler')
const { features } = require('../config/features')
const { resolveStoragePath, deletePracticeAudio } = require('../lib/audioStorage')

// Chặn sớm khi cờ đang tắt. Dùng cho mọi route lịch sử luyện nói: sản phẩm đã
// ra thị trường thì các endpoint này coi như không tồn tại.
function ensureEnabled(res) {
    if (!features.practiceHistoryEnabled) {
        res.status(404)
        throw new Error('Tính năng lưu lịch sử luyện nói đang tắt.')
    }
}

// GET /api/students/:id/practice-attempts?page=&limit=&lessonSlug=
const getStudentPracticeAttempts = asyncHandler(async function getStudentPracticeAttempts(req, res) {
    ensureEnabled(res)

    const student = await Student.findById(req.params.id).select('name email')
    if (!student) {
        res.status(404)
        throw new Error('Không tìm thấy học viên.')
    }

    const { page = 1, limit = 20, lessonSlug } = req.query
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20))
    const skip = (pageNum - 1) * limitNum

    const query = { student: student._id }
    if (lessonSlug) query.lessonSlug = lessonSlug

    const [attempts, total] = await Promise.all([
        PracticeAttempt.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
        PracticeAttempt.countDocuments(query),
    ])

    // Không trả audioPath ra ngoài — đó là chi tiết lưu trữ nội bộ. Client chỉ
    // cần biết CÓ file ghi âm hay không, rồi gọi route audio bằng id.
    const data = attempts.map(({ audioPath, ...rest }) => ({
        ...rest,
        hasAudio: Boolean(audioPath),
    }))

    res.json({
        data,
        student: { _id: student._id, name: student.name, email: student.email },
        pagination: {
            total,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(total / limitNum),
        },
    })
})

// GET /api/students/:id/practice-attempts/:attemptId/audio
// Phát file WAV. Đi qua protectAdmin nên KHÔNG phục vụ file tĩnh công khai —
// giọng nói học viên là dữ liệu cá nhân.
const getPracticeAttemptAudio = asyncHandler(async function getPracticeAttemptAudio(req, res) {
    ensureEnabled(res)

    const attempt = await PracticeAttempt.findOne({
        _id: req.params.attemptId,
        student: req.params.id, // ràng buộc luôn theo học viên, tránh đoán id chéo
    })
    if (!attempt || !attempt.audioPath) {
        res.status(404)
        throw new Error('Không tìm thấy bản ghi âm.')
    }

    const absolutePath = resolveStoragePath(attempt.audioPath)
    if (!absolutePath || !fs.existsSync(absolutePath)) {
        res.status(404)
        throw new Error('File ghi âm không còn trên máy chủ.')
    }

    res.setHeader('Content-Type', 'audio/wav')
    res.setHeader('Content-Length', fs.statSync(absolutePath).size)
    // Không cho cache ở proxy trung gian: đây là dữ liệu cá nhân.
    res.setHeader('Cache-Control', 'private, no-store')
    fs.createReadStream(absolutePath).pipe(res)
})

// DELETE /api/students/:id/practice-attempts
// Xoá sạch lịch sử của một học viên (cả bản ghi DB lẫn file WAV).
// Dùng khi nghiệm thu xong, hoặc khi học viên yêu cầu xoá dữ liệu cá nhân.
const deleteStudentPracticeAttempts = asyncHandler(async function deleteStudentPracticeAttempts(req, res) {
    ensureEnabled(res)

    const attempts = await PracticeAttempt.find({ student: req.params.id }).select('audioPath')
    await Promise.all(attempts.map((a) => deletePracticeAudio(a.audioPath)))
    const result = await PracticeAttempt.deleteMany({ student: req.params.id })

    res.json({
        message: `Đã xoá ${result.deletedCount} lượt luyện nói và toàn bộ file ghi âm kèm theo.`,
        deletedCount: result.deletedCount,
    })
})

module.exports = {
    getStudentPracticeAttempts,
    getPracticeAttemptAudio,
    deleteStudentPracticeAttempts,
}
