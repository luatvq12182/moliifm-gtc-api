const mongoose = require('mongoose')
const ExamLevel = require('../models/ExamLevel')
const ExamVideo = require('../models/ExamVideo')
const ExamVideoProgress = require('../models/ExamVideoProgress')
const ExamTest = require('../models/ExamTest')
const ExamAttempt = require('../models/ExamAttempt')
const { removeTestFiles } = require('../lib/examTest')
const Student = require('../models/Student')
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
 * QUẢN TRỊ "LUYỆN THI HSK 3.0 CÙNG MOLII FM": cấp thi, video hướng dẫn kỹ năng
 * thi, cấp quyền học viên (Student.examAccess). Đề thi thử ở giai đoạn sau.
 */

const isId = (v) => Boolean(v) && mongoose.Types.ObjectId.isValid(String(v))
const text = (v, max) => String(v ?? '').trim().slice(0, max)
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function notFound(res, msg) {
    res.status(404)
    return new Error(msg)
}

async function loadLevel(id, res) {
    const level = isId(id) ? await ExamLevel.findById(id) : null
    if (!level) throw notFound(res, 'Không tìm thấy cấp thi.')
    return level
}

// ---------- cấp thi ----------

function levelFields(body, res, { partial = false } = {}) {
    const out = {}
    if (!partial || body.name !== undefined) out.name = text(body.name, 200)
    if (!partial || body.slug !== undefined) out.slug = text(body.slug, 100).toLowerCase()
    if (body.description !== undefined) out.description = text(body.description, 2000)
    if (body.thumbnail !== undefined) out.thumbnail = text(body.thumbnail, 500)
    if (body.order !== undefined) out.order = Number(body.order) || 0
    if (body.status !== undefined) out.status = body.status === 'published' ? 'published' : 'draft'
    if ((!partial || out.name !== undefined) && !out.name) {
        res.status(400)
        throw new Error('Vui lòng nhập tên cấp thi.')
    }
    if ((!partial || out.slug !== undefined) && !SLUG_RE.test(out.slug || '')) {
        res.status(400)
        throw new Error('Slug chỉ gồm chữ thường không dấu, số và dấu gạch ngang (vd. hsk3).')
    }
    return out
}

function slugTaken(err, res) {
    if (err?.code === 11000) {
        res.status(409)
        return new Error('Slug này đã có cấp thi khác dùng.')
    }
    return err
}

/** GET /api/admin/exam/levels — kèm số video và số học viên được vào. */
const listLevels = asyncHandler(async function listLevels(req, res) {
    const levels = await ExamLevel.find().sort({ order: 1, createdAt: 1 }).lean()
    const ids = levels.map((l) => l._id)
    const [videoCounts, testCounts, accessCounts] = await Promise.all([
        ExamVideo.aggregate([{ $match: { levelId: { $in: ids } } }, { $group: { _id: '$levelId', n: { $sum: 1 } } }]),
        ExamTest.aggregate([{ $match: { levelId: { $in: ids } } }, { $group: { _id: '$levelId', n: { $sum: 1 } } }]),
        Student.aggregate([
            { $match: { examAccess: { $in: ids } } },
            { $unwind: '$examAccess' },
            { $match: { examAccess: { $in: ids } } },
            { $group: { _id: '$examAccess', n: { $sum: 1 } } },
        ]),
    ])
    const videos = new Map(videoCounts.map((d) => [String(d._id), d.n]))
    const tests = new Map(testCounts.map((d) => [String(d._id), d.n]))
    const access = new Map(accessCounts.map((d) => [String(d._id), d.n]))
    res.json(
        levels.map((l) => ({
            ...l,
            videoCount: videos.get(String(l._id)) || 0,
            testCount: tests.get(String(l._id)) || 0,
            studentCount: access.get(String(l._id)) || 0,
        }))
    )
})

const createLevel = asyncHandler(async function createLevel(req, res) {
    try {
        res.status(201).json(await ExamLevel.create(levelFields(req.body, res)))
    } catch (err) {
        throw slugTaken(err, res)
    }
})

const updateLevel = asyncHandler(async function updateLevel(req, res) {
    const level = await loadLevel(req.params.id, res)
    Object.assign(level, levelFields(req.body, res, { partial: true }))
    try {
        await level.save()
    } catch (err) {
        throw slugTaken(err, res)
    }
    res.json(level)
})

/**
 * DELETE /api/admin/exam/levels/:id[?force=1]
 * Cấp còn video / học viên thì hỏi lại (409) — xoá là xoá luôn video, tiến độ
 * xem và quyền của học viên với cấp đó.
 */
const deleteLevel = asyncHandler(async function deleteLevel(req, res) {
    const level = await loadLevel(req.params.id, res)
    const [videoCount, testCount, students] = await Promise.all([
        ExamVideo.countDocuments({ levelId: level._id }),
        ExamTest.countDocuments({ levelId: level._id }),
        Student.countDocuments({ examAccess: level._id }),
    ])
    if ((videoCount || testCount || students) && req.query.force !== '1') {
        res.status(409)
        const err = new Error(`Cấp này đang có ${videoCount} video, ${testCount} đề và ${students} học viên được vào. Xoá cấp sẽ xoá hết.`)
        err.appCode = 'EXAM_LEVEL_IN_USE'
        throw err
    }
    const videos = await ExamVideo.find({ levelId: level._id }).select('_id').lean()
    for (const v of videos) await removeVideoThumb(v._id)
    await ExamVideoProgress.deleteMany({ levelId: level._id })
    await ExamVideo.deleteMany({ levelId: level._id })
    const tests = await ExamTest.find({ levelId: level._id }).select('_id').lean()
    for (const t of tests) await removeTestFiles(t._id)
    await ExamTest.deleteMany({ levelId: level._id })
    await ExamAttempt.deleteMany({ levelId: level._id })
    await Student.updateMany({ examAccess: level._id }, { $pull: { examAccess: level._id } })
    await level.deleteOne()
    res.json({ deleted: true, videos: videoCount, tests: testCount, students })
})

// ---------- video hướng dẫn kỹ năng thi ----------

const videoView = (v) => ({
    _id: v._id,
    levelId: v.levelId,
    title: v.title,
    description: v.description,
    order: v.order,
    status: v.status,
    youtubeId: v.youtubeId,
    youtubeUrl: v.youtubeUrl,
    durationSec: v.durationSec,
    hasThumb: Boolean(v.thumbFile),
    createdAt: v.createdAt,
})

async function loadVideo(req, res) {
    const video = isId(req.params.id) ? await ExamVideo.findById(req.params.id) : null
    if (!video) throw notFound(res, 'Không tìm thấy video.')
    return video
}

async function nextOrder(levelId) {
    const last = await ExamVideo.findOne({ levelId }).sort({ order: -1 }).select('order').lean()
    return last ? Number(last.order) || 0 : 0
}

// Video vừa đăng YouTube thường chưa có ảnh bìa -> mở danh sách thì thử lấy lại
// (mỗi video tối đa 10 phút một lần).
const thumbTriedAt = new Map()
async function retryMissingThumbs(videos) {
    const now = Date.now()
    const todo = videos.filter((v) => !v.thumbFile && now - (thumbTriedAt.get(String(v._id)) || 0) > 10 * 60 * 1000).slice(0, 5)
    await Promise.all(
        todo.map(async (v) => {
            thumbTriedAt.set(String(v._id), now)
            const file = await saveYouTubeThumb(v._id, v.youtubeId)
            if (!file) return
            await ExamVideo.updateOne({ _id: v._id }, { $set: { thumbFile: file } })
            v.thumbFile = file
        })
    )
}

/** GET /api/admin/exam/videos?levelId= */
const listVideos = asyncHandler(async function listVideos(req, res) {
    if (!isId(req.query.levelId)) {
        res.status(400)
        throw new Error('Thiếu mã cấp thi.')
    }
    const videos = await ExamVideo.find({ levelId: req.query.levelId }).sort({ order: 1, createdAt: 1 }).lean()
    await retryMissingThumbs(videos)
    res.json(videos.map(videoView))
})

/** POST /api/admin/exam/videos { levelId, url, title?, description?, status? } */
const createVideo = asyncHandler(async function createVideo(req, res) {
    const level = await loadLevel(req.body.levelId, res)
    const youtubeId = parseYouTubeId(req.body.url)
    if (!youtubeId) {
        res.status(400)
        throw new Error('Link không phải video YouTube. Dán link dạng youtube.com/watch?v=… hoặc youtu.be/…')
    }
    if (await ExamVideo.exists({ levelId: level._id, youtubeId })) {
        res.status(400)
        throw new Error('Video này đã có trong cấp này rồi.')
    }
    let info
    try {
        info = await fetchYouTubeInfo(youtubeId)
    } catch (err) {
        res.status(400)
        throw err
    }
    const video = await ExamVideo.create({
        levelId: level._id,
        title: text(req.body.title, 200) || info.title,
        description: text(req.body.description, 2000),
        status: req.body.status === 'published' ? 'published' : 'draft',
        order: (await nextOrder(level._id)) + 1,
        youtubeId,
        youtubeUrl: text(req.body.url, 500),
        durationSec: info.durationSec,
    })
    video.thumbFile = await saveYouTubeThumb(video._id, youtubeId)
    if (video.thumbFile) await video.save()
    res.status(201).json(videoView(video))
})

/**
 * POST /api/admin/exam/videos/playlist { levelId, url, status? }
 * Nhập cả danh sách phát, đúng thứ tự; bỏ qua video đã có / riêng tư / đã xoá.
 */
const importPlaylist = asyncHandler(async function importPlaylist(req, res) {
    const level = await loadLevel(req.body.levelId, res)
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
    const existing = new Set((await ExamVideo.find({ levelId: level._id }).select('youtubeId').lean()).map((v) => v.youtubeId))
    let order = await nextOrder(level._id)
    const status = req.body.status === 'published' ? 'published' : 'draft'
    const created = []
    const skipped = []
    for (const it of playlist.items.slice(0, 200)) {
        if (it.unavailable) {
            skipped.push({ title: it.title || it.id, reason: 'riêng tư / đã xoá' })
            continue
        }
        if (existing.has(it.id)) {
            skipped.push({ title: it.title || it.id, reason: 'đã có trong cấp này' })
            continue
        }
        existing.add(it.id)
        created.push(
            await ExamVideo.create({
                levelId: level._id,
                title: (it.title || 'Video').slice(0, 200),
                status,
                order: (order += 1),
                youtubeId: it.id,
                youtubeUrl: `https://www.youtube.com/watch?v=${it.id}&list=${listId}`,
                durationSec: it.durationSec || 0,
            })
        )
    }
    for (let i = 0; i < created.length; i += 4) {
        await Promise.all(
            created.slice(i, i + 4).map(async (v) => {
                const file = await saveYouTubeThumb(v._id, v.youtubeId)
                if (file) await ExamVideo.updateOne({ _id: v._id }, { $set: { thumbFile: file } })
            })
        )
    }
    res.status(201).json({ playlistTitle: playlist.title, created: created.length, skipped, hasMore: playlist.hasMore })
})

/** PUT /api/admin/exam/videos/:id { title?, description?, status?, url?, durationSec? } */
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
    if (Number(req.body.durationSec) > 0) video.durationSec = Math.round(Number(req.body.durationSec))
    if (req.body.url !== undefined) {
        const youtubeId = parseYouTubeId(req.body.url)
        if (!youtubeId) {
            res.status(400)
            throw new Error('Link không phải video YouTube.')
        }
        if (youtubeId !== video.youtubeId) {
            let info
            try {
                info = await fetchYouTubeInfo(youtubeId)
            } catch (err) {
                res.status(400)
                throw err
            }
            video.youtubeId = youtubeId
            video.durationSec = info.durationSec
            video.thumbFile = await saveYouTubeThumb(video._id, youtubeId)
            await ExamVideoProgress.deleteMany({ video: video._id })
        }
        video.youtubeUrl = text(req.body.url, 500)
    }
    await video.save()
    res.json(videoView(video))
})

/** PUT /api/admin/exam/videos/reorder { levelId, ids } */
const reorderVideos = asyncHandler(async function reorderVideos(req, res) {
    const { levelId, ids } = req.body
    if (!isId(levelId) || !Array.isArray(ids)) {
        res.status(400)
        throw new Error('Dữ liệu sắp xếp không hợp lệ.')
    }
    await Promise.all(ids.filter(isId).map((id, i) => ExamVideo.updateOne({ _id: id, levelId }, { $set: { order: i + 1 } })))
    res.json({ ok: true })
})

const deleteVideo = asyncHandler(async function deleteVideo(req, res) {
    const video = await loadVideo(req, res)
    await video.deleteOne()
    await ExamVideoProgress.deleteMany({ video: video._id })
    await removeVideoThumb(video._id)
    res.json({ deleted: true })
})

const getVideoThumb = asyncHandler(async function getVideoThumb(req, res) {
    sendVideoThumb(res, await loadVideo(req, res))
})

// ---------- cấp quyền ----------

/** GET /api/admin/exam/access?search=&levelId=&scope=has|missing&page=&limit= */
const listAccess = asyncHandler(async function listAccess(req, res) {
    const { levelId, scope = 'all', search = '' } = req.query
    if (levelId && !isId(levelId)) {
        res.status(400)
        throw new Error('Mã cấp thi không hợp lệ.')
    }
    const query = {}
    if (levelId) {
        const id = new mongoose.Types.ObjectId(levelId)
        if (scope === 'missing') query.examAccess = { $ne: id }
        else if (scope === 'has') query.examAccess = id
    }
    const q = String(search).trim()
    if (q) {
        const re = new RegExp(escapeRegex(q), 'i')
        query.$or = [{ name: re }, { phone: re }, { email: re }]
    }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20))
    const [rows, total] = await Promise.all([
        Student.find(query).select('name phone email status examAccess').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        Student.countDocuments(query),
    ])
    res.json({
        data: rows.map((s) => ({ _id: s._id, name: s.name, phone: s.phone, email: s.email, status: s.status, access: (s.examAccess || []).map(String) })),
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    })
})

/** PATCH /api/admin/exam/access { studentIds, levelId, action: grant|revoke } */
const updateAccess = asyncHandler(async function updateAccess(req, res) {
    const { studentIds, levelId, action } = req.body
    if (!['grant', 'revoke'].includes(action)) {
        res.status(400)
        throw new Error('Thao tác không hợp lệ.')
    }
    if (!Array.isArray(studentIds) || studentIds.length === 0) {
        res.status(400)
        throw new Error('Chưa chọn học viên nào.')
    }
    if (studentIds.length > 500) {
        res.status(400)
        throw new Error('Mỗi lần chỉ xử lý tối đa 500 học viên. Hãy lọc nhỏ lại.')
    }
    const level = await loadLevel(levelId, res)
    const ids = studentIds.filter(isId)
    // Đếm TRƯỚC số người thực sự đổi (modifiedCount tính cả bản ghi chỉ đổi updatedAt).
    const changed = await Student.countDocuments(
        action === 'grant' ? { _id: { $in: ids }, examAccess: { $ne: level._id } } : { _id: { $in: ids }, examAccess: level._id }
    )
    await Student.updateMany(
        { _id: { $in: ids } },
        action === 'grant' ? { $addToSet: { examAccess: level._id } } : { $pull: { examAccess: level._id } }
    )
    res.json({
        changed,
        message: action === 'grant' ? `Đã cho ${changed} học viên vào "${level.name}".` : `Đã thu hồi "${level.name}" của ${changed} học viên.`,
    })
})

module.exports = {
    listLevels,
    createLevel,
    updateLevel,
    deleteLevel,
    listVideos,
    createVideo,
    importPlaylist,
    updateVideo,
    reorderVideos,
    deleteVideo,
    getVideoThumb,
    listAccess,
    updateAccess,
}
