const mongoose = require('mongoose')
const MaterialCourse = require('../models/MaterialCourse')
const MaterialDeck = require('../models/MaterialDeck')
const MaterialVideo = require('../models/MaterialVideo')
const MaterialVideoProgress = require('../models/MaterialVideoProgress')
const asyncHandler = require('../utils/asyncHandler')
const { sendPage } = require('./materialAdminController')
const { sendVideoThumb } = require('../lib/youtube')

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

/** % đã xem một video (theo chỗ xa nhất từng xem tới). */
function progressView(p, durationSec) {
    if (!p) return null
    const duration = p.duration || durationSec || 0
    const percent = p.completed ? 100 : duration ? Math.min(100, Math.round((p.furthest / duration) * 100)) : 0
    return { position: Math.round(p.position), percent, completed: p.completed }
}

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
    const [decks, videos, progress] = await Promise.all([
        visibleDecks(course._id).lean(),
        visibleVideos(course._id).lean(),
        MaterialVideoProgress.find({ student: req.student._id, courseId: course._id }).lean(),
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
            progress: progressView(progressOf.get(String(v._id)), v.durationSec),
        })),
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
    const p = await MaterialVideoProgress.findOne({ student: req.student._id, video: video._id }).lean()
    res.json({
        _id: video._id,
        title: video.title,
        description: video.description,
        durationSec: video.durationSec,
        youtubeId: video.youtubeId,
        hasThumb: Boolean(video.thumbFile),
        course: { name: course.name, slug: course.slug },
        progress: progressView(p, video.durationSec),
    })
})

/** GET /api/materials/videos/:id/thumb */
const getMyVideoThumb = asyncHandler(async function getMyVideoThumb(req, res) {
    const { video } = await loadVisibleVideo(req, res)
    sendVideoThumb(res, video)
})

/**
 * PUT /api/materials/videos/:id/progress { position, duration, ended? }
 *
 * Trình phát gửi định kỳ khi đang phát, và khi dừng / rời trang. Xem tới 90%
 * (hoặc hết video) thì tính là đã xem xong.
 */
const saveMyVideoProgress = asyncHandler(async function saveMyVideoProgress(req, res) {
    const { video, course } = await loadVisibleVideo(req, res)
    const duration = Math.max(0, Number(req.body.duration) || 0) || video.durationSec || 0
    let position = Math.max(0, Number(req.body.position) || 0)
    if (duration) position = Math.min(position, duration)

    const filter = { student: req.student._id, video: video._id }
    const update = { $set: { position, duration, courseId: course._id }, $max: { furthest: position } }
    let p
    try {
        p = await MaterialVideoProgress.findOneAndUpdate(filter, update, { upsert: true, new: true })
    } catch (err) {
        // Hai lần lưu đầu tiên tới cùng lúc -> một lần tạo, lần kia cập nhật.
        if (err.code !== 11000) throw err
        p = await MaterialVideoProgress.findOneAndUpdate(filter, update, { new: true })
    }
    if (!p.completed && (req.body.ended || (duration && p.furthest >= duration * 0.9))) {
        p.completed = true
        await p.save()
    }
    // YouTube không cho đọc được thời lượng lúc thêm -> lấy theo trình phát.
    if (!video.durationSec && duration) {
        await MaterialVideo.updateOne({ _id: video._id, durationSec: 0 }, { $set: { durationSec: Math.round(duration) } })
    }
    res.json(progressView(p, video.durationSec))
})

module.exports = {
    listMyCourses,
    getMyCourse,
    getMyDeck,
    getMyDeckPage,
    getMyVideo,
    getMyVideoThumb,
    saveMyVideoProgress,
}
