const fs = require('fs')
const path = require('path')
const mongoose = require('mongoose')
const MaterialCourse = require('../models/MaterialCourse')
const MaterialDeck = require('../models/MaterialDeck')
const Student = require('../models/Student')
const asyncHandler = require('../utils/asyncHandler')
const uploadMaterial = require('../middleware/uploadMaterial')
const {
    deckDir,
    sourcePath,
    parseGoogleLink,
    listDriveFolder,
    pagePath,
    enqueueConversion,
    removeDeckFiles,
} = require('../lib/materialConvert')

/**
 * QUẢN TRỊ "HỌC LIỆU KHOÁ HỌC": khoá học liệu, bộ slide, cấp quyền học viên.
 *
 * Phần cấp quyền nằm ở đây chứ không ở studentController, để chức năng này tự
 * đứng được và không chồng lên các thay đổi khác đang làm ở màn học viên.
 */

const isId = (v) => Boolean(v) && mongoose.Types.ObjectId.isValid(String(v))
const text = (v, max) => String(v ?? '').trim().slice(0, max)
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Nhận file tải lên, đổi lỗi của multer (sai định dạng, quá dung lượng) thành
 * 400 kèm câu dễ hiểu. Để nguyên thì errorHandler trả 500 vì res.statusCode
 * lúc đó vẫn là 200.
 */
function receiveFile(req, res) {
    return new Promise((resolve, reject) => {
        uploadMaterial.single('file')(req, res, (err) => {
            if (!err) {
                // multer đọc tên file như latin1, nên tên tiếng Việt / chữ Hán ra
                // "BÃ i 1". Trình duyệt gửi UTF-8 — giải mã lại cho đúng.
                if (req.file) req.file.originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8')
                return resolve(req.file || null)
            }
            res.status(400)
            reject(
                err.code === 'LIMIT_FILE_SIZE'
                    ? new Error('File vượt quá 100MB. Hãy nén ảnh trong slide hoặc tách thành nhiều bộ.')
                    : err
            )
        })
    })
}

/** Chuyển file tạm vào thư mục của bộ slide, đúng version. */
async function placeSource(deck, file) {
    const ext = path.extname(file.originalname).slice(1).toLowerCase()
    await fs.promises.mkdir(deckDir(deck._id), { recursive: true })
    await fs.promises.rename(file.path, sourcePath(deck._id, deck.version, ext))
    deck.source = { originalName: text(file.originalname, 300), ext, bytes: file.size }
}

const discardTemp = (file) => file && fs.promises.unlink(file.path).catch(() => { })

// ---------- khoá học liệu ----------

function courseFields(body, res, { partial = false } = {}) {
    const out = {}
    if (!partial || body.name !== undefined) out.name = text(body.name, 200)
    if (!partial || body.slug !== undefined) out.slug = text(body.slug, 100).toLowerCase()
    if (body.description !== undefined) out.description = text(body.description, 2000)
    if (body.thumbnail !== undefined) out.thumbnail = text(body.thumbnail, 500)
    if (body.order !== undefined) out.order = Number(body.order) || 0
    if (body.status !== undefined) out.status = body.status === 'published' ? 'published' : 'draft'

    if ((!partial || out.name !== undefined) && !out.name) {
        res.status(400)
        throw new Error('Vui lòng nhập tên khoá.')
    }
    if ((!partial || out.slug !== undefined) && !SLUG_RE.test(out.slug || '')) {
        res.status(400)
        throw new Error('Slug chỉ gồm chữ thường không dấu, số và dấu gạch ngang (vd. hsk3).')
    }
    return out
}

/** GET /api/admin/materials/courses — kèm số bộ slide và số học viên được xem. */
const listCourses = asyncHandler(async function listCourses(req, res) {
    const courses = await MaterialCourse.find().sort({ order: 1, createdAt: 1 }).lean()
    const ids = courses.map((c) => c._id)
    const [deckCounts, accessCounts] = await Promise.all([
        MaterialDeck.aggregate([{ $match: { courseId: { $in: ids } } }, { $group: { _id: '$courseId', n: { $sum: 1 } } }]),
        Student.aggregate([
            { $match: { materialAccess: { $in: ids } } },
            { $unwind: '$materialAccess' },
            { $match: { materialAccess: { $in: ids } } },
            { $group: { _id: '$materialAccess', n: { $sum: 1 } } },
        ]),
    ])
    const decks = new Map(deckCounts.map((d) => [String(d._id), d.n]))
    const access = new Map(accessCounts.map((d) => [String(d._id), d.n]))
    res.json(
        courses.map((c) => ({
            ...c,
            deckCount: decks.get(String(c._id)) || 0,
            studentCount: access.get(String(c._id)) || 0,
        }))
    )
})

const createCourse = asyncHandler(async function createCourse(req, res) {
    const course = await MaterialCourse.create(courseFields(req.body, res))
    res.status(201).json(course)
})

const updateCourse = asyncHandler(async function updateCourse(req, res) {
    const course = await MaterialCourse.findById(req.params.id)
    if (!course) {
        res.status(404)
        throw new Error('Không tìm thấy khoá học liệu.')
    }
    Object.assign(course, courseFields(req.body, res, { partial: true }))
    await course.save()
    res.json(course)
})

/**
 * DELETE /api/admin/materials/courses/:id[?force=1]
 *
 * Khoá còn bộ slide thì phải xác nhận lại (409 kèm số lượng) — xoá khoá là
 * xoá luôn mọi bộ slide, file, và quyền của học viên với khoá đó.
 */
const deleteCourse = asyncHandler(async function deleteCourse(req, res) {
    const course = await MaterialCourse.findById(req.params.id)
    if (!course) {
        res.status(404)
        throw new Error('Không tìm thấy khoá học liệu.')
    }
    const decks = await MaterialDeck.find({ courseId: course._id }).select('_id').lean()
    const students = await Student.countDocuments({ materialAccess: course._id })
    if ((decks.length || students) && req.query.force !== '1') {
        res.status(409)
        const err = new Error(
            `Khoá này đang có ${decks.length} bộ slide và ${students} học viên được xem. Xoá khoá sẽ xoá hết.`
        )
        err.appCode = 'MATERIAL_COURSE_IN_USE'
        throw err
    }
    for (const d of decks) await removeDeckFiles(d._id)
    await MaterialDeck.deleteMany({ courseId: course._id })
    await Student.updateMany({ materialAccess: course._id }, { $pull: { materialAccess: course._id } })
    await course.deleteOne()
    res.json({ deleted: true, decks: decks.length, students })
})

// ---------- bộ slide ----------

const deckView = (d) => ({
    _id: d._id,
    courseId: d.courseId,
    title: d.title,
    description: d.description,
    order: d.order,
    status: d.status,
    source: d.source,
    conversion: d.conversion,
    conversionError: d.conversionError,
    version: d.version,
    pageCount: (d.pages || []).length,
    pages: (d.pages || []).map((p) => ({ width: p.width, height: p.height })),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
})

/** GET /api/admin/materials/decks?courseId= */
const listDecks = asyncHandler(async function listDecks(req, res) {
    if (!isId(req.query.courseId)) {
        res.status(400)
        throw new Error('Thiếu mã khoá học liệu.')
    }
    const decks = await MaterialDeck.find({ courseId: req.query.courseId }).sort({ order: 1, createdAt: 1 }).lean()
    res.json(decks.map(deckView))
})

const getDeck = asyncHandler(async function getDeck(req, res) {
    const deck = await MaterialDeck.findById(req.params.id).lean()
    if (!deck) {
        res.status(404)
        throw new Error('Không tìm thấy bộ slide.')
    }
    res.json(deckView(deck))
})

/**
 * POST /api/admin/materials/decks (multipart: file, courseId, title, description, status)
 *
 * Trả về ngay với trạng thái "đang chuyển"; việc chuyển sang ảnh chạy ngầm.
 * Giao diện hỏi lại trạng thái cho tới khi xong.
 */
const createDeck = asyncHandler(async function createDeck(req, res) {
    const file = await receiveFile(req, res)
    try {
        if (!file) {
            res.status(400)
            throw new Error('Chưa chọn file slide.')
        }
        const course = isId(req.body.courseId) ? await MaterialCourse.findById(req.body.courseId) : null
        if (!course) {
            res.status(400)
            throw new Error('Không tìm thấy khoá học liệu.')
        }
        // Tên bộ slide mặc định = tên file, bỏ đuôi — đỡ gõ lại cho giảng viên.
        const title =
            text(req.body.title, 200) || text(path.parse(file.originalname).name, 200) || 'Bộ slide'
        const last = await MaterialDeck.findOne({ courseId: course._id }).sort({ order: -1 }).select('order').lean()

        const deck = new MaterialDeck({
            courseId: course._id,
            title,
            description: text(req.body.description, 2000),
            status: req.body.status === 'published' ? 'published' : 'draft',
            order: (last ? Number(last.order) || 0 : 0) + 1,
            conversion: 'processing',
            version: 1,
        })
        await placeSource(deck, file)
        await deck.save()
        enqueueConversion(deck._id)
        res.status(201).json(deckView(deck))
    } catch (err) {
        await discardTemp(file)
        throw err
    }
})

/** POST /api/admin/materials/decks/:id/file — thay file mới cho bộ slide có sẵn. */
const replaceDeckFile = asyncHandler(async function replaceDeckFile(req, res) {
    const file = await receiveFile(req, res)
    try {
        if (!file) {
            res.status(400)
            throw new Error('Chưa chọn file slide.')
        }
        const deck = await MaterialDeck.findById(req.params.id)
        if (!deck) {
            res.status(404)
            throw new Error('Không tìm thấy bộ slide.')
        }
        // Version mới, và gỡ ảnh cũ NGAY: học viên không bao giờ thấy trang cũ
        // lẫn với trang mới. Bộ slide tạm không xem được cho tới khi chuyển xong.
        deck.version += 1
        deck.conversion = 'processing'
        deck.conversionError = ''
        deck.pages = []
        await placeSource(deck, file)
        await deck.save()
        enqueueConversion(deck._id)
        res.json(deckView(deck))
    } catch (err) {
        await discardTemp(file)
        throw err
    }
})

/**
 * POST /api/admin/materials/decks/google { courseId, url | urls, title, status }
 *
 * Thêm bộ slide từ link Google: bài trình bày Google Slides, hoặc FILE PDF /
 * PowerPoint để trên Google Drive. Máy chủ tự lấy file về rồi chuyển thành ảnh
 * như file tải lên — học viên KHÔNG BAO GIỜ thấy link Google, nên phân quyền
 * theo khoá và việc chặn tải về vẫn giữ nguyên. (Nhúng thẳng trình xem của
 * Google thì link lộ ra trang, ai có link cũng mở và tải được.)
 *
 * `urls` (mảng hoặc chuỗi nhiều dòng) để thêm cả loạt một lần — mỗi link một
 * bộ slide, theo đúng thứ tự dán. Link THƯ MỤC Drive công khai được bung ra
 * thành mọi file slide trong đó, sắp theo số bài. Có link nào sai thì KHÔNG
 * thêm gì và báo rõ dòng nào, để admin sửa rồi dán lại một lần (thêm một nửa
 * rồi dừng thì khó biết đã thêm tới đâu).
 *
 * Không đặt tên -> tên bộ slide lấy theo tên file Google khi tải về.
 */
const createGoogleDeck = asyncHandler(async function createGoogleDeck(req, res) {
    const raw = req.body.urls ?? req.body.url
    const lines = (Array.isArray(raw) ? raw : String(raw || '').split(/\r?\n/))
        .map((l) => String(l).trim())
        .filter(Boolean)
    if (lines.length === 0) {
        res.status(400)
        throw new Error('Chưa dán link nào.')
    }
    if (lines.length > 100) {
        res.status(400)
        throw new Error('Mỗi lần thêm tối đa 100 link.')
    }

    const parsed = lines.map((line, i) => ({ line, n: i + 1, link: parseGoogleLink(line) }))
    const bad = parsed.filter((x) => !x.link)
    if (bad.length) {
        res.status(400)
        throw new Error(
            `Link ở dòng ${bad.map((x) => x.n).join(', ')} không dùng được. ` +
            'Chỉ nhận link bài trình bày Google Slides, link file hoặc link thư mục trên Google Drive.'
        )
    }

    // Link THƯ MỤC -> bung ra từng file slide trong đó (sắp theo số bài).
    const links = []
    const skipped = []
    for (const x of parsed) {
        if (x.link.type !== 'folder') {
            links.push({ line: x.line, link: x.link })
            continue
        }
        let listing
        try {
            listing = await listDriveFolder(x.link.id)
        } catch (err) {
            res.status(400)
            throw new Error(parsed.length > 1 ? `Dòng ${x.n}: ${err.message}` : err.message)
        }
        if (listing.files.length === 0) {
            res.status(400)
            throw new Error(`Thư mục ở dòng ${x.n} không có file PDF / PowerPoint / Google Slides nào.`)
        }
        for (const f of listing.files) {
            links.push({
                line:
                    f.type === 'slides'
                        ? `https://docs.google.com/presentation/d/${f.id}/edit`
                        : `https://drive.google.com/file/d/${f.id}/view`,
                link: { type: f.type, id: f.id },
                // Tên đã biết từ danh sách thư mục -> hiện ngay, khỏi chờ tải.
                name: f.name.replace(/\.(pdf|pptx?|odp)$/i, '').trim(),
            })
        }
        skipped.push(...listing.skipped)
    }
    if (links.length > 100) {
        res.status(400)
        throw new Error(`Tổng cộng ${links.length} file — mỗi lần thêm tối đa 100. Hãy chia thư mục nhỏ lại.`)
    }

    const course = isId(req.body.courseId) ? await MaterialCourse.findById(req.body.courseId) : null
    if (!course) {
        res.status(400)
        throw new Error('Không tìm thấy khoá học liệu.')
    }
    const last = await MaterialDeck.findOne({ courseId: course._id }).sort({ order: -1 }).select('order').lean()
    let order = last ? Number(last.order) || 0 : 0
    // Tên tự đặt chỉ áp cho khi thêm MỘT link.
    const title = links.length === 1 ? text(req.body.title, 200) : ''

    const decks = []
    for (const { line, link, name } of links) {
        const own = title || text(name, 200)
        const deck = await MaterialDeck.create({
            courseId: course._id,
            title: own || 'Đang lấy tên file…',
            titleFromSource: !own,
            description: links.length === 1 ? text(req.body.description, 2000) : '',
            status: req.body.status === 'published' ? 'published' : 'draft',
            order: (order += 1),
            conversion: 'processing',
            version: 1,
            source: { kind: 'google', googleType: link.type, googleId: link.id, googleUrl: text(line, 500), ext: 'pdf' },
        })
        enqueueConversion(deck._id)
        decks.push(deckView(deck))
    }
    // `skipped`: file trong thư mục bị bỏ qua (không phải slide, thư mục con).
    res.status(201).json({ decks, skipped })
})

/**
 * POST /api/admin/materials/decks/:id/sync — lấy lại bản mới nhất từ Google
 * (giảng viên vừa sửa slide / thay file trên Drive). Có thể đổi sang link khác.
 */
const syncGoogleDeck = asyncHandler(async function syncGoogleDeck(req, res) {
    const deck = await MaterialDeck.findById(req.params.id)
    if (!deck) {
        res.status(404)
        throw new Error('Không tìm thấy bộ slide.')
    }
    let link = deck.source.kind === 'google' ? { type: deck.source.googleType || 'slides', id: deck.source.googleId } : null
    if (req.body && req.body.url) {
        link = parseGoogleLink(req.body.url)
        if (!link || link.type === 'folder') {
            res.status(400)
            throw new Error('Link không phải bài trình bày Google Slides hay file trên Google Drive.')
        }
    }
    if (!link) {
        res.status(400)
        throw new Error('Bộ slide này không lấy từ Google.')
    }
    deck.version += 1
    deck.conversion = 'processing'
    deck.conversionError = ''
    deck.pages = []
    deck.source = {
        kind: 'google',
        googleType: link.type,
        googleId: link.id,
        googleUrl: text(req.body && req.body.url ? req.body.url : deck.source.googleUrl, 500),
        ext: deck.source.ext || 'pdf',
        originalName: deck.source.originalName,
    }
    await deck.save()
    enqueueConversion(deck._id)
    res.json(deckView(deck))
})

/** POST /api/admin/materials/decks/:id/retry — chuyển lại sau khi lỗi. */
const retryDeck = asyncHandler(async function retryDeck(req, res) {
    const deck = await MaterialDeck.findById(req.params.id)
    if (!deck) {
        res.status(404)
        throw new Error('Không tìm thấy bộ slide.')
    }
    // Nguồn Google thì lần chuyển nào cũng tải lại từ Google, không cần file gốc.
    if (deck.source.kind !== 'google' && !fs.existsSync(sourcePath(deck._id, deck.version, deck.source.ext))) {
        res.status(400)
        throw new Error('Không còn file gốc trên máy chủ. Hãy tải file lên lại.')
    }
    deck.conversion = 'processing'
    deck.conversionError = ''
    await deck.save()
    enqueueConversion(deck._id)
    res.json(deckView(deck))
})

/** PUT /api/admin/materials/decks/:id — tên, mô tả, trạng thái hiển thị. */
const updateDeck = asyncHandler(async function updateDeck(req, res) {
    const deck = await MaterialDeck.findById(req.params.id)
    if (!deck) {
        res.status(404)
        throw new Error('Không tìm thấy bộ slide.')
    }
    if (req.body.title !== undefined) {
        const title = text(req.body.title, 200)
        if (!title) {
            res.status(400)
            throw new Error('Vui lòng nhập tên bộ slide.')
        }
        deck.title = title
    }
    if (req.body.description !== undefined) deck.description = text(req.body.description, 2000)
    if (req.body.status !== undefined) deck.status = req.body.status === 'published' ? 'published' : 'draft'
    await deck.save()
    res.json(deckView(deck))
})

/** PUT /api/admin/materials/decks/reorder { courseId, ids: [...] } — thứ tự hiển thị. */
const reorderDecks = asyncHandler(async function reorderDecks(req, res) {
    const { courseId, ids } = req.body
    if (!isId(courseId) || !Array.isArray(ids)) {
        res.status(400)
        throw new Error('Dữ liệu sắp xếp không hợp lệ.')
    }
    await Promise.all(
        ids.filter(isId).map((id, i) => MaterialDeck.updateOne({ _id: id, courseId }, { $set: { order: i + 1 } }))
    )
    res.json({ ok: true })
})

const deleteDeck = asyncHandler(async function deleteDeck(req, res) {
    const deck = await MaterialDeck.findById(req.params.id)
    if (!deck) {
        res.status(404)
        throw new Error('Không tìm thấy bộ slide.')
    }
    await deck.deleteOne()
    await removeDeckFiles(deck._id)
    res.json({ deleted: true })
})

/** GET /api/admin/materials/decks/:id/pages/:n — ảnh một trang để admin xem trước. */
const getDeckPage = asyncHandler(async function getDeckPage(req, res) {
    const deck = await MaterialDeck.findById(req.params.id).lean()
    await sendPage(res, deck, req.params.n, { thumb: req.query.thumb === '1' })
})

/**
 * Gửi ảnh một trang (hoặc ảnh thu nhỏ của nó với `thumb`). Dùng chung cho
 * admin và học viên (controller học viên kiểm quyền trước khi gọi). `n` đếm từ 1.
 */
async function sendPage(res, deck, n, { thumb = false } = {}) {
    const index = Number.parseInt(n, 10) - 1
    const abs = deck && deck.conversion === 'ready' && index >= 0 ? pagePath(deck, index, { thumb }) : null
    if (!abs || !fs.existsSync(abs)) {
        res.status(404)
        throw new Error('Không tìm thấy trang này.')
    }
    res.setHeader('Content-Type', 'image/jpeg')
    // Không để trình duyệt hay proxy nào giữ bản sao — học liệu chỉ xem, không tải.
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Disposition', 'inline')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    fs.createReadStream(abs).pipe(res)
}

// ---------- cấp quyền ----------

/**
 * GET /api/admin/materials/access?search=&courseId=&scope=has|missing&page=&limit=
 *
 * Danh sách học viên kèm các khoá học liệu từng người được xem (`access`) —
 * trang cấp quyền hiện dạng bảng: mỗi khoá một cột bật/tắt. `courseId` + `scope`
 * (tuỳ chọn) lọc ra người đã / chưa được xem một khoá.
 */
const listAccess = asyncHandler(async function listAccess(req, res) {
    const { courseId, scope = 'all', search = '' } = req.query
    if (courseId && !isId(courseId)) {
        res.status(400)
        throw new Error('Mã khoá học liệu không hợp lệ.')
    }
    const query = {}
    if (courseId) {
        const id = new mongoose.Types.ObjectId(courseId)
        if (scope === 'missing') query.materialAccess = { $ne: id }
        else if (scope === 'has') query.materialAccess = id
    }
    const q = String(search).trim()
    if (q) {
        const re = new RegExp(escapeRegex(q), 'i')
        query.$or = [{ name: re }, { phone: re }, { email: re }]
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20))
    const [rows, total] = await Promise.all([
        Student.find(query)
            .select('name phone email status materialAccess')
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        Student.countDocuments(query),
    ])
    res.json({
        data: rows.map((s) => ({
            _id: s._id,
            name: s.name,
            phone: s.phone,
            email: s.email,
            status: s.status,
            access: (s.materialAccess || []).map(String),
        })),
        pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    })
})

/**
 * PATCH /api/admin/materials/access { studentIds, courseId, action: grant|revoke }
 *
 * $addToSet / $pull nên bấm lại bao nhiêu lần cũng ra cùng kết quả.
 */
const updateAccess = asyncHandler(async function updateAccess(req, res) {
    const { studentIds, courseId, action } = req.body
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
    const course = isId(courseId) ? await MaterialCourse.findById(courseId) : null
    if (!course) {
        res.status(404)
        throw new Error('Không tìm thấy khoá học liệu.')
    }
    const ids = studentIds.filter(isId)

    // Đếm TRƯỚC số người thực sự đổi. modifiedCount của updateMany không dùng
    // được: Student bật timestamps nên mọi bản ghi khớp đều bị tính là "đã sửa".
    const changed = await Student.countDocuments(
        action === 'grant'
            ? { _id: { $in: ids }, materialAccess: { $ne: course._id } }
            : { _id: { $in: ids }, materialAccess: course._id }
    )
    await Student.updateMany(
        { _id: { $in: ids } },
        action === 'grant' ? { $addToSet: { materialAccess: course._id } } : { $pull: { materialAccess: course._id } }
    )
    res.json({
        changed,
        message:
            action === 'grant'
                ? `Đã cấp quyền xem "${course.name}" cho ${changed} học viên.`
                : `Đã thu hồi quyền xem "${course.name}" của ${changed} học viên.`,
    })
})

module.exports = {
    listCourses,
    createCourse,
    updateCourse,
    deleteCourse,
    listDecks,
    getDeck,
    createDeck,
    createGoogleDeck,
    syncGoogleDeck,
    replaceDeckFile,
    retryDeck,
    updateDeck,
    reorderDecks,
    deleteDeck,
    getDeckPage,
    listAccess,
    updateAccess,
    sendPage,
}
