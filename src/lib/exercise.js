const crypto = require('crypto')

/**
 * Bài tập của video bài giảng: làm sạch đề admin soạn, dựng đề cho học viên
 * (KHÔNG kèm đáp án), chấm tự động phần điền từ / viết chữ Hán.
 * Phần đặt câu do AI chấm — xem lib/aiGrader.js.
 */

const BLANK_RE = /_{2,}/g
const TYPES = ['word_bank', 'pinyin', 'sentence']
const DEFAULT_TITLES = {
    word_bank: '选词填空（Chọn từ điền vào chỗ trống）',
    pinyin: '根据所给的拼音写汉字（Viết chữ Hán dựa theo phiên âm cho sẵn）',
    sentence: '根据所给词语和图片造句（Đặt câu với từ cho sẵn và hình ảnh）',
}
const MAX_SECTIONS = 20
const MAX_ITEMS = 50

const str = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max)
const newId = () => crypto.randomBytes(5).toString('hex')
const blankCount = (text) => (String(text).match(BLANK_RE) || []).length
// Chỗ trống viết bao nhiêu dấu gạch cũng được; lưu thống nhất "____".
const tidyBlanks = (text) => text.replace(BLANK_RE, '____')

/** Từ trong ô từ: tách theo khoảng trắng / dấu phẩy / dấu 、. */
function splitWords(v) {
    const list = Array.isArray(v) ? v : String(v ?? '').split(/[\s,，、;；]+/)
    return [...new Set(list.map((w) => str(w, 40)).filter(Boolean))].slice(0, 40)
}

/**
 * Làm sạch + kiểm đề admin gửi lên. Trả { sections } hoặc ném lỗi (400) nói
 * rõ phần nào, câu nào sai.
 */
function cleanSections(input) {
    if (!Array.isArray(input)) throw new Error('Dữ liệu bài tập không hợp lệ.')
    if (input.length > MAX_SECTIONS) throw new Error(`Tối đa ${MAX_SECTIONS} phần bài tập.`)
    const seen = new Set()
    const uid = (v) => {
        let id = /^[a-z0-9]{6,16}$/.test(String(v || '')) ? String(v) : newId()
        while (seen.has(id)) id = newId()
        seen.add(id)
        return id
    }

    return input.map((sec, si) => {
        const type = TYPES.includes(sec?.type) ? sec.type : null
        const where = `Phần ${si + 1}`
        if (!type) throw new Error(`${where}: dạng bài không hợp lệ.`)
        const items = Array.isArray(sec.items) ? sec.items : []
        if (items.length === 0) throw new Error(`${where}: chưa có câu nào.`)
        if (items.length > MAX_ITEMS) throw new Error(`${where}: tối đa ${MAX_ITEMS} câu.`)
        const words = type === 'word_bank' ? splitWords(sec.words) : []
        if (type === 'word_bank' && words.length === 0) throw new Error(`${where}: chưa nhập các từ cho sẵn.`)

        return {
            id: uid(sec.id),
            type,
            title: str(sec.title, 300) || DEFAULT_TITLES[type],
            words,
            items: items.map((it, ii) => {
                const at = `${where}, câu ${ii + 1}`
                const base = { id: uid(it?.id), text: '', answers: [], explain: '', pinyin: '', word: '', image: '', sample: '' }
                if (type === 'sentence') {
                    const word = str(it?.word, 40)
                    if (!word) throw new Error(`${at}: chưa nhập từ cần đặt câu.`)
                    return { ...base, word, image: str(it?.image, 500), sample: str(it?.sample, 2000) }
                }
                const text = tidyBlanks(str(it?.text, 1000))
                const n = blankCount(text)
                if (n === 0) throw new Error(`${at}: chưa có chỗ trống (gõ ___ vào chỗ cần điền).`)
                const answers = (Array.isArray(it?.answers) ? it.answers : []).slice(0, n).map((a) => str(a, 80))
                if (answers.length < n || answers.some((a) => !a)) throw new Error(`${at}: có ${n} chỗ trống — nhập đủ đáp án.`)
                return {
                    ...base,
                    text,
                    answers,
                    explain: str(it?.explain, 2000),
                    pinyin: type === 'pinyin' ? str(it?.pinyin, 80) : '',
                }
            }),
        }
    })
}

/** Đề cho học viên: bỏ đáp án, lời giải, câu mẫu. */
function studentSections(sections) {
    return sections.map((s) => ({
        id: s.id,
        type: s.type,
        title: s.title,
        words: s.words,
        items: s.items.map((it) =>
            s.type === 'sentence'
                ? { id: it.id, word: it.word, image: it.image }
                : { id: it.id, text: it.text, pinyin: it.pinyin, blanks: blankCount(it.text) }
        ),
    }))
}

const countItems = (sections) => (sections || []).reduce((n, s) => n + (s.items || []).length, 0)

/**
 * So đáp án: bỏ khoảng trắng, đổi chữ toàn khổ về thường (NFKC), không phân
 * biệt hoa thường, bỏ dấu câu ở cuối. "有的/有些" = chấp nhận một trong hai.
 */
function normalizeAnswer(s) {
    return String(s ?? '')
        .normalize('NFKC')
        .replace(/\s+/g, '')
        .replace(/[。.，,！!？?；;：:]+$/u, '')
        .toLowerCase()
}
const matches = (given, expected) =>
    String(expected)
        .split('/')
        .map(normalizeAnswer)
        .filter(Boolean)
        .includes(normalizeAnswer(given))

/**
 * Chấm phần tự động. `answers` là dữ liệu từ trình duyệt — chỉ đọc đúng kiểu
 * cần, bỏ qua mọi thứ khác.
 * Trả { results, correct, total, answers (đã làm sạch) } — tính theo CHỖ TRỐNG.
 */
function gradeAuto(sections, answers) {
    const results = {}
    const clean = {}
    let correct = 0
    let total = 0
    for (const s of sections) {
        for (const it of s.items) {
            if (s.type === 'sentence') {
                clean[it.id] = str(answers?.[it.id], 300)
                continue
            }
            const given = Array.isArray(answers?.[it.id]) ? answers[it.id] : []
            const row = it.answers.map((exp, i) => matches(given[i], exp))
            clean[it.id] = it.answers.map((_, i) => str(given[i], 80))
            results[it.id] = { correct: row }
            correct += row.filter(Boolean).length
            total += row.length
        }
    }
    return { results, correct, total, answers: clean }
}

/** Các câu đặt câu cần AI chấm (kèm câu học viên viết). */
function sentenceItems(sections, answers) {
    return sections
        .filter((s) => s.type === 'sentence')
        .flatMap((s) => s.items.map((it) => ({ id: it.id, word: it.word, image: it.image, sample: it.sample, answer: answers[it.id] || '' })))
}

module.exports = {
    BLANK_RE,
    DEFAULT_TITLES,
    cleanSections,
    studentSections,
    countItems,
    normalizeAnswer,
    gradeAuto,
    sentenceItems,
}
