const fs = require('fs')
const path = require('path')
const ExamTest = require('../models/ExamTest')
const { rasterizePdf, enqueueJob, run, STORAGE_ROOT } = require('./materialConvert')

/**
 * ĐỀ LUYỆN THI HSK 3.0 — mẫu cấu trúc, kiểm tra cấu trúc / đáp án admin nhập,
 * điều kiện xuất bản, file đề (PDF -> ảnh) và file nghe.
 *
 * Bố cục thư mục: storage/exam/tests/<testId>/
 *     source-v<N>.pdf        file đề gốc (KHÔNG phục vụ ra ngoài)
 *     v<N>/page-*.jpg        ảnh từng trang
 *     audio-v<N>.<ext>       file nghe
 */

const EXAM_DIR = path.join(STORAGE_ROOT, 'exam', 'tests')
const testDir = (id) => path.join(EXAM_DIR, String(id))
const pdfSourcePath = (id, version) => path.join(testDir(id), `source-v${version}.pdf`)
const pdfPagesDir = (id, version) => path.join(testDir(id), `v${version}`)

const SECTIONS = ['listening', 'reading', 'writing']
const SECTION_LABEL = { listening: 'Nghe', reading: 'Đọc', writing: 'Viết' }
const MAX_QUESTIONS = 200
const MAX_PDF_PAGES = 120
const AUDIO_EXTS = ['mp3', 'm4a', 'aac', 'wav', 'ogg']

// Điểm mỗi câu nghe / đọc: 30 câu chia đều 100 điểm. Viết: 100 điểm chia 10
// câu — chữ Hán 10 điểm/câu (đúng mới có điểm), đặt câu AI cho 0–10 điểm/câu
// (khách chốt theo file đáp án Đề 1 HSK3).
const PER_30 = 100 / 30
const PER_32 = 100 / 32 // HSK4: nghe / đọc mỗi phần 32 câu

/**
 * Mẫu đề HSK3 3.0 (70 câu) — theo đề mẫu khách gửi ("ĐỀ 1 HSK3 3.0.pdf").
 * Admin sửa lại được từng nhóm sau khi tạo.
 */
const TEMPLATES = {
    hsk3: {
        label: 'HSK3 3.0 — 70 câu (nghe 30 · đọc 30 · viết 10)',
        timing: { listeningSec: 0, reviewSec: 300, readingSec: 1800, writingSec: 1200 },
        groups: [
            { section: 'listening', type: 'choice', from: 1, to: 5, options: 'ABCDEF', title: 'Chọn tranh phù hợp', points: PER_30 },
            { section: 'listening', type: 'choice', from: 6, to: 10, options: 'ABCDE', title: 'Chọn tranh phù hợp', points: PER_30 },
            { section: 'listening', type: 'choice', from: 11, to: 15, options: 'ABC', title: 'Chọn đáp án đúng', points: PER_30 },
            { section: 'listening', type: 'choice', from: 16, to: 20, options: 'ABC', title: 'Chọn đáp án đúng', points: PER_30 },
            { section: 'listening', type: 'choice', from: 21, to: 30, options: 'ABC', title: 'Chọn đáp án đúng', points: PER_30 },
            { section: 'reading', type: 'choice', from: 31, to: 35, options: 'ABCDEF', title: 'Chọn câu đáp phù hợp', points: PER_30 },
            { section: 'reading', type: 'choice', from: 36, to: 40, options: 'ABCDE', title: 'Chọn câu đáp phù hợp', points: PER_30 },
            { section: 'reading', type: 'choice', from: 41, to: 45, options: 'ABCDEF', title: 'Chọn từ điền vào chỗ trống', points: PER_30 },
            { section: 'reading', type: 'choice', from: 46, to: 50, options: 'ABCDEF', title: 'Chọn từ điền vào chỗ trống', points: PER_30 },
            { section: 'reading', type: 'choice', from: 51, to: 60, options: 'ABC', title: 'Đọc đoạn văn, chọn đáp án đúng', points: PER_30 },
            { section: 'writing', type: 'text', from: 61, to: 65, title: 'Viết chữ Hán theo phiên âm', points: 10 },
            // Đặt câu: `points` = điểm TỐI ĐA mỗi câu, AI cho điểm từ 0 tới đó.
            { section: 'writing', type: 'sentence', from: 66, to: 70, title: 'Nhìn tranh, dùng từ cho sẵn đặt câu', points: 10 },
        ],
    },
    // Theo đề mẫu "ĐỀ 1 HSK4 3.0.pdf". Viết 100 điểm: 5 câu đặt câu × 10 + đoạn văn 50.
    hsk4: {
        label: 'HSK4 3.0 — 70 câu (nghe 32 · đọc 32 · viết 6)',
        timing: { listeningSec: 0, reviewSec: 300, readingSec: 1800, writingSec: 1500 },
        groups: [
            { section: 'listening', type: 'choice', from: 1, to: 7, options: 'ABCD', title: 'Chọn đáp án đúng', points: PER_32 },
            { section: 'listening', type: 'choice', from: 8, to: 14, options: 'ABCD', title: 'Chọn đáp án đúng', points: PER_32 },
            { section: 'listening', type: 'choice', from: 15, to: 19, options: 'ABCD', title: 'Chọn đáp án đúng', points: PER_32 },
            { section: 'listening', type: 'choice', from: 20, to: 32, options: 'ABCD', title: 'Chọn đáp án đúng', points: PER_32 },
            { section: 'reading', type: 'choice', from: 33, to: 37, options: 'ABCDEF', title: 'Chọn từ điền vào chỗ trống', points: PER_32 },
            { section: 'reading', type: 'choice', from: 38, to: 42, options: 'ABCDEF', title: 'Chọn từ điền vào chỗ trống', points: PER_32 },
            { section: 'reading', type: 'choice', from: 43, to: 50, options: 'ABCD', title: 'Đọc đoạn văn, chọn đáp án đúng', points: PER_32 },
            { section: 'reading', type: 'choice', from: 51, to: 57, options: 'ABCD', title: 'Đọc đoạn văn, chọn đáp án đúng', points: PER_32 },
            { section: 'reading', type: 'choice', from: 58, to: 60, options: 'ABC', title: 'Chọn câu điền vào chỗ trống', points: PER_32 },
            { section: 'reading', type: 'choice', from: 61, to: 64, options: 'ABCD', title: 'Chọn câu điền vào chỗ trống', points: PER_32 },
            { section: 'writing', type: 'sentence', from: 65, to: 69, title: 'Nhìn tranh, dùng từ cho sẵn đặt câu', points: 10 },
            { section: 'writing', type: 'sentence', from: 70, to: 70, title: 'Viết đoạn văn theo đề bài', points: 50, minChars: 80 },
        ],
    },
    blank: { label: 'Trống — tự khai cấu trúc', timing: { listeningSec: 0, reviewSec: 300, readingSec: 1800, writingSec: 1200 }, groups: [] },
}

const num = (v, { min = 0, max = 1e6 } = {}) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min
}
const text = (v, max) => String(v ?? '').trim().slice(0, max)
const round2 = (n) => Math.round(n * 100) / 100

/**
 * Chuẩn hoá cấu trúc admin gửi lên. Ném lỗi (kèm câu dễ hiểu) nếu nhóm câu
 * chồng nhau, sai thứ tự phần (nghe -> đọc -> viết) hoặc thiếu lựa chọn.
 */
function cleanGroups(input) {
    if (!Array.isArray(input)) throw new Error('Cấu trúc đề không hợp lệ.')
    const groups = input.slice(0, 60).map((g) => {
        const section = SECTIONS.includes(g?.section) ? g.section : null
        const type = ['choice', 'text', 'sentence'].includes(g?.type) ? g.type : null
        if (!section || !type) throw new Error('Mỗi nhóm câu cần có phần (nghe / đọc / viết) và kiểu câu.')
        const from = Math.round(num(g.from, { min: 1, max: MAX_QUESTIONS }))
        const to = Math.round(num(g.to, { min: 1, max: MAX_QUESTIONS }))
        if (to < from) throw new Error(`Nhóm câu ${from}–${to}: số câu cuối phải lớn hơn hoặc bằng câu đầu.`)
        const out = {
            section,
            type,
            from,
            to,
            title: text(g.title, 200),
            page: Math.round(num(g.page, { max: MAX_PDF_PAGES })),
            points: 0,
            minChars: type === 'sentence' ? Math.round(num(g.minChars, { max: 500 })) : 0,
            verdictPoints: { dat: 0, gan_dat: 0, chua_dat: 0 },
            options: '',
        }
        if (type === 'choice') {
            // Chỉ giữ chữ cái A–Z, không trùng, đúng thứ tự admin gõ.
            out.options = [...new Set(String(g.options || '').toUpperCase().replace(/[^A-Z]/g, ''))].join('').slice(0, 10)
            if (out.options.length < 2) throw new Error(`Nhóm câu ${from}–${to}: cần ít nhất 2 lựa chọn (vd. ABC).`)
        }
        // Đặt câu: `points` là điểm tối đa mỗi câu (AI cho 0..points). Đề cũ chỉ
        // có verdictPoints (đạt / gần đạt / chưa đạt) -> lấy mức "đạt" làm tối đa.
        out.points = num(type === 'sentence' && !g.points ? g.verdictPoints?.dat : g.points, { max: 100 })
        if (type === 'sentence' && out.points < 1) throw new Error(`Nhóm câu ${from}–${to}: cần điểm tối đa mỗi câu cho AI chấm (vd. 10).`)
        return out
    })
    groups.sort((a, b) => a.from - b.from)
    for (let i = 1; i < groups.length; i++) {
        const prev = groups[i - 1]
        const cur = groups[i]
        if (cur.from <= prev.to) throw new Error(`Nhóm câu ${prev.from}–${prev.to} và ${cur.from}–${cur.to} bị chồng lên nhau.`)
        if (SECTIONS.indexOf(cur.section) < SECTIONS.indexOf(prev.section)) {
            throw new Error(`Câu ${cur.from} thuộc phần ${SECTION_LABEL[cur.section]} nhưng đứng sau phần ${SECTION_LABEL[prev.section]} — thứ tự phải là nghe → đọc → viết.`)
        }
    }
    return groups
}

/** Mỗi số câu thuộc nhóm nào. */
function questionMap(groups) {
    const map = new Map()
    for (const g of groups) for (let n = g.from; n <= g.to; n++) map.set(n, g)
    return map
}

/** Chuẩn hoá đáp án: chỉ giữ câu có trong cấu trúc; đáp án chọn phải nằm trong các lựa chọn. */
function cleanItems(input, groups) {
    const map = questionMap(groups)
    const out = new Map()
    for (const it of Array.isArray(input) ? input : []) {
        const no = Math.round(Number(it?.no))
        const g = map.get(no)
        if (!g) continue
        const item = { no, answer: '', keyword: '', sample: '', hint: '', script: text(it.script, 4000), explain: text(it.explain, 4000) }
        if (g.type === 'choice') {
            const a = text(it.answer, 5).toUpperCase()
            if (a && !g.options.includes(a)) throw new Error(`Câu ${no}: đáp án "${a}" không nằm trong các lựa chọn ${g.options.split('').join(', ')}.`)
            item.answer = a
        } else if (g.type === 'text') {
            item.answer = text(it.answer, 200)
        } else {
            item.keyword = text(it.keyword, 50)
            item.sample = text(it.sample, isEssay(g) ? 1500 : 300)
            item.hint = text(it.hint, 300)
        }
        out.set(no, item)
    }
    return [...out.values()].sort((a, b) => a.no - b.no)
}

/** Nhóm câu viết đoạn văn (AI chấm cả đoạn) thay vì đặt một câu. */
const isEssay = (g) => g?.type === 'sentence' && Number(g.minChars) > 0

/** Điểm tối đa mỗi câu của nhóm (đề cũ: đặt câu chấm theo mức -> mức "đạt"). */
const sentenceMaxOr = (g) => Number(g.points) || (g.type === 'sentence' ? Number(g.verdictPoints?.dat) || 0 : 0)

/** Tổng điểm tối đa từng phần + cả đề. */
function scoreSummary(groups) {
    const max = { listening: 0, reading: 0, writing: 0 }
    for (const g of groups) {
        const n = g.to - g.from + 1
        max[g.section] += n * sentenceMaxOr(g)
    }
    return {
        listening: round2(max.listening),
        reading: round2(max.reading),
        writing: round2(max.writing),
        total: round2(max.listening + max.reading + max.writing),
    }
}

/**
 * Còn thiếu gì thì chưa cho xuất bản. Trả danh sách lý do (rỗng = sẵn sàng).
 */
function readiness(test) {
    const missing = []
    const groups = test.groups || []
    const pages = (test.pdf?.pages || []).filter((p) => !p.hidden)
    if (test.pdf?.conversion !== 'ready' || pages.length === 0) missing.push('Chưa có file đề PDF (hoặc đang chuyển đổi).')
    const hasListening = groups.some((g) => g.section === 'listening')
    if (hasListening && !test.audio?.file) missing.push('Chưa có file nghe.')
    if (hasListening && !test.audio?.durationSec && !test.timing?.listeningSec) missing.push('Chưa biết thời lượng phần nghe.')
    if (groups.length === 0) missing.push('Chưa khai cấu trúc câu hỏi.')
    const items = new Map((test.items || []).map((i) => [i.no, i]))
    const noAnswer = []
    for (const g of groups) {
        for (let n = g.from; n <= g.to; n++) {
            const it = items.get(n)
            // Đặt câu cần từ bắt buộc; đoạn văn cần đề bài (cho AI chấm).
            const ok = g.type !== 'sentence' ? Boolean(it?.answer) : isEssay(g) ? Boolean(it?.hint) : Boolean(it?.keyword)
            if (!ok) noAnswer.push(n)
        }
    }
    if (noAnswer.length) missing.push(`Còn ${noAnswer.length} câu chưa có đáp án${noAnswer.length <= 12 ? ` (câu ${noAnswer.join(', ')})` : ''}.`)
    return missing
}

/** Thời lượng phần nghe thực dùng (giây). */
const listeningSec = (test) => Math.round(test.timing?.listeningSec || test.audio?.durationSec || 0)

// ---------- file đề PDF ----------

async function convertTestPdf(testId) {
    const test = await ExamTest.findById(testId)
    if (!test || test.pdf.conversion !== 'processing') return
    const version = test.pdf.version
    try {
        const pages = await rasterizePdf(pdfSourcePath(testId, version), pdfPagesDir(testId, version), {
            maxPages: MAX_PDF_PAGES,
            splitSpreads: test.pdf.splitSpreads,
            label: `Đề thi ${testId}`,
        })
        const res = await ExamTest.updateOne(
            { _id: testId, 'pdf.version': version },
            { $set: { 'pdf.pages': pages, 'pdf.conversion': 'ready', 'pdf.error': '' } }
        )
        if (res.matchedCount) await removeOldPdfVersions(testId, version)
    } catch (err) {
        console.error(`[examTest] Đề ${testId}:`, err.message, err.stderr ? String(err.stderr).slice(0, 500) : '')
        await ExamTest.updateOne(
            { _id: testId, 'pdf.version': version },
            { $set: { 'pdf.conversion': 'failed', 'pdf.error': err.message.slice(0, 300), 'pdf.pages': [] } }
        )
    }
}

/** Xoá ảnh của version cũ; file gốc PDF thì giữ đúng bản đang dùng (để chuyển lại có / không cắt đôi trang). */
async function removeOldPdfVersions(testId, keep) {
    let entries = []
    try {
        entries = await fs.promises.readdir(testDir(testId))
    } catch {
        return
    }
    for (const name of entries) {
        const m = name.match(/^(?:source-)?v(\d+)/)
        if (m && Number(m[1]) < keep) await fs.promises.rm(path.join(testDir(testId), name), { recursive: true, force: true }).catch(() => { })
    }
}

const enqueueTestPdf = (testId) => enqueueJob(`exam:${testId}`, () => convertTestPdf(String(testId)))

/** Đường dẫn ảnh một trang (n đếm từ 1, theo MỌI trang kể cả trang ẩn), có chặn đi ra ngoài thư mục. */
function testPagePath(test, index, { thumb = false } = {}) {
    const page = test.pdf?.pages?.[index]
    if (!page) return null
    const dir = path.resolve(pdfPagesDir(test._id, test.pdf.version))
    const abs = path.resolve(dir, thumb && page.thumb ? page.thumb : page.file)
    return abs.startsWith(dir + path.sep) ? abs : null
}

// ---------- file nghe ----------

/**
 * Thời lượng file nghe (giây) qua ffprobe. Trả số giây; 0 nếu file không đọc
 * được; null nếu máy chủ không có ffprobe (khi đó dùng số trình duyệt đo).
 */
async function probeDuration(file) {
    try {
        const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], 30000)
        const d = Number(String(stdout).trim())
        return Number.isFinite(d) && d > 0 ? Math.round(d) : 0
    } catch (err) {
        return err.code === 'ENOENT' ? null : 0
    }
}

function testAudioPath(test) {
    if (!test.audio?.file) return null
    const dir = path.resolve(testDir(test._id))
    const abs = path.resolve(dir, test.audio.file)
    return abs.startsWith(dir + path.sep) ? abs : null
}

async function removeTestFiles(testId) {
    await fs.promises.rm(testDir(testId), { recursive: true, force: true }).catch(() => { })
}

/** Lúc máy chủ khởi động: chuyển tiếp các đề đang chuyển dở. */
async function resumeExamConversions() {
    const pending = await ExamTest.find({ 'pdf.conversion': 'processing' }).select('_id').lean()
    pending.forEach((t) => enqueueTestPdf(t._id))
    if (pending.length) console.log(`[examTest] Chuyển tiếp ${pending.length} đề còn dở.`)
}

module.exports = {
    sentenceMaxOr,
    isEssay,
    EXAM_DIR,
    TEMPLATES,
    SECTIONS,
    AUDIO_EXTS,
    testDir,
    pdfSourcePath,
    pdfPagesDir,
    cleanGroups,
    cleanItems,
    questionMap,
    scoreSummary,
    readiness,
    listeningSec,
    enqueueTestPdf,
    convertTestPdf,
    testPagePath,
    testAudioPath,
    probeDuration,
    removeTestFiles,
    resumeExamConversions,
}
