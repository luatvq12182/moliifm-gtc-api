const mongoose = require('mongoose')
const ExamLevel = require('../models/ExamLevel')
const ExamVideo = require('../models/ExamVideo')
const ExamVideoProgress = require('../models/ExamVideoProgress')
const ExamTest = require('../models/ExamTest')
const ExamAttempt = require('../models/ExamAttempt')
const fs = require('fs')
const asyncHandler = require('../utils/asyncHandler')
const { sendVideoThumb } = require('../lib/youtube')
const { addSegments, isWatchComplete } = require('../lib/watchCoverage')
const { normalizePhone } = require('../lib/phone')
const { testPagePath, testAudioPath } = require('../lib/examTest')
const {
    SECTION_LABEL,
    EARLY_FINISH,
    buildSections,
    sectionEnd,
    advance,
    finishEarly,
    editableNumbers,
    cleanAnswer,
    signAudioToken,
    verifyAudioToken,
} = require('../lib/examAttempt')
const { onSubmitted } = require('../lib/examGrading')

/**
 * "LUYỆN THI HSK 3.0 CÙNG MOLII FM" — phía học viên: chọn cấp thi được cấp,
 * xem video hướng dẫn kỹ năng thi, làm đề luyện thi bấm giờ.
 *
 * MỌI ĐƯỜNG ĐỀU KIỂM QUYỀN Ở MÁY CHỦ (Student.examAccess). Học viên chỉ thấy
 * cấp đã xuất bản VÀ được cấp quyền; video đã xuất bản. Mã YouTube chỉ trả ở
 * trang xem từng video — danh sách không lộ link.
 */

const hasAccess = (student, levelId) => (student.examAccess || []).some((id) => String(id) === String(levelId))

function noAccess(res) {
    res.status(403)
    const err = new Error('Bạn chưa được cấp quyền vào phần luyện thi này. Vui lòng liên hệ trung tâm.')
    // Mã riêng, KHÁC ACCOUNT_LOCKED: giao diện chỉ báo, không đăng xuất.
    err.appCode = 'EXAM_NO_ACCESS'
    return err
}

/** Tiến độ xem — % theo thời lượng ĐÃ THỰC SỰ PHÁT (xem materialController). */
function progressView(p, durationSec, { withSegments = false } = {}) {
    if (!p) return null
    const duration = durationSec || p.duration || 0
    const watchedSec = p.watchedSec || 0
    const completed = isWatchComplete(watchedSec, duration)
    const percent = completed ? 100 : duration ? Math.min(99, Math.floor((watchedSec / duration) * 100)) : 0
    const view = { position: Math.round(p.position), percent, completed, watchedSec: Math.round(watchedSec) }
    if (withSegments) view.watched = p.watched || []
    return view
}

const visibleVideos = (levelId) => ExamVideo.find({ levelId, status: 'published' }).sort({ order: 1, createdAt: 1 })

/** GET /api/exam/levels — chỉ những cấp học viên được vào. */
const listMyLevels = asyncHandler(async function listMyLevels(req, res) {
    const levels = await ExamLevel.find({ _id: { $in: req.student.examAccess || [] }, status: 'published' })
        .sort({ order: 1, createdAt: 1 })
        .lean()
    const rows = await ExamVideo.aggregate([
        { $match: { levelId: { $in: levels.map((l) => l._id) }, status: 'published' } },
        { $group: { _id: '$levelId', n: { $sum: 1 } } },
    ])
    const videoCount = new Map(rows.map((r) => [String(r._id), r.n]))
    const testRows = await ExamTest.aggregate([
        { $match: { levelId: { $in: levels.map((l) => l._id) }, status: 'published' } },
        { $group: { _id: '$levelId', n: { $sum: 1 } } },
    ])
    const testCount = new Map(testRows.map((r) => [String(r._id), r.n]))
    res.json(
        levels.map((l) => ({
            _id: l._id,
            name: l.name,
            slug: l.slug,
            description: l.description,
            thumbnail: l.thumbnail,
            videoCount: videoCount.get(String(l._id)) || 0,
            testCount: testCount.get(String(l._id)) || 0,
        }))
    )
})

/** GET /api/exam/levels/:slug — cấp thi + video hướng dẫn (kèm % đã xem). */
const getMyLevel = asyncHandler(async function getMyLevel(req, res) {
    const level = await ExamLevel.findOne({ slug: String(req.params.slug || '').toLowerCase(), status: 'published' }).lean()
    if (!level) {
        res.status(404)
        throw new Error('Không tìm thấy cấp thi này.')
    }
    if (!hasAccess(req.student, level._id)) throw noAccess(res)
    const [videos, progress, tests] = await Promise.all([
        visibleVideos(level._id).lean(),
        ExamVideoProgress.find({ student: req.student._id, levelId: level._id }).lean(),
        myTests(req.student._id, level._id),
    ])
    const progressOf = new Map(progress.map((p) => [String(p.video), p]))
    res.json({
        level: { _id: level._id, name: level.name, slug: level.slug, description: level.description },
        videos: videos.map((v) => ({
            _id: v._id,
            title: v.title,
            description: v.description,
            durationSec: v.durationSec,
            hasThumb: Boolean(v.thumbFile),
            progress: progressView(progressOf.get(String(v._id)), v.durationSec),
        })),
        tests,
    })
})

/** Video học viên được xem, hoặc ném lỗi 404/403. */
async function loadVisibleVideo(req, res) {
    const video = mongoose.Types.ObjectId.isValid(req.params.id)
        ? await ExamVideo.findOne({ _id: req.params.id, status: 'published' }).lean()
        : null
    const level = video && (await ExamLevel.findOne({ _id: video.levelId, status: 'published' }).lean())
    if (!video || !level) {
        res.status(404)
        throw new Error('Không tìm thấy video.')
    }
    if (!hasAccess(req.student, level._id)) throw noAccess(res)
    return { video, level }
}

/** GET /api/exam/videos/:id — dữ liệu dựng trình phát + chỗ đang xem dở. */
const getMyVideo = asyncHandler(async function getMyVideo(req, res) {
    const { video, level } = await loadVisibleVideo(req, res)
    const p = await ExamVideoProgress.findOne({ student: req.student._id, video: video._id }).lean()
    res.json({
        _id: video._id,
        title: video.title,
        description: video.description,
        durationSec: video.durationSec,
        youtubeId: video.youtubeId,
        hasThumb: Boolean(video.thumbFile),
        level: { name: level.name, slug: level.slug },
        progress: progressView(p, video.durationSec, { withSegments: true }),
    })
})

/** GET /api/exam/videos/:id/thumb */
const getMyVideoThumb = asyncHandler(async function getMyVideoThumb(req, res) {
    const { video } = await loadVisibleVideo(req, res)
    sendVideoThumb(res, video)
})

/** PUT /api/exam/videos/:id/progress { position, duration, segments } — như video học liệu. */
const saveMyVideoProgress = asyncHandler(async function saveMyVideoProgress(req, res) {
    const { video, level } = await loadVisibleVideo(req, res)
    const duration = video.durationSec || Math.max(0, Number(req.body.duration) || 0)
    let position = Math.max(0, Number(req.body.position) || 0)
    if (duration) position = Math.min(position, duration)

    const filter = { student: req.student._id, video: video._id }
    let p = null
    // Đọc - cộng - ghi có kiểm tra để hai lần báo cùng lúc không đè mất nhau.
    for (let attempt = 0; attempt < 4 && !p; attempt++) {
        const cur = await ExamVideoProgress.findOne(filter).lean()
        const now = new Date()
        const elapsedSec = cur?.lastReportAt ? (now - cur.lastReportAt) / 1000 : null
        const next = addSegments(cur?.watched || [], req.body.segments, { duration, elapsedSec })
        const set = { position, duration, levelId: level._id, watched: next.watched, watchedSec: next.watchedSec, lastReportAt: now }
        if (!cur) {
            try {
                p = await ExamVideoProgress.create({ ...filter, ...set })
            } catch (err) {
                if (err.code !== 11000) throw err
            }
        } else {
            const r = await ExamVideoProgress.updateOne({ _id: cur._id, lastReportAt: cur.lastReportAt ?? null }, { $set: set })
            if (r.modifiedCount === 1) p = { ...cur, ...set }
        }
    }
    if (!p) {
        res.status(409)
        throw new Error('Đang lưu tiến độ, thử lại sau.')
    }
    if (!video.durationSec && duration) {
        await ExamVideo.updateOne({ _id: video._id, durationSec: 0 }, { $set: { durationSec: Math.round(duration) } })
    }
    res.json(progressView(p, duration, { withSegments: true }))
})

// ---------- đề luyện thi ----------

/** Điểm tóm tắt của một bài đã nộp (null = đang chấm lần đầu). */
const scoreSummary = (r) => (r ? { total: r.total, max: r.max, passed: r.passed, aiStatus: r.ai?.status || 'none' } : { total: null })

const testDurationSec = (t) => buildSections(t).reduce((n, x) => n + x.durationSec, 0)
const questionCount = (groups) => (groups || []).reduce((n, g) => n + g.to - g.from + 1, 0)

/** Đề đã xuất bản của một cấp + lượt làm của học viên (đang làm dở / đã nộp mấy lần). */
async function myTests(studentId, levelId) {
    const tests = await ExamTest.find({ levelId, status: 'published' }).sort({ order: 1, createdAt: 1 }).lean()
    const attempts = await ExamAttempt.find({ student: studentId, testId: { $in: tests.map((t) => t._id) } })
        .select('testId status submittedAt result.total result.max result.passed result.ai.status')
        .sort({ createdAt: -1 })
        .lean()
    return tests.map((t) => {
        const mine = attempts.filter((a) => String(a.testId) === String(t._id))
        const open = mine.find((a) => a.status === 'in_progress')
        const done = mine.filter((a) => a.status === 'submitted')
        return {
            _id: t._id,
            title: t.title,
            questionCount: questionCount(t.groups),
            durationSec: testDurationSec(t),
            inProgressId: open?._id || null,
            submittedCount: done.length,
            lastSubmittedAt: done[0]?.submittedAt || null,
            last: done[0] ? { _id: done[0]._id, ...scoreSummary(done[0].result) } : null,
        }
    })
}

/** Đề học viên được làm (đã xuất bản, cấp đã xuất bản và được cấp quyền), hoặc ném 404/403. */
async function loadVisibleTest(req, res) {
    const test = mongoose.Types.ObjectId.isValid(req.params.id)
        ? await ExamTest.findOne({ _id: req.params.id, status: 'published' }).lean()
        : null
    const level = test && (await ExamLevel.findOne({ _id: test.levelId, status: 'published' }).lean())
    if (!test || !level) {
        res.status(404)
        throw new Error('Không tìm thấy đề này.')
    }
    if (!hasAccess(req.student, level._id)) throw noAccess(res)
    return { test, level }
}

/** GET /api/exam/tests/:id — trang giới thiệu đề trước khi vào thi. */
const getMyTest = asyncHandler(async function getMyTest(req, res) {
    const { test, level } = await loadVisibleTest(req, res)
    let open = await ExamAttempt.findOne({ student: req.student._id, testId: test._id, status: 'in_progress' }).lean()
    if (open) open = await advance(open)
    const history = await ExamAttempt.find({ student: req.student._id, testId: test._id, status: 'submitted' })
        .select('submittedAt result.total result.max result.passed result.ai.status')
        .sort({ submittedAt: -1 })
        .lean()
    const submittedCount = history.length
    res.json({
        _id: test._id,
        title: test.title,
        level: { name: level.name, slug: level.slug },
        questionCount: questionCount(test.groups),
        sections: buildSections(test).map((x) => ({
            id: x.id,
            label: SECTION_LABEL[x.id],
            durationSec: x.durationSec,
            questionCount: questionCount(test.groups.filter((g) => g.section === x.id)),
        })),
        inProgressId: open?.status === 'in_progress' ? open._id : null,
        submittedCount,
        history: history.slice(0, 20).map((a) => ({ _id: a._id, submittedAt: a.submittedAt, ...scoreSummary(a.result) })),
        // Điền sẵn ô thông tin thí sinh.
        candidate: { name: req.student.name || '', phone: req.student.phone || '' },
    })
})

/**
 * POST /api/exam/tests/:id/attempts { name, phone, classCode }
 * Vào thi. Đang có lượt làm dở thì trả lượt đó (không tạo lượt mới).
 */
const startAttempt = asyncHandler(async function startAttempt(req, res) {
    const { test } = await loadVisibleTest(req, res)
    let open = await ExamAttempt.findOne({ student: req.student._id, testId: test._id, status: 'in_progress' }).lean()
    if (open) open = await advance(open)
    if (open?.status === 'in_progress') return res.json({ _id: open._id, resumed: true })

    const name = String(req.body.name || '').trim().slice(0, 100)
    const phone = normalizePhone(req.body.phone)
    const classCode = String(req.body.classCode || '').trim().slice(0, 30)
    if (!name) {
        res.status(400)
        throw new Error('Vui lòng nhập họ tên.')
    }
    if (!phone) {
        res.status(400)
        throw new Error('Số điện thoại không hợp lệ.')
    }
    const sections = buildSections(test)
    if (!sections.length || (sections[0].id === 'listening' && !test.audio?.file)) {
        res.status(409)
        throw new Error('Đề này đang được cập nhật, bạn quay lại sau nhé.')
    }
    const keywords = {}
    for (const it of test.items || []) if (it.keyword) keywords[it.no] = it.keyword
    const now = new Date()
    const attempt = await ExamAttempt.create({
        student: req.student._id,
        testId: test._id,
        levelId: test.levelId,
        candidate: { name, phone, classCode },
        snapshot: {
            title: test.title,
            groups: test.groups.map((g) => ({
                section: g.section,
                type: g.type,
                from: g.from,
                to: g.to,
                options: g.options || '',
                title: g.title || '',
                page: g.page || 0,
                points: g.points || 0,
                verdictPoints: g.verdictPoints || {},
            })),
            keywords,
            audioVersion: test.audio?.version || 0,
        },
        sections,
        sectionIndex: 0,
        sectionStartedAt: now,
        startedAt: now,
    })
    res.status(201).json({ _id: attempt._id, resumed: false })
})

/** Lượt làm của chính học viên này (còn quyền vào cấp), đã cho chạy tới hiện tại. */
async function loadMyAttempt(req, res) {
    const attempt = mongoose.Types.ObjectId.isValid(req.params.id) ? await ExamAttempt.findById(req.params.id).lean() : null
    if (!attempt || String(attempt.student) !== String(req.student._id)) {
        res.status(404)
        throw new Error('Không tìm thấy bài làm này.')
    }
    if (!hasAccess(req.student, attempt.levelId)) throw noAccess(res)
    return advance(attempt)
}

/** Các trang đề đang hiện (theo thứ tự), kèm vị trí thật trong file. */
const visiblePages = (test) =>
    (test?.pdf?.conversion === 'ready' ? test.pdf.pages : []).map((p, index) => ({ ...p, index })).filter((p) => !p.hidden)

async function attemptView(a) {
    const [test, level] = await Promise.all([
        ExamTest.findById(a.testId).select('pdf levelId').lean(),
        ExamLevel.findById(a.levelId).select('name slug').lean(),
    ])
    const cur = a.sections[a.sectionIndex]
    const inProgress = a.status === 'in_progress'
    const pages = visiblePages(test)
    // Trang admin đặt (đếm cả trang ẩn) -> số thứ tự trong các trang đang hiện;
    // trang đó bị ẩn thì lấy trang hiện ngay sau nó.
    const visibleNo = (page) => {
        if (!page) return 0
        const i = pages.findIndex((p) => p.index >= page - 1)
        return i >= 0 ? i + 1 : 0
    }
    return {
        _id: a._id,
        status: a.status,
        title: a.snapshot.title,
        level: { name: level?.name || '', slug: level?.slug || '' },
        candidate: a.candidate,
        sections: a.sections.map((x) => ({ id: x.id, label: SECTION_LABEL[x.id], durationSec: x.durationSec })),
        sectionIndex: a.sectionIndex,
        section: inProgress ? cur?.id : null,
        sectionStartedAt: a.sectionStartedAt,
        sectionEndsAt: inProgress ? sectionEnd(a) : null,
        serverNow: new Date(),
        canFinishEarly: inProgress && EARLY_FINISH.includes(cur?.id),
        groups: a.snapshot.groups.map((g) => ({ section: g.section, type: g.type, from: g.from, to: g.to, options: g.options, title: g.title, page: visibleNo(g.page) })),
        keywords: a.snapshot.keywords || {},
        answers: a.answers || {},
        pages: pages.map((p, i) => ({ n: i + 1, width: p.width, height: p.height })),
        // Vé nghe chỉ có trong phần nghe; hết phần nghe là hết hạn.
        audio: inProgress && cur?.id === 'listening' ? { path: `/exam/audio/${signAudioToken(a)}`, durationSec: cur.durationSec } : null,
        submittedAt: a.submittedAt,
        submitReason: a.submitReason,
        // Chỉ có sau khi nộp — lúc đó mới được thấy đáp án đúng.
        result: a.status === 'submitted' ? a.result || null : null,
        canRegrade: a.status === 'submitted' && ['error', 'limited'].includes(a.result?.ai?.status),
    }
}

/** GET /api/exam/attempts/:id — trạng thái bài làm (đồng hồ máy chủ). */
const getMyAttempt = asyncHandler(async function getMyAttempt(req, res) {
    res.json(await attemptView(await loadMyAttempt(req, res)))
})

/**
 * PUT /api/exam/attempts/:id/answers { answers: { "1": "B", ... } }
 * Chỉ nhận câu của phần đang làm (câu phần khác bị bỏ, trả lại trong `rejected`).
 */
const saveMyAnswers = asyncHandler(async function saveMyAnswers(req, res) {
    const attempt = await loadMyAttempt(req, res)
    const input = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {}
    const allowed = editableNumbers(attempt)
    const groupOf = new Map()
    for (const g of attempt.snapshot.groups) for (let n = g.from; n <= g.to; n++) groupOf.set(n, g)
    const set = {}
    const rejected = []
    for (const [key, value] of Object.entries(input).slice(0, 300)) {
        const no = Number(key)
        const g = groupOf.get(no)
        const clean = g && allowed.has(no) ? cleanAnswer(g, value) : null
        if (clean === null) rejected.push(no)
        else set[`answers.${no}`] = clean
    }
    if (Object.keys(set).length) {
        await ExamAttempt.updateOne({ _id: attempt._id, status: 'in_progress' }, { $set: set })
    }
    res.json({
        saved: Object.keys(set).length,
        rejected,
        status: attempt.status,
        section: attempt.status === 'in_progress' ? attempt.sections[attempt.sectionIndex]?.id : null,
        sectionEndsAt: attempt.status === 'in_progress' ? sectionEnd(attempt) : null,
        serverNow: new Date(),
    })
})

/** POST /api/exam/attempts/:id/finish { section } — nộp sớm phần đọc / viết. */
const finishMySection = asyncHandler(async function finishMySection(req, res) {
    const attempt = await loadMyAttempt(req, res)
    res.json(await attemptView(await finishEarly(attempt, String(req.body?.section || ''))))
})

/** POST /api/exam/attempts/:id/regrade — cho AI chấm lại phần đặt câu khi lần trước lỗi / hết lượt trong ngày. */
const regradeMyAttempt = asyncHandler(async function regradeMyAttempt(req, res) {
    const attempt = await loadMyAttempt(req, res)
    if (attempt.status === 'submitted' && ['error', 'limited'].includes(attempt.result?.ai?.status)) {
        await ExamAttempt.updateOne({ _id: attempt._id }, { $set: { 'result.ai': { status: 'pending', startedAt: new Date() } } })
        onSubmitted(attempt._id)
    }
    res.json(await attemptView(await ExamAttempt.findById(attempt._id).lean()))
})

/** GET /api/exam/attempts/:id/pages/:n — trang đề thứ n (đếm theo trang đang hiện). */
const getMyAttemptPage = asyncHandler(async function getMyAttemptPage(req, res) {
    const attempt = await loadMyAttempt(req, res)
    const test = await ExamTest.findById(attempt.testId).select('pdf').lean()
    const page = visiblePages(test)[Number.parseInt(req.params.n, 10) - 1]
    const abs = page ? testPagePath(test, page.index, { thumb: req.query.thumb === '1' }) : null
    if (!abs || !fs.existsSync(abs)) {
        res.status(404)
        throw new Error('Không tìm thấy trang này.')
    }
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    fs.createReadStream(abs).pipe(res)
})

/**
 * GET /api/exam/audio/:token — file nghe, KHÔNG cần đăng nhập (thẻ <audio>
 * không gửi được token) mà dùng vé ký riêng cho một lượt làm. Chỉ phát được
 * trong lúc lượt làm đó đang ở phần nghe.
 */
const streamExamAudio = asyncHandler(async function streamExamAudio(req, res) {
    const claim = verifyAudioToken(req.params.token)
    let attempt = claim && mongoose.Types.ObjectId.isValid(claim.a) ? await ExamAttempt.findById(claim.a).lean() : null
    if (attempt) attempt = await advance(attempt)
    if (!attempt || attempt.status !== 'in_progress' || attempt.sections[attempt.sectionIndex]?.id !== 'listening') {
        res.status(403)
        throw new Error('Phần nghe đã kết thúc.')
    }
    const test = await ExamTest.findById(attempt.testId).select('audio').lean()
    const abs = test && testAudioPath(test)
    if (!abs || !fs.existsSync(abs)) {
        res.status(404)
        throw new Error('Không tìm thấy file nghe.')
    }
    res.sendFile(abs, { headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
})

module.exports = {
    getMyTest,
    startAttempt,
    getMyAttempt,
    saveMyAnswers,
    finishMySection,
    regradeMyAttempt,
    getMyAttemptPage,
    streamExamAudio,
    listMyLevels,
    getMyLevel,
    getMyVideo,
    getMyVideoThumb,
    saveMyVideoProgress,
}
