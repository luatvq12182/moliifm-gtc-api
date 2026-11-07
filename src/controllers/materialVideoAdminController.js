const mongoose = require('mongoose')
const MaterialCourse = require('../models/MaterialCourse')
const MaterialVideo = require('../models/MaterialVideo')
const MaterialVideoProgress = require('../models/MaterialVideoProgress')
const asyncHandler = require('../utils/asyncHandler')
const {
    parseYouTubeId,
    parsePlaylistId,
    fetchPlaylist,
    fetchYouTubeInfo,
    saveYouTubeThumb,
    removeVideoThumb,
    sendVideoThumb,
} = require('../lib/youtube')

/**
 * QUẢN TRỊ "VIDEO BÀI GIẢNG" của khoá học liệu: dán link YouTube (từng link),
 * sắp xếp, ẩn/hiện, đổi tên, xoá. Quyền xem dùng chung với slide của khoá
 * (Student.materialAccess) — không cấp riêng.
 */

const isId = (v) => Boolean(v) && mongoose.Types.ObjectId.isValid(String(v))
const text = (v, max) => String(v ?? '').trim().slice(0, max)

const videoView = (v) => ({
    _id: v._id,
    courseId: v.courseId,
    title: v.title,
    description: v.description,
    order: v.order,
    status: v.status,
    group: v.group === 'curriculum' ? 'curriculum' : 'supplement',
    youtubeId: v.youtubeId,
    youtubeUrl: v.youtubeUrl,
    durationSec: v.durationSec,
    hasThumb: Boolean(v.thumbFile),
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
})

async function loadVideo(req, res) {
    const video = isId(req.params.id) ? await MaterialVideo.findById(req.params.id) : null
    if (!video) {
        res.status(404)
        throw new Error('Không tìm thấy video.')
    }
    return video
}

/** Mã YouTube từ link admin dán, hoặc 400. */
function youtubeIdOf(url, res) {
    const id = parseYouTubeId(url)
    if (!id) {
        res.status(400)
        throw new Error('Link không phải video YouTube. Dán link dạng youtube.com/watch?v=… hoặc youtu.be/…')
    }
    return id
}

/** Đọc thông tin video; lỗi (video riêng tư, sai link…) -> 400 kèm hướng dẫn. */
async function readInfo(id, res) {
    try {
        return await fetchYouTubeInfo(id)
    } catch (err) {
        res.status(400)
        throw err
    }
}

/** GET /api/admin/materials/videos?courseId= */
const listVideos = asyncHandler(async function listVideos(req, res) {
    if (!isId(req.query.courseId)) {
        res.status(400)
        throw new Error('Thiếu mã khoá học liệu.')
    }
    const videos = await MaterialVideo.find({ courseId: req.query.courseId }).sort({ order: 1, createdAt: 1 }).lean()
    await retryMissingThumbs(videos)
    res.json(videos.map(videoView))
})

// Video vừa đăng lên YouTube thường chưa có ảnh bìa ngay -> lúc thêm vào site
// lấy không được. Mỗi lần admin mở danh sách thì thử lấy lại (mỗi video tối
// đa 10 phút một lần, để trang không chậm vì gọi YouTube liên tục).
const thumbTriedAt = new Map()
async function retryMissingThumbs(videos) {
    const now = Date.now()
    const todo = videos.filter((v) => !v.thumbFile && now - (thumbTriedAt.get(String(v._id)) || 0) > 10 * 60 * 1000).slice(0, 5)
    await Promise.all(
        todo.map(async (v) => {
            thumbTriedAt.set(String(v._id), now)
            const file = await saveYouTubeThumb(v._id, v.youtubeId)
            if (!file) return
            await MaterialVideo.updateOne({ _id: v._id }, { $set: { thumbFile: file } })
            v.thumbFile = file
        })
    )
}

/**
 * POST /api/admin/materials/videos { courseId, url, title?, description?, status?, group? }
 *
 * Đọc ngay tên + thời lượng từ YouTube (vài giây) để báo lỗi tại chỗ nếu video
 * đang để Riêng tư hay link sai. Không đặt tên -> lấy tên video trên YouTube.
 */
const createVideo = asyncHandler(async function createVideo(req, res) {
    const course = isId(req.body.courseId) ? await MaterialCourse.findById(req.body.courseId) : null
    if (!course) {
        res.status(400)
        throw new Error('Không tìm thấy khoá học liệu.')
    }
    const youtubeId = youtubeIdOf(req.body.url, res)
    if (await MaterialVideo.exists({ courseId: course._id, youtubeId })) {
        res.status(400)
        throw new Error('Video này đã có trong khoá rồi.')
    }
    const info = await readInfo(youtubeId, res)

    const last = await MaterialVideo.findOne({ courseId: course._id }).sort({ order: -1 }).select('order').lean()
    const video = await MaterialVideo.create({
        courseId: course._id,
        title: text(req.body.title, 200) || info.title,
        description: text(req.body.description, 2000),
        status: req.body.status === 'published' ? 'published' : 'draft',
        group: req.body.group === 'curriculum' ? 'curriculum' : 'supplement',
        order: (last ? Number(last.order) || 0 : 0) + 1,
        youtubeId,
        youtubeUrl: text(req.body.url, 500),
        durationSec: info.durationSec,
    })
    video.thumbFile = await saveYouTubeThumb(video._id, youtubeId)
    if (video.thumbFile) await video.save()
    res.status(201).json(videoView(video))
})

/**
 * POST /api/admin/materials/videos/playlist { courseId, url, group?, status? }
 *
 * Nhập cả danh sách phát YouTube vào một mục video của khoá, đúng thứ tự trong
 * danh sách. Bỏ qua video đã có trong khoá (nhập lại sau khi danh sách có thêm
 * video thì chỉ thêm phần mới) và video riêng tư / đã xoá.
 */
const importPlaylist = asyncHandler(async function importPlaylist(req, res) {
    const course = isId(req.body.courseId) ? await MaterialCourse.findById(req.body.courseId) : null
    if (!course) {
        res.status(400)
        throw new Error('Không tìm thấy khoá học liệu.')
    }
    const listId = parsePlaylistId(req.body.url)
    if (!listId) {
        res.status(400)
        throw new Error('Link không có danh sách phát YouTube (cần dạng youtube.com/playlist?list=…).')
    }
    let playlist
    try {
        playlist = await fetchPlaylist(listId)
    } catch (err) {
        res.status(400)
        throw err
    }

    const existing = new Set((await MaterialVideo.find({ courseId: course._id }).select('youtubeId').lean()).map((v) => v.youtubeId))
    const last = await MaterialVideo.findOne({ courseId: course._id }).sort({ order: -1 }).select('order').lean()
    let order = last ? Number(last.order) || 0 : 0
    const group = req.body.group === 'curriculum' ? 'curriculum' : 'supplement'
    const status = req.body.status === 'published' ? 'published' : 'draft'
    const created = []
    const skipped = []
    for (const it of playlist.items.slice(0, 200)) {
        if (it.unavailable) {
            skipped.push({ title: it.title || it.id, reason: 'riêng tư / đã xoá' })
            continue
        }
        if (existing.has(it.id)) {
            skipped.push({ title: it.title || it.id, reason: 'đã có trong khoá' })
            continue
        }
        existing.add(it.id)
        created.push(
            await MaterialVideo.create({
                courseId: course._id,
                title: (it.title || 'Video').slice(0, 200),
                status,
                group,
                order: (order += 1),
                youtubeId: it.id,
                youtubeUrl: `https://www.youtube.com/watch?v=${it.id}&list=${listId}`,
                durationSec: it.durationSec || 0,
            })
        )
    }
    // Ảnh bìa: tải song song vài cái một lúc.
    for (let i = 0; i < created.length; i += 4) {
        await Promise.all(
            created.slice(i, i + 4).map(async (v) => {
                const file = await saveYouTubeThumb(v._id, v.youtubeId)
                if (file) await MaterialVideo.updateOne({ _id: v._id }, { $set: { thumbFile: file } })
            })
        )
    }
    res.status(201).json({ playlistTitle: playlist.title, created: created.length, skipped, hasMore: playlist.hasMore })
})

/**
 * PUT /api/admin/materials/videos/:id { title?, description?, status?, group?, url?, durationSec? }
 *
 * Đổi `url` = thay video khác (vd. đăng lại bản sửa) — giữ nguyên tên, thứ tự,
 * nhưng xoá tiến độ xem cũ vì không còn khớp video mới.
 */
const updateVideo = asyncHandler(async function updateVideo(req, res) {
    const video = await loadVideo(req, res)
    if (req.body.title !== undefined) {
        const title = text(req.body.title, 200)
        if (!title) {
            res.status(400)
            throw new Error('Vui lòng nhập tên video.')
        }
        video.title = title
    }
    if (req.body.description !== undefined) video.description = text(req.body.description, 2000)
    if (req.body.status !== undefined) video.status = req.body.status === 'published' ? 'published' : 'draft'
    if (req.body.group !== undefined) video.group = req.body.group === 'curriculum' ? 'curriculum' : 'supplement'
    // Trình phát ở trang admin (Xem trước) báo thời lượng khi máy chủ không đọc được.
    if (Number(req.body.durationSec) > 0) video.durationSec = Math.round(Number(req.body.durationSec))

    if (req.body.url !== undefined) {
        const youtubeId = youtubeIdOf(req.body.url, res)
        if (youtubeId !== video.youtubeId) {
            const info = await readInfo(youtubeId, res)
            video.youtubeId = youtubeId
            video.durationSec = info.durationSec
            video.thumbFile = await saveYouTubeThumb(video._id, youtubeId)
            await MaterialVideoProgress.deleteMany({ video: video._id })
        }
        video.youtubeUrl = text(req.body.url, 500)
    }
    await video.save()
    res.json(videoView(video))
})

/** PUT /api/admin/materials/videos/reorder { courseId, ids: [...] } */
const reorderVideos = asyncHandler(async function reorderVideos(req, res) {
    const { courseId, ids } = req.body
    if (!isId(courseId) || !Array.isArray(ids)) {
        res.status(400)
        throw new Error('Dữ liệu sắp xếp không hợp lệ.')
    }
    await Promise.all(
        ids.filter(isId).map((id, i) => MaterialVideo.updateOne({ _id: id, courseId }, { $set: { order: i + 1 } }))
    )
    res.json({ ok: true })
})

const deleteVideo = asyncHandler(async function deleteVideo(req, res) {
    const video = await loadVideo(req, res)
    await video.deleteOne()
    await MaterialVideoProgress.deleteMany({ video: video._id })
    await removeVideoThumb(video._id)
    res.json({ deleted: true })
})

/** GET /api/admin/materials/videos/:id/thumb */
const getVideoThumb = asyncHandler(async function getVideoThumb(req, res) {
    const video = await loadVideo(req, res)
    sendVideoThumb(res, video)
})

/** Xoá hết video của một khoá (khi xoá khoá). */
async function removeCourseVideos(courseId) {
    const videos = await MaterialVideo.find({ courseId }).select('_id').lean()
    for (const v of videos) await removeVideoThumb(v._id)
    await MaterialVideoProgress.deleteMany({ courseId })
    await MaterialVideo.deleteMany({ courseId })
    return videos.length
}

module.exports = {
    listVideos,
    createVideo,
    updateVideo,
    reorderVideos,
    deleteVideo,
    getVideoThumb,
    importPlaylist,
    removeCourseVideos,
}
