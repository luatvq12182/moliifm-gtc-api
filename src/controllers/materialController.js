const mongoose = require('mongoose')
const MaterialCourse = require('../models/MaterialCourse')
const MaterialDeck = require('../models/MaterialDeck')
const asyncHandler = require('../utils/asyncHandler')
const { sendPage } = require('./materialAdminController')

/**
 * "HỌC LIỆU KHOÁ HỌC" — phía học viên: xem slide bài giảng của khoá được cấp.
 *
 * MỌI ĐƯỜNG ĐỀU KIỂM QUYỀN Ở MÁY CHỦ (Student.materialAccess), kể cả ảnh từng
 * trang — giao diện ẩn khoá chưa có quyền là chưa đủ, ai biết đường dẫn ảnh
 * cũng phải bị chặn.
 *
 * Học viên chỉ thấy khoá đã xuất bản VÀ được cấp quyền; bộ slide đã xuất bản
 * VÀ đã chuyển đổi xong.
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

/** GET /api/materials/courses — chỉ những khoá học viên được xem. */
const listMyCourses = asyncHandler(async function listMyCourses(req, res) {
    const ids = req.student.materialAccess || []
    const courses = await MaterialCourse.find({ _id: { $in: ids }, status: 'published' })
        .sort({ order: 1, createdAt: 1 })
        .lean()
    const counts = await MaterialDeck.aggregate([
        { $match: { courseId: { $in: courses.map((c) => c._id) }, status: 'published', conversion: 'ready' } },
        { $group: { _id: '$courseId', n: { $sum: 1 } } },
    ])
    const byId = new Map(counts.map((c) => [String(c._id), c.n]))
    res.json(
        courses.map((c) => ({
            _id: c._id,
            name: c.name,
            slug: c.slug,
            description: c.description,
            thumbnail: c.thumbnail,
            deckCount: byId.get(String(c._id)) || 0,
        }))
    )
})

/** GET /api/materials/courses/:slug — khoá + danh sách bộ slide. */
const getMyCourse = asyncHandler(async function getMyCourse(req, res) {
    const course = await MaterialCourse.findOne({ slug: req.params.slug, status: 'published' }).lean()
    if (!course) {
        res.status(404)
        throw new Error('Không tìm thấy khoá học liệu này.')
    }
    if (!hasAccess(req.student, course._id)) throw noAccess(res)
    const decks = await visibleDecks(course._id).lean()
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
        // Người đang xem — để giao diện đè watermark. Lấy từ máy chủ chứ không
        // từ dữ liệu lưu ở trình duyệt (sửa tay được, và có thể thiếu).
        viewer: { name: req.student.name, phone: req.student.phone },
    })
})

/** GET /api/materials/decks/:id/pages/:n[?thumb=1] — ảnh một trang (n đếm từ 1). */
const getMyDeckPage = asyncHandler(async function getMyDeckPage(req, res) {
    const { deck } = await loadVisibleDeck(req, res)
    await sendPage(res, deck, req.params.n, { thumb: req.query.thumb === '1' })
})

module.exports = { listMyCourses, getMyCourse, getMyDeck, getMyDeckPage }
