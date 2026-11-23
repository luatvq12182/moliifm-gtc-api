const jwt = require('jsonwebtoken')
const ExamAttempt = require('../models/ExamAttempt')
const { listeningSec, isEssay } = require('./examTest')

/**
 * LƯỢT LÀM ĐỀ — chia phần, đồng hồ máy chủ, câu nào sửa được lúc nào, vé
 * nghe file âm thanh.
 */

const SECTION_LABEL = { listening: 'Nghe', review: 'Xem lại đáp án phần nghe', reading: 'Đọc', writing: 'Viết' }
// Phần cho nộp sớm (khách chốt: đọc và viết).
const EARLY_FINISH = ['reading', 'writing']
// Hết giờ một phần: vẫn nhận câu trả lời của phần vừa hết thêm chừng này giây
// (lần lưu cuối của trình duyệt có thể tới trễ vì mạng).
const GRACE_MS = 15000

/** Các phần của một đề, bỏ phần không có câu nào / độ dài 0. */
function buildSections(test) {
    const has = (s) => (test.groups || []).some((g) => g.section === s)
    const out = []
    if (has('listening')) {
        out.push({ id: 'listening', durationSec: listeningSec(test) })
        if (test.timing.reviewSec > 0) out.push({ id: 'review', durationSec: test.timing.reviewSec })
    }
    if (has('reading')) out.push({ id: 'reading', durationSec: test.timing.readingSec })
    if (has('writing')) out.push({ id: 'writing', durationSec: test.timing.writingSec })
    return out.filter((s) => s.durationSec > 0)
}

const sectionEnd = (a) => new Date(new Date(a.sectionStartedAt).getTime() + (a.sections[a.sectionIndex]?.durationSec || 0) * 1000)

/**
 * Cho bài chạy tới thời điểm `now`: phần nào hết giờ thì sang phần sau (phần
 * sau bắt đầu đúng lúc phần trước hết), hết phần cuối thì nộp. Ghi lại nếu có
 * đổi, có kiểm tra để hai request cùng lúc không ghi chồng. Trả bản mới nhất.
 */
async function advance(attempt, now = new Date()) {
    for (let tries = 0; tries < 5; tries++) {
        if (attempt.status !== 'in_progress') return attempt
        let { sectionIndex } = attempt
        let startedAt = new Date(attempt.sectionStartedAt)
        let status = 'in_progress'
        let submittedAt = null
        while (status === 'in_progress') {
            const end = new Date(startedAt.getTime() + (attempt.sections[sectionIndex]?.durationSec || 0) * 1000)
            if (now < end) break
            sectionIndex += 1
            startedAt = end
            if (sectionIndex >= attempt.sections.length) {
                status = 'submitted'
                submittedAt = end
            }
        }
        if (sectionIndex === attempt.sectionIndex) return attempt
        const set = status === 'submitted'
            ? { status, submittedAt, submitReason: 'time', sectionIndex: attempt.sections.length - 1 }
            : { sectionIndex, sectionStartedAt: startedAt, sectionStartReason: 'time' }
        const updated = await ExamAttempt.findOneAndUpdate(
            { _id: attempt._id, status: 'in_progress', sectionIndex: attempt.sectionIndex },
            { $set: set },
            { new: true }
        ).lean()
        if (updated) {
            if (updated.status === 'submitted') require('./examGrading').onSubmitted(updated._id)
            return updated
        }
        attempt = await ExamAttempt.findById(attempt._id).lean() // request khác vừa ghi -> đọc lại
        if (!attempt) return null
    }
    return attempt
}

/** Nộp sớm phần đang làm (chỉ phần đọc / viết). */
async function finishEarly(attempt, sectionId, now = new Date()) {
    const cur = attempt.sections[attempt.sectionIndex]
    if (attempt.status !== 'in_progress' || cur?.id !== sectionId || !EARLY_FINISH.includes(sectionId)) return attempt
    const last = attempt.sectionIndex >= attempt.sections.length - 1
    const set = last
        ? { status: 'submitted', submittedAt: now, submitReason: 'early' }
        : { sectionIndex: attempt.sectionIndex + 1, sectionStartedAt: now, sectionStartReason: 'early' }
    const updated = await ExamAttempt.findOneAndUpdate(
        { _id: attempt._id, status: 'in_progress', sectionIndex: attempt.sectionIndex },
        { $set: set },
        { new: true }
    ).lean()
    // Lazy require: examGrading cũng dùng file này (quét bài quá giờ).
    if (updated?.status === 'submitted') require('./examGrading').onSubmitted(updated._id)
    return updated || (await ExamAttempt.findById(attempt._id).lean())
}

/** Câu thuộc phần nào của bài (nghe / đọc / viết) — phần "xem lại" sửa câu nghe. */
const editableSection = (sectionId) => (sectionId === 'review' ? 'listening' : sectionId)

/**
 * Số câu được sửa lúc này: câu của phần đang làm, cộng câu của phần VỪA HẾT
 * GIỜ trong vòng GRACE_MS.
 */
function editableNumbers(attempt, now = new Date()) {
    const allowed = new Set()
    if (attempt.status !== 'in_progress') return allowed
    const cur = attempt.sections[attempt.sectionIndex]
    const sections = [editableSection(cur?.id)]
    // Nộp sớm thì trình duyệt đã lưu hết trước khi bấm — không cần (và không nên) nhận thêm.
    if (attempt.sectionStartReason === 'time' && now - new Date(attempt.sectionStartedAt) < GRACE_MS && attempt.sectionIndex > 0) {
        sections.push(editableSection(attempt.sections[attempt.sectionIndex - 1].id))
    }
    for (const g of attempt.snapshot.groups) {
        if (sections.includes(g.section)) for (let n = g.from; n <= g.to; n++) allowed.add(n)
    }
    return allowed
}

/** Chuẩn hoá một câu trả lời theo kiểu câu. Trả null nếu không hợp lệ. */
function cleanAnswer(group, value) {
    const v = String(value ?? '')
    if (group.type === 'choice') {
        const a = v.trim().toUpperCase()
        return a === '' || (a.length === 1 && group.options.includes(a)) ? a : null
    }
    return v.slice(0, isEssay(group) ? 1500 : group.type === 'sentence' ? 300 : 50)
}

// Vé nghe: khoá riêng (không dùng lẫn được với token đăng nhập), hết hạn ngay
// sau khi hết phần nghe.
const audioSecret = () => `${process.env.JWT_SECRET}:exam-audio`

function signAudioToken(attempt) {
    const end = sectionEnd(attempt)
    const exp = Math.floor(end.getTime() / 1000) + 120
    return jwt.sign({ a: String(attempt._id), v: attempt.snapshot.audioVersion, exp }, audioSecret())
}

function verifyAudioToken(token) {
    try {
        return jwt.verify(String(token || ''), audioSecret())
    } catch {
        return null
    }
}

module.exports = {
    SECTION_LABEL,
    EARLY_FINISH,
    GRACE_MS,
    buildSections,
    sectionEnd,
    advance,
    finishEarly,
    editableSection,
    editableNumbers,
    cleanAnswer,
    signAudioToken,
    verifyAudioToken,
}
