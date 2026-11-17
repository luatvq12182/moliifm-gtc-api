const fs = require('fs')
const path = require('path')
const mongoose = require('mongoose')
const ExamLevel = require('../models/ExamLevel')
const ExamTest = require('../models/ExamTest')
const ExamAttempt = require('../models/ExamAttempt')
const asyncHandler = require('../utils/asyncHandler')
const { submittedCounts } = require('./examResultAdminController')
const { uploadExamPdf, uploadExamAudio } = require('../middleware/uploadExam')
const {
    TEMPLATES,
    testDir,
    pdfSourcePath,
    cleanGroups,
    cleanItems,
    scoreSummary,
    readiness,
    listeningSec,
    enqueueTestPdf,
    testPagePath,
    testAudioPath,
    probeDuration,
    removeTestFiles,
} = require('../lib/examTest')

/**
 * QUẢN TRỊ ĐỀ LUYỆN THI HSK 3.0: tạo đề theo mẫu, tải đề PDF + file nghe, khai
 * cấu trúc phiếu trả lời và đáp án, ẩn trang thừa, xuất bản.
 *
 * Đề đang hiện cho học viên thì KHÔNG cho thay file PDF / file nghe (học viên
 * có thể đang làm dở) — ẩn đề trước rồi thay. Sửa đáp án thì vẫn được.
 */

const isId = (v) => Boolean(v) && mongoose.Types.ObjectId.isValid(String(v))
const text = (v, max) => String(v ?? '').trim().slice(0, max)

function bad(res, message, status = 400) {
    res.status(status)
    return new Error(message)
}

async function loadTest(req, res) {
    const test = isId(req.params.id) ? await ExamTest.findById(req.params.id) : null
    if (!test) throw bad(res, 'Không tìm thấy đề.', 404)
    return test
}

function mustBeDraft(test, res) {
    if (test.status === 'published') throw bad(res, 'Đề đang hiện cho học viên. Chuyển đề về "Nháp" rồi mới thay file.', 409)
}

/** Nhận một file qua multer; lỗi định dạng / dung lượng -> 400 câu dễ hiểu. */
function receiveFile(uploader, req, res, tooBig) {
    return new Promise((resolve, reject) => {
        uploader.single('file')(req, res, (err) => {
            if (!err) {
                if (req.file) req.file.originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8')
                return resolve(req.file || null)
            }
            res.status(400)
            reject(err.code === 'LIMIT_FILE_SIZE' ? new Error(tooBig) : err)
        })
    })
}

const discardTemp = (file) => file && fs.promises.unlink(file.path).catch(() => { })

const summaryView = (t) => {
    const missing = readiness(t)
    return {
        _id: t._id,
        levelId: t.levelId,
        title: t.title,
        order: t.order,
        status: t.status,
        conversion: t.pdf?.conversion || 'none',
        pageCount: (t.pdf?.pages || []).filter((p) => !p.hidden).length,
        hasAudio: Boolean(t.audio?.file),
        questionCount: (t.groups || []).reduce((n, g) => n + g.to - g.from + 1, 0),
        ready: missing.length === 0,
        missing,
        updatedAt: t.updatedAt,
    }
}

const fullView = (t) => ({
    ...summaryView(t),
    pdf: {
        originalName: t.pdf.originalName,
        bytes: t.pdf.bytes,
        version: t.pdf.version,
        splitSpreads: t.pdf.splitSpreads,
        conversion: t.pdf.conversion,
        error: t.pdf.error,
        pages: t.pdf.pages.map((p, i) => ({ n: i + 1, width: p.width, height: p.height, hidden: p.hidden })),
    },
    audio: { has: Boolean(t.audio.file), originalName: t.audio.originalName, bytes: t.audio.bytes, durationSec: t.audio.durationSec, version: t.audio.version },
    timing: t.timing,
    listeningSec: listeningSec(t),
    passScore: t.passScore,
    groups: t.groups,
    items: t.items,
    scores: scoreSummary(t.groups),
})

/** GET /api/admin/exam/templates */
const listTemplates = asyncHandler(async function listTemplates(req, res) {
    res.json(Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label })))
})

/** GET /api/admin/exam/tests?levelId= */
const listTests = asyncHandler(async function listTests(req, res) {
    if (!isId(req.query.levelId)) throw bad(res, 'Thiếu mã cấp thi.')
    const tests = await ExamTest.find({ levelId: req.query.levelId }).sort({ order: 1, createdAt: 1 }).lean()
    const counts = await submittedCounts(tests.map((t) => t._id))
    res.json(tests.map((t) => ({ ...summaryView(t), submittedCount: counts.get(String(t._id)) || 0 })))
})

/** POST /api/admin/exam/tests { levelId, title?, template } */
const createTest = asyncHandler(async function createTest(req, res) {
    const level = isId(req.body.levelId) ? await ExamLevel.findById(req.body.levelId) : null
    if (!level) throw bad(res, 'Không tìm thấy cấp thi.', 404)
    const tpl = TEMPLATES[req.body.template] || TEMPLATES.blank
    const count = await ExamTest.countDocuments({ levelId: level._id })
    const last = await ExamTest.findOne({ levelId: level._id }).sort({ order: -1 }).select('order').lean()
    const test = await ExamTest.create({
        levelId: level._id,
        title: text(req.body.title, 200) || `Đề ${count + 1}`,
        order: (last?.order || 0) + 1,
        timing: tpl.timing,
        groups: tpl.groups,
    })
    res.status(201).json(fullView(test))
})

/** GET /api/admin/exam/tests/:id */
const getTest = asyncHandler(async function getTest(req, res) {
    const test = await loadTest(req, res)
    const counts = await submittedCounts([test._id])
    res.json({ ...fullView(test), submittedCount: counts.get(String(test._id)) || 0 })
})

/**
 * PUT /api/admin/exam/tests/:id
 *   { title?, status?, timing?, passScore?, groups?, items? }
 * Đổi cấu trúc thì đáp án của câu không còn trong cấu trúc bị bỏ. Xuất bản
 * (hoặc sửa đề đang xuất bản) chỉ được khi đề đủ điều kiện.
 */
const updateTest = asyncHandler(async function updateTest(req, res) {
    const test = await loadTest(req, res)
    const b = req.body || {}
    if (b.title !== undefined) {
        const title = text(b.title, 200)
        if (!title) throw bad(res, 'Vui lòng nhập tên đề.')
        test.title = title
    }
    if (b.timing) {
        const sec = (v, min, max) => Math.round(Math.min(max, Math.max(min, Number(v) || 0)))
        const t = test.timing
        if (b.timing.listeningSec !== undefined) t.listeningSec = sec(b.timing.listeningSec, 0, 3 * 3600)
        if (b.timing.reviewSec !== undefined) t.reviewSec = sec(b.timing.reviewSec, 0, 3600)
        if (b.timing.readingSec !== undefined) t.readingSec = sec(b.timing.readingSec, 60, 3 * 3600)
        if (b.timing.writingSec !== undefined) t.writingSec = sec(b.timing.writingSec, 60, 3 * 3600)
    }
    if (b.passScore !== undefined) test.passScore = Math.max(0, Math.min(10000, Number(b.passScore) || 0))
    try {
        if (b.groups !== undefined) test.groups = cleanGroups(b.groups)
        if (b.items !== undefined || b.groups !== undefined) {
            test.items = cleanItems(b.items !== undefined ? b.items : test.items, test.groups)
        }
    } catch (err) {
        throw bad(res, err.message)
    }
    if (b.status !== undefined) test.status = b.status === 'published' ? 'published' : 'draft'
    if (test.status === 'published') {
        const missing = readiness(test)
        if (missing.length) {
            const err = bad(res, `Đề chưa đủ để hiện cho học viên: ${missing.join(' ')}`)
            err.appCode = 'EXAM_TEST_NOT_READY'
            throw err
        }
    }
    await test.save()
    res.json(fullView(test))
})

/** PUT /api/admin/exam/tests/reorder { levelId, ids } */
const reorderTests = asyncHandler(async function reorderTests(req, res) {
    const { levelId, ids } = req.body
    if (!isId(levelId) || !Array.isArray(ids)) throw bad(res, 'Dữ liệu sắp xếp không hợp lệ.')
    await Promise.all(ids.filter(isId).map((id, i) => ExamTest.updateOne({ _id: id, levelId }, { $set: { order: i + 1 } })))
    res.json({ ok: true })
})

const deleteTest = asyncHandler(async function deleteTest(req, res) {
    const test = await loadTest(req, res)
    await test.deleteOne()
    await ExamAttempt.deleteMany({ testId: test._id })
    await removeTestFiles(test._id)
    res.json({ deleted: true })
})

// ---------- file đề PDF ----------

/** POST /api/admin/exam/tests/:id/pdf (multipart: file, splitSpreads) */
const uploadPdf = asyncHandler(async function uploadPdf(req, res) {
    const test = await loadTest(req, res)
    mustBeDraft(test, res)
    const file = await receiveFile(uploadExamPdf, req, res, 'File đề vượt quá 100MB.')
    if (!file) throw bad(res, 'Chưa chọn file PDF.')
    try {
        const head = Buffer.alloc(5)
        const fd = await fs.promises.open(file.path, 'r')
        await fd.read(head, 0, 5, 0)
        await fd.close()
        if (head.toString('latin1') !== '%PDF-') throw bad(res, 'File này không phải PDF.')
        const version = (test.pdf.version || 0) + 1
        await fs.promises.mkdir(testDir(test._id), { recursive: true })
        await fs.promises.rename(file.path, pdfSourcePath(test._id, version))
        test.pdf = {
            originalName: text(file.originalname, 300),
            bytes: file.size,
            version,
            splitSpreads: ['1', 'true', 'on'].includes(String(req.body.splitSpreads)),
            conversion: 'processing',
            error: '',
            pages: [],
        }
        await test.save()
    } finally {
        await discardTemp(file)
    }
    enqueueTestPdf(test._id)
    res.status(201).json(fullView(test))
})

/** POST /api/admin/exam/tests/:id/pdf/convert { splitSpreads } — chuyển lại file đang có (bật / tắt cắt đôi trang). */
const reconvertPdf = asyncHandler(async function reconvertPdf(req, res) {
    const test = await loadTest(req, res)
    mustBeDraft(test, res)
    if (!test.pdf.version) throw bad(res, 'Đề chưa có file PDF.')
    if (test.pdf.conversion === 'processing') throw bad(res, 'Đề đang được chuyển đổi, đợi xong rồi thử lại.', 409)
    const from = pdfSourcePath(test._id, test.pdf.version)
    if (!fs.existsSync(from)) throw bad(res, 'Không còn file gốc trên máy chủ — hãy tải lại file PDF.')
    const version = test.pdf.version + 1
    await fs.promises.rename(from, pdfSourcePath(test._id, version))
    test.pdf.version = version
    test.pdf.splitSpreads = Boolean(req.body.splitSpreads)
    test.pdf.conversion = 'processing'
    test.pdf.error = ''
    test.pdf.pages = []
    await test.save()
    enqueueTestPdf(test._id)
    res.json(fullView(test))
})

/** PUT /api/admin/exam/tests/:id/pages { hidden: [n, ...] } — n đếm từ 1. */
const setHiddenPages = asyncHandler(async function setHiddenPages(req, res) {
    const test = await loadTest(req, res)
    if (test.pdf.conversion !== 'ready') throw bad(res, 'Đề chưa chuyển đổi xong.')
    const hidden = new Set((Array.isArray(req.body.hidden) ? req.body.hidden : []).map((n) => Number(n) - 1))
    test.pdf.pages.forEach((p, i) => {
        p.hidden = hidden.has(i)
    })
    if (test.status === 'published' && !test.pdf.pages.some((p) => !p.hidden)) throw bad(res, 'Đề đang hiện thì phải còn ít nhất một trang.')
    await test.save()
    res.json(fullView(test))
})

/** GET /api/admin/exam/tests/:id/pages/:n[?thumb=1] — kể cả trang đã ẩn. */
const getPage = asyncHandler(async function getPage(req, res) {
    const test = await loadTest(req, res)
    const index = Number.parseInt(req.params.n, 10) - 1
    const abs = test.pdf.conversion === 'ready' && index >= 0 ? testPagePath(test, index, { thumb: req.query.thumb === '1' }) : null
    if (!abs || !fs.existsSync(abs)) throw bad(res, 'Không tìm thấy trang này.', 404)
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    fs.createReadStream(abs).pipe(res)
})

// ---------- file nghe ----------

/** POST /api/admin/exam/tests/:id/audio (multipart: file, durationSec? — trình duyệt đo hộ khi máy chủ không có ffprobe) */
const uploadAudio = asyncHandler(async function uploadAudio(req, res) {
    const test = await loadTest(req, res)
    mustBeDraft(test, res)
    const file = await receiveFile(uploadExamAudio, req, res, 'File nghe vượt quá 150MB.')
    if (!file) throw bad(res, 'Chưa chọn file nghe.')
    try {
        const ext = path.extname(file.originalname).slice(1).toLowerCase()
        const version = (test.audio.version || 0) + 1
        const name = `audio-v${version}.${ext}`
        await fs.promises.mkdir(testDir(test._id), { recursive: true })
        const dest = path.join(testDir(test._id), name)
        await fs.promises.rename(file.path, dest)
        const probed = await probeDuration(dest)
        const told = Math.round(Number(req.body.durationSec) || 0)
        const durationSec = probed === null ? (told > 0 && told < 4 * 3600 ? told : 0) : probed
        if (!durationSec) {
            await fs.promises.rm(dest, { force: true })
            throw bad(res, 'Không đọc được file nghe này (file hỏng hoặc không phải file âm thanh).')
        }
        const old = testAudioPath(test)
        test.audio = { file: name, originalName: text(file.originalname, 300), bytes: file.size, durationSec, version }
        await test.save()
        if (old) await fs.promises.rm(old, { force: true }).catch(() => { })
    } finally {
        await discardTemp(file)
    }
    res.status(201).json(fullView(test))
})

const deleteAudio = asyncHandler(async function deleteAudio(req, res) {
    const test = await loadTest(req, res)
    mustBeDraft(test, res)
    const old = testAudioPath(test)
    test.audio = { file: '', originalName: '', bytes: 0, durationSec: 0, version: test.audio.version }
    await test.save()
    if (old) await fs.promises.rm(old, { force: true }).catch(() => { })
    res.json(fullView(test))
})

/** GET /api/admin/exam/tests/:id/audio — nghe thử (hỗ trợ tua). */
const getAudio = asyncHandler(async function getAudio(req, res) {
    const test = await loadTest(req, res)
    const abs = testAudioPath(test)
    if (!abs || !fs.existsSync(abs)) throw bad(res, 'Đề chưa có file nghe.', 404)
    res.sendFile(abs, { headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
})

module.exports = {
    listTemplates,
    listTests,
    createTest,
    getTest,
    updateTest,
    reorderTests,
    deleteTest,
    uploadPdf,
    reconvertPdf,
    setHiddenPages,
    getPage,
    uploadAudio,
    deleteAudio,
    getAudio,
}
