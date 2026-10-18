const mongoose = require('mongoose')
const fs = require('fs')
const LessonAttempt = require('../models/LessonAttempt')
const PracticeAttempt = require('../models/PracticeAttempt')
const Student = require('../models/Student')
const Lesson = require('../models/Lesson')
const Course = require('../models/Course')
const Curriculum = require('../models/Curriculum')
const asyncHandler = require('../utils/asyncHandler')
const { resolveStoragePath } = require('../lib/audioStorage')
const {
    groupLineAttempts,
    summarizeSpeaking,
    summarizeExercise,
} = require('../lib/lessonAttemptClaim')

// Nộp lại trong khoảng này coi như cùng một lần. Chống bấm đúp và chống việc
// client thử lại sau khi mạng chập — hai bản ghi cho một lần học là sai.
const DUPLICATE_WINDOW_MS = 60 * 1000

const LIST_FIELDS =
    'lesson lessonTitle lessonSlug curriculumSlug courseSlug courseName courseThumbnail curriculumName lessonOrder completedAt exercise speaking'

/**
 * Chỉ lấy đúng các trường đã biết từ dữ liệu client gửi lên.
 *
 * Cắt độ dài và chặn số lượng: đây là dữ liệu từ trình duyệt, và một bản ghi
 * phình to vì client gửi rác sẽ nằm lại trong cơ sở dữ liệu mãi mãi.
 */
function cleanAnswers(raw) {
    if (!Array.isArray(raw)) return []
    const text = (v, max) => String(v || '').slice(0, max)
    return raw.slice(0, 200).map((w) => ({
        correct: Boolean(w?.correct),
        type: text(w?.type, 100),
        question: text(w?.question, 500),
        pinyin: text(w?.pinyin, 500),
        yourAnswer: text(w?.yourAnswer, 500),
        yourPinyin: text(w?.yourPinyin, 500),
        correctAnswer: text(w?.correctAnswer, 500),
        correctPinyin: text(w?.correctPinyin, 500),
        correction: text(w?.correction, 500),
        correctionPinyin: text(w?.correctionPinyin, 500),
    }))
}

/**
 * Tra ngược tên khóa học và giáo trình từ bài học.
 *
 * CHỤP LẠI TÊN, không chỉ lưu id: khóa có thể bị đổi tên hoặc xóa, nhưng lịch
 * sử phải đọc được nguyên vẹn mà không cần join tới bản ghi có thể đã biến mất.
 *
 * Tra ở máy chủ chứ không nhận từ client vì trang học chỉ có slug trên URL —
 * nó không biết tên khóa, và bắt nó đi hỏi thêm một API nữa chỉ để gửi ngược
 * lên là thừa.
 *
 * Không tra được thì trả chuỗi rỗng, KHÔNG chặn: học viên đã học xong rồi,
 * không được mất bản ghi chỉ vì thiếu một cái nhãn.
 */
async function resolveCourseNames(lessonId) {
    try {
        const lesson = await Lesson.findById(lessonId).select('courseId').lean()
        if (!lesson) return { courseName: '', curriculumName: '' }
        const course = await Course.findById(lesson.courseId).select('name thumbnail curriculumId').lean()
        if (!course) return { courseName: '', curriculumName: '' }
        const curriculum = await Curriculum.findById(course.curriculumId).select('name').lean()
        return {
            courseName: course.name || '',
            courseThumbnail: course.thumbnail || '',
            curriculumName: (curriculum && curriculum.name) || '',
        }
    } catch (err) {
        console.error('[lessonAttempt] Không tra được tên khóa:', err.message)
        return { courseName: '', curriculumName: '' }
    }
}

/**
 * POST /api/lesson-attempts — học viên vừa hoàn thành trọn vẹn một bài.
 *
 * ĐIỂM BÀI TẬP lấy từ client; ĐIỂM LUYỆN NÓI dựng lại từ máy chủ.
 *
 * Bài tập của tính năng này được chấm ở phía trình duyệt nên máy chủ không
 * xác minh được — ghi cờ `exerciseScoreTrusted: false` để sau này ai dùng số
 * liệu đi đối chất thì biết. Điểm luyện nói thì ngược lại: nó nằm sẵn trong
 * PracticeAttempt do chính máy chủ ghi khi chấm, nên KHÔNG nhận từ client.
 */
const createLessonAttempt = asyncHandler(async function createLessonAttempt(req, res) {
    const studentId = req.student._id
    const { lessonId } = req.body

    if (!lessonId) {
        res.status(400)
        throw new Error('Thiếu mã bài học.')
    }

    // Chống nộp trùng. Client thử lại khi mạng chập là chuyện bình thường, và
    // hai bản ghi cho một lần học sẽ làm hỏng mọi phép đếm sau này.
    const recent = await LessonAttempt.findOne({
        student: studentId,
        lesson: lessonId,
        completedAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
    })
    if (recent) {
        res.status(200).json({ attempt: recent, duplicate: true })
        return
    }

    // Các lượt luyện nói CHƯA được giữ của đúng bài này.
    const provisional = await PracticeAttempt.find({
        student: studentId,
        lesson: lessonId,
        lessonAttempt: null,
    })
        .select('videoIndex lineIndex pronScore referenceText referencePinyin audioPath createdAt')
        .lean()

    // GIỮ TẤT. Học viên đọc một câu năm lần thì cả năm bản ghi và cả năm file
    // ghi âm đều thuộc về lượt học này.
    const spokenLines = groupLineAttempts(provisional)

    // Gộp dữ liệu client (bài tập) với dữ liệu máy chủ (luyện nói) theo video.
    const rawVideos = Array.isArray(req.body.videos) ? req.body.videos : []
    const videos = rawVideos.map((v, i) => {
        const index = Number.isFinite(Number(v?.index)) ? Number(v.index) : i
        const lines = spokenLines.filter((l) => l.videoIndex === index)
        const scores = lines.map((l) => l.score).filter((n) => typeof n === 'number')
        const total = Number(v?.exercise?.total)

        return {
            index,
            title: String(v?.title || '').slice(0, 200),
            exercise:
                Number.isFinite(total) && total > 0
                    ? {
                        correct: Math.max(0, Number(v.exercise.correct) || 0),
                        total,
                        answers: cleanAnswers(v.exercise.answers),
                    }
                    // Video không có bài tập -> null, KHÔNG phải 0/0. Hiện
                    // "0 điểm" cho phần vốn không chấm là báo sai cho học viên.
                    : { correct: null, total: null, answers: [] },
            speaking: {
                avgScore: scores.length
                    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
                    : null,
                lines,
            },
        }
    })

    const names = await resolveCourseNames(lessonId)

    const attempt = await LessonAttempt.create({
        student: studentId,
        lesson: lessonId,
        ...names,
        curriculumSlug: String(req.body.curriculumSlug || '').slice(0, 200),
        courseSlug: String(req.body.courseSlug || '').slice(0, 200),
        lessonSlug: String(req.body.lessonSlug || '').slice(0, 200),
        lessonTitle: String(req.body.lessonTitle || '').slice(0, 300),
        lessonOrder: Number(req.body.lessonOrder) || 0,
        completedAt: new Date(),
        exercise: summarizeExercise(videos),
        speaking: summarizeSpeaking(spokenLines),
        videos,
        exerciseScoreTrusted: false,
    })

    // THỨ TỰ CÓ CHỦ Ý: tạo bản ghi tổng hợp TRƯỚC, rồi mới đánh dấu giữ.
    //
    // Hỏng ở bước đánh dấu thì điểm số — thứ quan trọng nhất — đã an toàn, chỉ
    // mất ghi âm sau 24 giờ. Làm ngược lại (đánh dấu trước) mà hỏng ở bước tạo
    // thì có một đống bản ghi trỏ tới lượt học không tồn tại: không ai xem
    // được, mà tác vụ dọn cũng không đụng tới vì chúng không còn là "tạm".
    //
    // Hỏng ở đây TỰ LÀNH: thứ gì chưa được đánh dấu giữ thì vẫn là tạm, và
    // tác vụ dọn sẽ xử lý sau 24 giờ.
    try {
        if (provisional.length > 0) {
            await PracticeAttempt.updateMany(
                { _id: { $in: provisional.map((a) => a._id) } },
                { $set: { lessonAttempt: attempt._id } }
            )
        }
    } catch (err) {
        console.error('[lessonAttempt] Không đánh dấu được bản ghi luyện nói:', err.message)
    }

    res.status(201).json({ attempt, keptRecordings: provisional.length })
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
            { $sort: { completedAt: 1 } },
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
            { $match: { student: studentId } },
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
        .select('lesson completedAt')
        .sort({ completedAt: 1, _id: 1 })
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
        query.completedAt = { $gte: new Date(Date.now() - RANGES[range] * 24 * 3600 * 1000) }
    }

    const [rows, total, facets] = await Promise.all([
        LessonAttempt.find(query)
            .select(LIST_FIELDS)
            .sort({ completedAt: -1 })
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
    }).lean()

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
    const [data, total] = await Promise.all([
        LessonAttempt.find(query)
            .select(LIST_FIELDS)
            .sort({ completedAt: -1 })
            .skip((pageNum - 1) * limitNum)
            .limit(limitNum)
            .lean(),
        LessonAttempt.countDocuments(query),
    ])

    res.json({
        student,
        data,
        pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    })
})

/** GET /api/students/:id/lesson-attempts/:attemptId */
const getStudentLessonAttempt = asyncHandler(async function getStudentLessonAttempt(req, res) {
    const attempt = await LessonAttempt.findOne({
        _id: req.params.attemptId,
        student: req.params.id,
    }).lean()
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
    listMyLessonAttempts,
    getMyLessonAttempt,
    getMyRecording,
    listStudentLessonAttempts,
    getStudentLessonAttempt,
    getStudentRecording,
}
