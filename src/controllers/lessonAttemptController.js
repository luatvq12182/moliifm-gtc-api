const mongoose = require('mongoose')
const fs = require('fs')
const LessonAttempt = require('../models/LessonAttempt')
const PracticeAttempt = require('../models/PracticeAttempt')
const Student = require('../models/Student')
const asyncHandler = require('../utils/asyncHandler')
const { resolveStoragePath, deletePracticeAudio } = require('../lib/audioStorage')
const {
    summarizeSpeaking,
    summarizeExercise,
} = require('../lib/lessonAttemptClaim')
const {
    resolveCourseNames,
    lessonMeta,
    ensureInProgress,
    claimProvisional,
    spokenLinesOf,
    buildVideos,
} = require('../lib/lessonProgress')

// Nộp lại trong khoảng này coi như cùng một lần. Chống bấm đúp và chống việc
// client thử lại sau khi mạng chập — hai bản ghi cho một lần học là sai.
const DUPLICATE_WINDOW_MS = 60 * 1000

const LIST_FIELDS =
    'lesson lessonTitle lessonSlug curriculumSlug courseSlug courseName courseThumbnail curriculumName lessonOrder status completedAt activityAt progressPercent createdAt exercise speaking'

// Ảnh chụp tiến độ do trình duyệt gửi lên. Một bài 4 video × 20 câu chỉ cỡ vài
// chục KB; quá ngưỡng này là dữ liệu bất thường, không cất.
const MAX_PROGRESS_BYTES = 256 * 1024

const isId = (v) => Boolean(v) && mongoose.Types.ObjectId.isValid(String(v))

/**
 * Chốt một lượt học: tính lại phần luyện nói từ dữ liệu máy chủ, gộp với phần
 * bài tập client gửi, rồi ghi vào `doc` với các trường bổ sung `extra`.
 */
async function finalizeInto(doc, body, extra) {
    await claimProvisional(doc)
    const spokenLines = await spokenLinesOf(doc._id)
    const videos = buildVideos(body.videos, spokenLines)
    Object.assign(doc, lessonMeta(body), extra, {
        videos,
        exercise: summarizeExercise(videos),
        speaking: summarizeSpeaking(spokenLines),
        exerciseScoreTrusted: false,
    })
    await doc.save()
    // Số lượt đọc (kèm ghi âm) thuộc về lượt học này.
    return spokenLines.reduce((n, l) => n + (l.attempts || []).length, 0)
}

/**
 * POST /api/lesson-attempts — học viên vừa đi hết cả bài.
 *
 * Bình thường lượt học ĐÃ CÓ từ trước (trạng thái đang dở, tạo từ câu trả
 * lời hay lượt đọc đầu tiên) — ở đây chỉ chốt nó lại thành "hoàn thành".
 * Không tìm thấy lượt đang dở (trình duyệt còn chạy bản cũ chưa lưu tiến độ)
 * thì tạo mới như trước.
 *
 * ĐIỂM BÀI TẬP lấy từ client — bài tập chấm ở trình duyệt nên máy chủ không
 * xác minh được, ghi cờ `exerciseScoreTrusted: false`. ĐIỂM LUYỆN NÓI dựng lại
 * từ PracticeAttempt do chính máy chủ ghi khi chấm, KHÔNG nhận từ client.
 */
const createLessonAttempt = asyncHandler(async function createLessonAttempt(req, res) {
    const studentId = req.student._id
    const { lessonId, attemptId } = req.body

    if (!isId(lessonId)) {
        res.status(400)
        throw new Error('Thiếu mã bài học.')
    }

    // Lượt đang dở của bài này: theo id client gửi, không có thì theo bài.
    let doc = null
    if (isId(attemptId)) {
        doc = await LessonAttempt.findOne({ _id: attemptId, student: studentId, lesson: lessonId })
        // Đã chốt rồi (bấm đúp, hoặc client thử lại sau khi mạng chập) -> trả
        // lại đúng bản đó, không tạo bản thứ hai.
        if (doc && doc.status === 'completed') {
            res.status(200).json({ attempt: doc, duplicate: true })
            return
        }
    }
    if (!doc) {
        doc = await LessonAttempt.findOne({ student: studentId, lesson: lessonId, status: 'in_progress' })
    }

    if (!doc) {
        // Chống nộp trùng cho đường cũ (không có lượt đang dở).
        const recent = await LessonAttempt.findOne({
            student: studentId,
            lesson: lessonId,
            status: 'completed',
            completedAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
        })
        if (recent) {
            res.status(200).json({ attempt: recent, duplicate: true })
            return
        }
        doc = new LessonAttempt({
            student: studentId,
            lesson: lessonId,
            ...(await resolveCourseNames(lessonId)),
        })
        // Cần _id trước để gắn các lượt đọc tạm vào nó.
        await doc.save()
    }

    const now = new Date()
    const keptRecordings = await finalizeInto(doc, req.body, {
        status: 'completed',
        completedAt: now,
        activityAt: now,
        progressPercent: 100,
        // Bài đã xong thì không còn gì để "học tiếp" — bỏ ảnh chụp tiến độ.
        progress: null,
    })

    res.status(201).json({ attempt: doc, keptRecordings })
})

/**
 * Kết quả một lượt đọc, theo đúng dạng trang học dùng để hiện lại câu đã luyện.
 * Chỉ những gì máy chủ đã lưu — không có bản ghi âm trong bộ nhớ trình duyệt,
 * nên trang học cho nghe lại qua route ghi âm của học viên.
 */
function readingResult(a) {
    const r = a.rawScores || {}
    const round = (v) => (typeof v === 'number' ? Math.round(v) : null)
    return {
        attemptId: a._id,
        rejected: Boolean(a.isRejected),
        exceptInfo: a.exceptInfo || null,
        pronScore: typeof a.pronScore === 'number' ? a.pronScore : null,
        accuracy: round(r.phone_score),
        prosody: round(r.tone_score),
        fluency: round(r.fluency_score),
        completeness: round(r.integrity_score),
        spokenText: a.spokenText || '',
        spokenMatch: a.spokenMatch || null,
        spokenMismatch: a.spokenMatch ? a.spokenMatch.cap !== null && a.spokenMatch.cap !== undefined : false,
        cappedFrom: a.spokenMatch?.cappedFrom ?? null,
        words: a.words || [],
        chars: a.chars || [],
        feedback: a.feedback || '',
        hasAudio: Boolean(a.audioPath),
        at: a.createdAt,
    }
}

/**
 * GET /api/lesson-attempts/current?lessonId= — lượt đang dở của bài này.
 *
 * Trả `attempt: null` khi chưa có (bài mới, hoặc lần trước đã học xong).
 * `speaking` là kết quả LƯỢT ĐỌC CUỐI của từng câu đã luyện, để trang học hiện
 * lại điểm từng câu như lúc học viên rời đi.
 */
const getCurrentAttempt = asyncHandler(async function getCurrentAttempt(req, res) {
    const { lessonId } = req.query
    if (!isId(lessonId)) {
        res.status(400)
        throw new Error('Thiếu mã bài học.')
    }

    const attempt = await LessonAttempt.findOne({
        student: req.student._id,
        lesson: lessonId,
        status: 'in_progress',
    })
        .select('progress progressPercent activityAt createdAt')
        .lean()

    if (!attempt) {
        res.json({ attempt: null, speaking: [] })
        return
    }

    const readings = await PracticeAttempt.find({ lessonAttempt: attempt._id })
        .select('videoIndex lineIndex pronScore rawScores isRejected exceptInfo spokenText spokenMatch words chars feedback audioPath createdAt')
        .sort({ createdAt: 1, _id: 1 })
        .lean()

    // Ghi đè theo thứ tự thời gian -> cuối vòng mỗi câu còn lượt đọc mới nhất.
    const latest = new Map()
    for (const a of readings) {
        if (a.lineIndex < 0) continue
        latest.set(`${a.videoIndex}:${a.lineIndex}`, a)
    }

    res.json({
        attempt,
        speaking: Array.from(latest.values()).map((a) => ({
            videoIndex: a.videoIndex,
            lineIndex: a.lineIndex,
            result: readingResult(a),
        })),
    })
})

/**
 * PUT /api/lesson-attempts/current — lưu tiến độ của bài đang học.
 *
 * Trình duyệt gọi sau mỗi câu trả lời / mỗi bước (gom lại, cách nhau khoảng
 * một giây). Chưa có lượt đang dở thì tạo.
 *
 * Gửi kèm `attemptId` thì chỉ ghi vào đúng lượt đó: nếu nó đã được chốt
 * "hoàn thành" (một lần lưu đến muộn sau khi học viên vừa xong bài) thì BỎ
 * QUA, không được đẻ ra một lượt đang dở mới chứa nguyên bài vừa học xong.
 */
const saveCurrentAttempt = asyncHandler(async function saveCurrentAttempt(req, res) {
    const studentId = req.student._id
    const { lessonId, attemptId, progress } = req.body

    if (!isId(lessonId)) {
        res.status(400)
        throw new Error('Thiếu mã bài học.')
    }
    if (progress !== undefined && Buffer.byteLength(JSON.stringify(progress) || '') > MAX_PROGRESS_BYTES) {
        res.status(413)
        throw new Error('Dữ liệu tiến độ quá lớn.')
    }

    let doc = null
    if (isId(attemptId)) {
        doc = await LessonAttempt.findOne({ _id: attemptId, student: studentId, lesson: lessonId })
        if (doc && doc.status !== 'in_progress') {
            res.json({ ignored: true, reason: 'completed', attemptId: doc._id })
            return
        }
    }
    if (!doc) doc = await ensureInProgress(studentId, lessonId, req.body)

    await claimProvisional(doc)
    const spokenLines = await spokenLinesOf(doc._id)
    const videos = buildVideos(req.body.videos, spokenLines)
    const percent = Math.round(Number(req.body.progressPercent))

    Object.assign(doc, lessonMeta(req.body), {
        progress: progress ?? doc.progress,
        // Đang dở thì không bao giờ là 100 — 100 dành cho bài đã chốt.
        progressPercent: Number.isFinite(percent) ? Math.min(99, Math.max(0, percent)) : doc.progressPercent,
        activityAt: new Date(),
        videos,
        exercise: summarizeExercise(videos),
        speaking: summarizeSpeaking(spokenLines),
    })
    // `progress` là Mixed: Mongoose không tự biết nó đã đổi.
    doc.markModified('progress')
    await doc.save()

    res.json({ attemptId: doc._id, savedAt: doc.activityAt })
})

/**
 * DELETE /api/lesson-attempts/current?lessonId= — "Học lại từ đầu".
 *
 * Học viên mở một bài đang học dở từ menu và chọn học lại (đã được báo trên
 * hộp thoại là phần làm dở sẽ bị xoá). Xoá hẳn lượt đang dở cùng các lượt
 * đọc và file ghi âm của nó. Không giữ lại dưới dạng "bỏ dở": nếu chỉ tháo
 * liên kết thì các lượt đọc cũ thành "tạm" và bị gắn nhầm vào lượt mới ngay
 * lần lưu tiếp theo.
 */
const discardCurrentAttempt = asyncHandler(async function discardCurrentAttempt(req, res) {
    const { lessonId } = req.query
    if (!isId(lessonId)) {
        res.status(400)
        throw new Error('Thiếu mã bài học.')
    }

    const doc = await LessonAttempt.findOne({
        student: req.student._id,
        lesson: lessonId,
        status: 'in_progress',
    })
    if (!doc) {
        res.json({ deleted: 0 })
        return
    }

    // Lượt đọc "tạm" của bài này cũng đi luôn — chúng thuộc về lần học đang bị
    // bỏ, để lại thì lần lưu đầu tiên của lượt mới sẽ gắn nhầm chúng vào.
    const readings = await PracticeAttempt.find({
        student: req.student._id,
        $or: [{ lessonAttempt: doc._id }, { lesson: lessonId, lessonAttempt: null }],
    })
        .select('audioPath')
        .lean()
    await Promise.all(readings.map((a) => deletePracticeAudio(a.audioPath)))
    await PracticeAttempt.deleteMany({ _id: { $in: readings.map((a) => a._id) } })
    await LessonAttempt.deleteOne({ _id: doc._id })

    res.json({ deleted: 1, recordings: readings.length })
})

// Khoảng thời gian cho bộ lọc. Tính ở MÁY CHỦ, client chỉ gửi mã: nếu client
// tự tính mốc "30 ngày trước" thì mỗi lần render ra một mốc khác vài mili-giây,
// khóa truy vấn đổi liên tục và React Query gọi lại API không ngừng.
const RANGES = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }

/**
 * Bộ lọc + số liệu tổng quan cho màn lịch sử của một học viên.
 *
 * Tính trên TOÀN BỘ lịch sử, không theo bộ lọc đang chọn: danh sách lựa chọn
 * mà co lại theo chính lựa chọn đó thì chọn một khóa xong không chọn lại được
 * khóa khác.
 *
 * Danh sách khóa/bài lấy từ chính các lượt đã học chứ không từ danh mục: một
 * lựa chọn chỉ dẫn tới màn hình trống thì không nên có trong danh sách.
 */
async function historyFacets(studentId) {
    const [courses, lessons, totals] = await Promise.all([
        LessonAttempt.aggregate([
            { $match: { student: studentId } },
            { $group: { _id: '$courseSlug', name: { $last: '$courseName' }, count: { $sum: 1 } } },
            { $sort: { _id: 1 } },
        ]),
        LessonAttempt.aggregate([
            { $match: { student: studentId } },
            { $sort: { activityAt: 1 } },
            {
                $group: {
                    _id: '$lesson',
                    title: { $last: '$lessonTitle' },
                    order: { $last: '$lessonOrder' },
                    courseSlug: { $last: '$courseSlug' },
                    courseName: { $last: '$courseName' },
                    count: { $sum: 1 },
                },
            },
            { $sort: { courseSlug: 1, order: 1, title: 1 } },
        ]),
        LessonAttempt.aggregate([
            // Số liệu tổng quan CHỈ tính bài đã xong: điểm của bài đang dở là
            // điểm của nửa bài, gộp vào sẽ làm sai trung bình.
            { $match: { student: studentId, status: { $ne: 'in_progress' } } },
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    lessons: { $addToSet: '$lesson' },
                    // $avg BỎ QUA null — đúng ý: bài không có bài tập, hoặc
                    // chưa câu nào chấm được, thì không kéo điểm trung bình
                    // xuống như một con 0.
                    exerciseAvg: { $avg: '$exercise.score100' },
                    speakingAvg: { $avg: '$speaking.avgScore' },
                },
            },
        ]),
    ])

    const t = totals[0] || {}
    const round = (v) => (typeof v === 'number' ? Math.round(v) : null)

    const inProgress = await LessonAttempt.countDocuments({ student: studentId, status: 'in_progress' })

    return {
        courses: courses
            .filter((r) => r._id)
            .map((r) => ({ slug: r._id, name: r.name || r._id, count: r.count })),
        lessons: lessons
            .filter((r) => r._id)
            .map((r) => ({
                id: String(r._id),
                title: r.title || 'Bài học',
                courseSlug: r.courseSlug || '',
                courseName: r.courseName || r.courseSlug || '',
                count: r.count,
            })),
        stats: {
            totalCompletions: t.total || 0,
            distinctLessons: (t.lessons || []).filter(Boolean).length,
            exerciseAvg: round(t.exerciseAvg),
            speakingAvg: round(t.speakingAvg),
            inProgress,
        },
    }
}

/**
 * Gắn "lần thứ mấy" cho từng lượt trong trang đang hiện.
 *
 * Đếm trên TOÀN BỘ các lượt của bài đó, không theo bộ lọc: lọc "7 ngày qua"
 * thì lượt gần nhất vẫn phải là "lần 3", không được biến thành "lần 1" chỉ vì
 * hai lần trước nằm ngoài khoảng lọc.
 */
async function attachAttemptNumbers(studentId, rows) {
    const lessonIds = Array.from(new Set(rows.map((r) => r.lesson && String(r.lesson)).filter(Boolean)))
    if (lessonIds.length === 0) return rows

    const all = await LessonAttempt.find({ student: studentId, lesson: { $in: lessonIds } })
        // Đánh số theo lúc BẮT ĐẦU học: lượt đang dở chưa có completedAt.
        .select('lesson createdAt')
        .sort({ createdAt: 1, _id: 1 })
        .lean()

    const ordinal = new Map()
    const count = new Map()
    for (const a of all) {
        const key = String(a.lesson)
        const n = (count.get(key) || 0) + 1
        count.set(key, n)
        ordinal.set(String(a._id), n)
    }

    return rows.map((r) => ({
        ...r,
        attemptNo: ordinal.get(String(r._id)) || null,
        lessonAttemptCount: (r.lesson && count.get(String(r.lesson))) || null,
    }))
}

/**
 * GET /api/lesson-attempts — lịch sử của chính học viên đang đăng nhập.
 *
 * Lọc: ?courseSlug=hsk1  &lessonId=<id>  &range=7d|30d|90d|365d
 */
const listMyLessonAttempts = asyncHandler(async function listMyLessonAttempts(req, res) {
    const { page = 1, limit = 20, courseSlug, lessonId, range } = req.query
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20))
    const studentId = req.student._id

    const query = { student: studentId }
    if (courseSlug) query.courseSlug = String(courseSlug)
    if (lessonId && mongoose.Types.ObjectId.isValid(lessonId)) query.lesson = lessonId
    if (RANGES[range]) {
        query.activityAt = { $gte: new Date(Date.now() - RANGES[range] * 24 * 3600 * 1000) }
    }

    const [rows, total, facets] = await Promise.all([
        LessonAttempt.find(query)
            .select(LIST_FIELDS)
            .sort({ activityAt: -1, _id: -1 })
            .skip((pageNum - 1) * limitNum)
            .limit(limitNum)
            .lean(),
        LessonAttempt.countDocuments(query),
        historyFacets(studentId),
    ])

    res.json({
        data: await attachAttemptNumbers(studentId, rows),
        ...facets,
        pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    })
})

/** GET /api/lesson-attempts/:id — chi tiết một lượt, CHỈ của chính mình. */
const getMyLessonAttempt = asyncHandler(async function getMyLessonAttempt(req, res) {
    const attempt = await LessonAttempt.findOne({
        _id: req.params.id,
        // Lọc theo student NGAY TRONG TRUY VẤN, không tải lên rồi mới so.
        // So sau khi tải là chỗ rất dễ quên, và quên thì học viên đọc được
        // lịch sử của người khác chỉ bằng cách đổi id trên URL.
        student: req.student._id,
    })
        .select('-progress')
        .lean()

    if (!attempt) {
        res.status(404)
        throw new Error('Không tìm thấy lượt học này.')
    }
    res.json(attempt)
})

/**
 * Phát lại một bản ghi âm.
 *
 * Dùng chung cho cả học viên lẫn admin; `ownerId` khác null nghĩa là chỉ được
 * nghe bản ghi của đúng người đó.
 */
async function streamAudio(req, res, attemptId, ownerId) {
    const query = { _id: attemptId }
    if (ownerId) query.student = ownerId

    const attempt = await PracticeAttempt.findOne(query).select('audioPath audioFormat').lean()
    if (!attempt || !attempt.audioPath) {
        res.status(404)
        throw new Error('Không tìm thấy bản ghi âm.')
    }

    // Chặn đi ra khỏi thư mục storage/ bằng đường dẫn kiểu "../../etc/passwd".
    const absolutePath = resolveStoragePath(attempt.audioPath)
    if (!absolutePath || !fs.existsSync(absolutePath)) {
        res.status(404)
        throw new Error('File ghi âm không còn trên máy chủ.')
    }

    res.setHeader('Content-Type', attempt.audioFormat === 'm4a' ? 'audio/mp4' : 'audio/wav')
    // Giọng nói học viên là dữ liệu cá nhân — không để proxy hay trình duyệt
    // nào giữ lại bản sao.
    res.setHeader('Cache-Control', 'private, no-store')
    fs.createReadStream(absolutePath).pipe(res)
}

/** GET /api/lesson-attempts/recordings/:attemptId — học viên nghe lại giọng MÌNH. */
const getMyRecording = asyncHandler(async function getMyRecording(req, res) {
    await streamAudio(req, res, req.params.attemptId, req.student._id)
})

// ---------- phía quản trị ----------

/** GET /api/students/:id/lesson-attempts */
const listStudentLessonAttempts = asyncHandler(async function listStudentLessonAttempts(req, res) {
    const student = await Student.findById(req.params.id).select('name phone email')
    if (!student) {
        res.status(404)
        throw new Error('Không tìm thấy học viên.')
    }

    const { page = 1, limit = 20 } = req.query
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20))

    const query = { student: student._id }
    const [rows, total, facets] = await Promise.all([
        LessonAttempt.find(query)
            .select(LIST_FIELDS)
            .sort({ activityAt: -1, _id: -1 })
            .skip((pageNum - 1) * limitNum)
            .limit(limitNum)
            .lean(),
        LessonAttempt.countDocuments(query),
        historyFacets(student._id),
    ])

    res.json({
        student,
        // Cùng "lần thứ mấy" và cùng số liệu tổng quan với màn của học viên —
        // giáo viên cần thấy em này học lại bài mấy lần mà không phải tự so
        // ngày giờ của các dòng trùng tên.
        data: await attachAttemptNumbers(student._id, rows),
        stats: facets.stats,
        pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    })
})

/** GET /api/students/:id/lesson-attempts/:attemptId */
const getStudentLessonAttempt = asyncHandler(async function getStudentLessonAttempt(req, res) {
    const attempt = await LessonAttempt.findOne({
        _id: req.params.attemptId,
        student: req.params.id,
    })
        .select('-progress')
        .lean()
    if (!attempt) {
        res.status(404)
        throw new Error('Không tìm thấy lượt học này.')
    }
    res.json(attempt)
})

/** GET /api/students/:id/recordings/:attemptId — admin nghe bản ghi của học viên. */
const getStudentRecording = asyncHandler(async function getStudentRecording(req, res) {
    await streamAudio(req, res, req.params.attemptId, req.params.id)
})

module.exports = {
    createLessonAttempt,
    getCurrentAttempt,
    saveCurrentAttempt,
    discardCurrentAttempt,
    listMyLessonAttempts,
    getMyLessonAttempt,
    getMyRecording,
    listStudentLessonAttempts,
    getStudentLessonAttempt,
    getStudentRecording,
}
