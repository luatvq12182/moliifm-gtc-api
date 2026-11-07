const mongoose = require('mongoose')
const MaterialCourse = require('../models/MaterialCourse')
const MaterialDeck = require('../models/MaterialDeck')
const MaterialVideo = require('../models/MaterialVideo')
const MaterialVideoProgress = require('../models/MaterialVideoProgress')
const MaterialExercise = require('../models/MaterialExercise')
const MaterialExerciseAttempt = require('../models/MaterialExerciseAttempt')
const asyncHandler = require('../utils/asyncHandler')
const { sendPage } = require('./materialAdminController')
const { sendVideoThumb } = require('../lib/youtube')
const { addSegments, isWatchComplete } = require('../lib/watchCoverage')
const { studentSections, countItems, gradeAuto, sentenceItems } = require('../lib/exercise')
const { gradeSentences, isAiConfigured } = require('../lib/aiGrader')

/**
 * "HỌC LIỆU KHOÁ HỌC" — phía học viên: xem slide và video bài giảng của khoá
 * được cấp.
 *
 * MỌI ĐƯỜNG ĐỀU KIỂM QUYỀN Ở MÁY CHỦ (Student.materialAccess), kể cả ảnh từng
 * trang — giao diện ẩn khoá chưa có quyền là chưa đủ, ai biết đường dẫn ảnh
 * cũng phải bị chặn.
 *
 * Học viên chỉ thấy khoá đã xuất bản VÀ được cấp quyền; bộ slide đã xuất bản
 * VÀ đã chuyển đổi xong; video đã xuất bản. Mã YouTube chỉ trả ở trang xem
 * từng video (getMyVideo) — danh sách không lộ link.
 */

const hasAccess = (student, courseId) =>
    (student.materialAccess || []).some((id) => String(id) === String(courseId))

function noAccess(res) {
    res.status(403)
    const err = new Error('Bạn chưa được cấp quyền xem học liệu này. Vui lòng liên hệ trung tâm.')
    // Mã riêng, KHÁC ACCOUNT_LOCKED: giao diện chỉ báo, không đăng xuất.
    err.appCode = 'MATERIAL_NO_ACCESS'
    return err
}

const visibleDecks = (courseId) =>
    MaterialDeck.find({ courseId, status: 'published', conversion: 'ready' }).sort({ order: 1, createdAt: 1 })

const visibleVideos = (courseId) => MaterialVideo.find({ courseId, status: 'published' }).sort({ order: 1, createdAt: 1 })

/**
 * Tiến độ xem một video — % tính theo thời lượng ĐÃ THỰC SỰ PHÁT (không theo
 * chỗ xa nhất: tua tới cuối không tính). `withSegments` kèm các đoạn đã xem
 * để trình phát tô lên thanh tua.
 */
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

/** Tóm tắt điểm một lượt làm bài (cho danh sách). */
function attemptSummary(a) {
    if (!a) return null
    return { autoCorrect: a.autoCorrect, autoTotal: a.autoTotal, ai: { status: a.ai?.status, passed: a.ai?.passed || 0, total: a.ai?.total || 0 }, createdAt: a.createdAt }
}

/** Kết quả đầy đủ một lượt làm bài: đề (kèm đáp án, lời giải), câu trả lời, chấm. */
const attemptView = (a) => ({
    _id: a._id,
    createdAt: a.createdAt,
    sections: a.snapshot,
    answers: a.answers,
    results: a.results,
    autoCorrect: a.autoCorrect,
    autoTotal: a.autoTotal,
    ai: { status: a.ai?.status, passed: a.ai?.passed || 0, total: a.ai?.total || 0, error: a.ai?.error || '' },
})

async function countBy(Model, match) {
    const rows = await Model.aggregate([{ $match: match }, { $group: { _id: '$courseId', n: { $sum: 1 } } }])
    return new Map(rows.map((c) => [String(c._id), c.n]))
}

/** GET /api/materials/courses — chỉ những khoá học viên được xem. */
const listMyCourses = asyncHandler(async function listMyCourses(req, res) {
    const ids = req.student.materialAccess || []
    const courses = await MaterialCourse.find({ _id: { $in: ids }, status: 'published' })
        .sort({ order: 1, createdAt: 1 })
        .lean()
    const courseIds = courses.map((c) => c._id)
    const [deckCounts, videoCounts] = await Promise.all([
        countBy(MaterialDeck, { courseId: { $in: courseIds }, status: 'published', conversion: 'ready' }),
        countBy(MaterialVideo, { courseId: { $in: courseIds }, status: 'published' }),
    ])
    res.json(
        courses.map((c) => ({
            _id: c._id,
            name: c.name,
            slug: c.slug,
            description: c.description,
            thumbnail: c.thumbnail,
            deckCount: deckCounts.get(String(c._id)) || 0,
            videoCount: videoCounts.get(String(c._id)) || 0,
        }))
    )
})

/** GET /api/materials/courses/:slug — khoá + danh sách bộ slide + danh sách video (kèm % đã xem). */
const getMyCourse = asyncHandler(async function getMyCourse(req, res) {
    const course = await MaterialCourse.findOne({ slug: req.params.slug, status: 'published' }).lean()
    if (!course) {
        res.status(404)
        throw new Error('Không tìm thấy khoá học liệu này.')
    }
    if (!hasAccess(req.student, course._id)) throw noAccess(res)
    const [decks, videos, progress, exercise] = await Promise.all([
        visibleDecks(course._id).lean(),
        visibleVideos(course._id).lean(),
        MaterialVideoProgress.find({ student: req.student._id, courseId: course._id }).lean(),
        exerciseSummary(req.student._id, course._id),
    ])
    const progressOf = new Map(progress.map((p) => [String(p.video), p]))
    res.json({
        course: { _id: course._id, name: course.name, slug: course.slug, description: course.description },
        decks: decks.map((d) => ({
            _id: d._id,
            title: d.title,
            description: d.description,
            pageCount: d.pages.length,
            version: d.version,
            updatedAt: d.updatedAt,
        })),
        videos: videos.map((v) => ({
            _id: v._id,
            title: v.title,
            description: v.description,
            durationSec: v.durationSec,
            hasThumb: Boolean(v.thumbFile),
            group: v.group === 'curriculum' ? 'curriculum' : 'supplement',
            progress: progressView(progressOf.get(String(v._id)), v.durationSec),
        })),
        exercise,
    })
})

/** Bộ slide học viên được xem, hoặc ném lỗi 404/403. */
async function loadVisibleDeck(req, res) {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        res.status(404)
        throw new Error('Không tìm thấy bộ slide.')
    }
    const deck = await MaterialDeck.findOne({ _id: req.params.id, status: 'published', conversion: 'ready' }).lean()
    const course = deck && (await MaterialCourse.findOne({ _id: deck.courseId, status: 'published' }).lean())
    if (!deck || !course) {
        res.status(404)
        throw new Error('Không tìm thấy bộ slide.')
    }
    if (!hasAccess(req.student, course._id)) throw noAccess(res)
    return { deck, course }
}

/** GET /api/materials/decks/:id — thông tin để dựng trình xem (số trang, tỉ lệ). */
const getMyDeck = asyncHandler(async function getMyDeck(req, res) {
    const { deck, course } = await loadVisibleDeck(req, res)
    res.json({
        _id: deck._id,
        title: deck.title,
        description: deck.description,
        version: deck.version,
        course: { name: course.name, slug: course.slug },
        pages: deck.pages.map((p) => ({ width: p.width, height: p.height })),
    })
})

/** GET /api/materials/decks/:id/pages/:n[?thumb=1] — ảnh một trang (n đếm từ 1). */
const getMyDeckPage = asyncHandler(async function getMyDeckPage(req, res) {
    const { deck } = await loadVisibleDeck(req, res)
    await sendPage(res, deck, req.params.n, { thumb: req.query.thumb === '1' })
})

// ---------- video bài giảng ----------

/** Video học viên được xem, hoặc ném lỗi 404/403. */
async function loadVisibleVideo(req, res) {
    const video = mongoose.Types.ObjectId.isValid(req.params.id)
        ? await MaterialVideo.findOne({ _id: req.params.id, status: 'published' }).lean()
        : null
    const course = video && (await MaterialCourse.findOne({ _id: video.courseId, status: 'published' }).lean())
    if (!video || !course) {
        res.status(404)
        throw new Error('Không tìm thấy video.')
    }
    if (!hasAccess(req.student, course._id)) throw noAccess(res)
    return { video, course }
}

/** GET /api/materials/videos/:id — dữ liệu dựng trình phát + chỗ đang xem dở. */
const getMyVideo = asyncHandler(async function getMyVideo(req, res) {
    const { video, course } = await loadVisibleVideo(req, res)
    const [p, exercise] = await Promise.all([
        MaterialVideoProgress.findOne({ student: req.student._id, video: video._id }).lean(),
        exerciseSummary(req.student._id, course._id),
    ])
    res.json({
        _id: video._id,
        title: video.title,
        description: video.description,
        durationSec: video.durationSec,
        youtubeId: video.youtubeId,
        hasThumb: Boolean(video.thumbFile),
        course: { name: course.name, slug: course.slug },
        group: video.group === 'curriculum' ? 'curriculum' : 'supplement',
        progress: progressView(p, video.durationSec, { withSegments: true }),
        // Bài tập của KHOÁ (không phải của riêng video này).
        exercise,
    })
})

/** GET /api/materials/videos/:id/thumb */
const getMyVideoThumb = asyncHandler(async function getMyVideoThumb(req, res) {
    const { video } = await loadVisibleVideo(req, res)
    sendVideoThumb(res, video)
})

/**
 * PUT /api/materials/videos/:id/progress { position, duration, segments: [[từ, đến], ...] }
 *
 * Trình phát gửi định kỳ khi đang phát, và khi dừng / rời trang: chỗ đang
 * dừng + các đoạn VỪA PHÁT kể từ lần gửi trước. Máy chủ gộp vào các đoạn đã
 * xem, có giới hạn theo thời gian thực (lib/watchCoverage.js).
 */
const saveMyVideoProgress = asyncHandler(async function saveMyVideoProgress(req, res) {
    const { video, course } = await loadVisibleVideo(req, res)
    // Thời lượng: tin số đã lưu của video hơn số trình duyệt gửi lên.
    const duration = video.durationSec || Math.max(0, Number(req.body.duration) || 0)
    let position = Math.max(0, Number(req.body.position) || 0)
    if (duration) position = Math.min(position, duration)

    const filter = { student: req.student._id, video: video._id }
    let p = null
    // Đọc - cộng - ghi có kiểm tra: hai lần báo tới cùng lúc (vd. báo định kỳ
    // và báo lúc rời trang) thì lần sau đọc lại rồi cộng, không đè mất nhau.
    for (let attempt = 0; attempt < 4 && !p; attempt++) {
        const cur = await MaterialVideoProgress.findOne(filter).lean()
        const now = new Date()
        const elapsedSec = cur?.lastReportAt ? (now - cur.lastReportAt) / 1000 : null
        const next = addSegments(cur?.watched || [], req.body.segments, { duration, elapsedSec })
        const set = { position, duration, courseId: course._id, watched: next.watched, watchedSec: next.watchedSec, lastReportAt: now }
        if (!cur) {
            try {
                p = await MaterialVideoProgress.create({ ...filter, ...set })
            } catch (err) {
                if (err.code !== 11000) throw err // bản ghi vừa được lần báo khác tạo -> thử lại
            }
        } else {
            const r = await MaterialVideoProgress.updateOne({ _id: cur._id, lastReportAt: cur.lastReportAt ?? null }, { $set: set })
            if (r.modifiedCount === 1) p = { ...cur, ...set }
        }
    }
    if (!p) {
        res.status(409)
        throw new Error('Đang lưu tiến độ, thử lại sau.')
    }
    // YouTube không cho đọc được thời lượng lúc thêm -> lấy theo trình phát.
    if (!video.durationSec && duration) {
        await MaterialVideo.updateOne({ _id: video._id, durationSec: 0 }, { $set: { durationSec: Math.round(duration) } })
    }
    res.json(progressView(p, duration, { withSegments: true }))
})

// ---------- bài tập của khoá ----------
//
// MỖI KHOÁ MỘT BỘ BÀI TẬP. Học viên phải xem đủ TẤT CẢ video đang hiện thuộc
// nhóm "Video bài giảng bổ sung" của khoá (mỗi video >= 95% thời
// lượng thực sự phát) mới làm được. Nhóm "theo giáo trình" không tính.

const AI_DAILY_LIMIT = () => Number(process.env.AI_GRADE_DAILY_LIMIT) || 40
const SUBMIT_COOLDOWN_MS = 10 * 1000

/** Học viên đã xem đủ bao nhiêu video nhóm bổ sung của khoá. */
async function courseWatchState(studentId, courseId) {
    const [videos, progress] = await Promise.all([
        // Chỉ nhóm "Video bài giảng bổ sung"; video theo giáo trình
        // không tính vào điều kiện mở bài tập.
        MaterialVideo.find({ courseId, status: 'published', ...MaterialVideo.SUPPLEMENT_FILTER }).select('_id durationSec').lean(),
        MaterialVideoProgress.find({ student: studentId, courseId }).lean(),
    ])
    const progressOf = new Map(progress.map((p) => [String(p.video), p]))
    const watched = videos.filter((v) => progressView(progressOf.get(String(v._id)), v.durationSec)?.completed).length
    return { totalVideos: videos.length, watchedVideos: watched, unlocked: watched === videos.length }
}

/**
 * Tóm tắt bài tập của khoá cho trang khoá / trang video: số câu, đã xem đủ
 * bao nhiêu video, đã mở chưa, điểm lượt gần nhất. null = khoá chưa có bài tập.
 */
async function exerciseSummary(studentId, courseId) {
    const set = await MaterialExercise.findOne({ courseId }).select('sections').lean()
    const itemCount = countItems(set?.sections)
    if (!itemCount) return null
    const [watch, last] = await Promise.all([
        courseWatchState(studentId, courseId),
        MaterialExerciseAttempt.findOne({ student: studentId, courseId }).sort({ createdAt: -1 }).lean(),
    ])
    return { itemCount, ...watch, last: attemptSummary(last) }
}

/** Khoá học viên được xem (theo slug), hoặc 404 / 403. */
async function loadMyCourse(req, res) {
    const course = await MaterialCourse.findOne({ slug: req.params.slug, status: 'published' }).lean()
    if (!course) {
        res.status(404)
        throw new Error('Không tìm thấy khoá học liệu này.')
    }
    if (!hasAccess(req.student, course._id)) throw noAccess(res)
    return course
}

async function loadExercise(res, course) {
    const set = await MaterialExercise.findOne({ courseId: course._id }).lean()
    if (!set || countItems(set.sections) === 0) {
        res.status(404)
        const err = new Error('Khoá này chưa có bài tập.')
        err.appCode = 'NO_EXERCISE'
        throw err
    }
    return set
}

/** Chưa xem đủ mọi video của khoá -> 403 kèm số video đã xem đủ. */
async function requireAllWatched(req, res, course) {
    const watch = await courseWatchState(req.student._id, course._id)
    if (watch.unlocked) return watch
    res.status(403)
    const err = new Error(
        `Bạn cần xem hết các video bài giảng bổ sung của khoá rồi mới làm bài tập (đã xem đủ ${watch.watchedVideos}/${watch.totalVideos} video).`
    )
    err.appCode = 'VIDEO_NOT_WATCHED'
    throw err
}

/**
 * Cho AI chấm phần đặt câu của một lượt làm (ghi thẳng vào `attempt`).
 * Hết lượt trong ngày / chưa cài khoá AI / lỗi -> ghi trạng thái, không ném lỗi.
 */
async function runAiGrading(attempt, studentId) {
    const items = sentenceItems(attempt.snapshot, attempt.answers)
    attempt.ai = { status: 'none', passed: 0, total: items.length, model: '', error: '' }
    if (items.length === 0) return
    if (!isAiConfigured()) {
        attempt.ai.status = 'unavailable'
        return
    }
    const since = new Date(Date.now() - 24 * 3600 * 1000)
    const used = await MaterialExerciseAttempt.countDocuments({
        student: studentId,
        _id: { $ne: attempt._id },
        'ai.status': { $in: ['done', 'error'] },
        updatedAt: { $gte: since },
    })
    if (used >= AI_DAILY_LIMIT()) {
        attempt.ai.status = 'limited'
        return
    }
    try {
        const graded = await gradeSentences(items)
        const results = { ...(attempt.results || {}) }
        for (const it of items) results[it.id] = graded.items[it.id]
        attempt.results = results
        attempt.ai.status = 'done'
        attempt.ai.model = graded.model
        attempt.ai.passed = items.filter((it) => graded.items[it.id]?.verdict === 'dat').length
    } catch (err) {
        attempt.ai.status = 'error'
        attempt.ai.error = err.message.slice(0, 300)
    }
}

/**
 * GET /api/materials/courses/:slug/exercise
 *
 * Đề bài của khoá (KHÔNG kèm đáp án) + kết quả lượt làm gần nhất. Chưa xem
 * đủ mọi video của khoá -> 403 VIDEO_NOT_WATCHED.
 */
const getMyExercise = asyncHandler(async function getMyExercise(req, res) {
    const course = await loadMyCourse(req, res)
    const set = await loadExercise(res, course)
    await requireAllWatched(req, res, course)
    const [last, attemptCount] = await Promise.all([
        MaterialExerciseAttempt.findOne({ student: req.student._id, courseId: course._id }).sort({ createdAt: -1 }).lean(),
        MaterialExerciseAttempt.countDocuments({ student: req.student._id, courseId: course._id }),
    ])
    res.json({
        course: { _id: course._id, name: course.name, slug: course.slug },
        sections: studentSections(set.sections),
        lastAttempt: last ? attemptView(last) : null,
        attemptCount,
    })
})

/** POST /api/materials/courses/:slug/exercise/attempts { answers } — nộp bài, chấm ngay. */
const submitMyExercise = asyncHandler(async function submitMyExercise(req, res) {
    const course = await loadMyCourse(req, res)
    const set = await loadExercise(res, course)
    await requireAllWatched(req, res, course)
    const recent = await MaterialExerciseAttempt.findOne({
        student: req.student._id,
        courseId: course._id,
        createdAt: { $gte: new Date(Date.now() - SUBMIT_COOLDOWN_MS) },
    }).lean()
    if (recent) {
        res.status(429)
        throw new Error('Bạn vừa nộp bài. Đợi vài giây rồi nộp lại.')
    }

    const auto = gradeAuto(set.sections, req.body.answers || {})
    const attempt = new MaterialExerciseAttempt({
        student: req.student._id,
        courseId: course._id,
        version: set.version,
        snapshot: set.sections,
        answers: auto.answers,
        results: auto.results,
        autoCorrect: auto.correct,
        autoTotal: auto.total,
    })
    await runAiGrading(attempt, req.student._id)
    await attempt.save()
    res.status(201).json(attemptView(attempt.toObject()))
})

/** POST /api/materials/exercise-attempts/:id/regrade — chấm lại phần AI khi lần trước lỗi / hết lượt. */
const regradeMyAttempt = asyncHandler(async function regradeMyAttempt(req, res) {
    const attempt = mongoose.Types.ObjectId.isValid(req.params.id)
        ? await MaterialExerciseAttempt.findOne({ _id: req.params.id, student: req.student._id })
        : null
    if (!attempt) {
        res.status(404)
        throw new Error('Không tìm thấy bài làm.')
    }
    if (!['error', 'limited', 'unavailable'].includes(attempt.ai?.status)) {
        return res.json(attemptView(attempt.toObject()))
    }
    await runAiGrading(attempt, req.student._id)
    attempt.markModified('results')
    await attempt.save()
    res.json(attemptView(attempt.toObject()))
})

module.exports = {
    getMyExercise,
    submitMyExercise,
    regradeMyAttempt,
    listMyCourses,
    getMyCourse,
    getMyDeck,
    getMyDeckPage,
    getMyVideo,
    getMyVideoThumb,
    saveMyVideoProgress,
}
