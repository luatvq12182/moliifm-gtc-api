const ExamAttempt = require('../models/ExamAttempt')
const ExamTest = require('../models/ExamTest')
const { normalizeAnswer } = require('./exercise')
const { gradeSentences, isAiConfigured } = require('./aiGrader')
const { testPagePath } = require('./examTest')

/**
 * CHẤM BÀI LUYỆN THI.
 *
 *   - Câu chọn đáp án / viết chữ Hán: máy chấm ngay khi nộp, theo đáp án của
 *     đề lúc chấm (đáp án đúng được chép vào kết quả — admin sửa đáp án sau thì
 *     bài cũ giữ nguyên, tới khi admin bấm "chấm lại").
 *   - Câu đặt câu: AI chấm (chạy nền vài chục giây), mỗi mức đạt / gần đạt /
 *     chưa đạt một số điểm; bỏ trống 0 điểm, không gửi AI.
 *
 * Điểm mỗi phần làm tròn tới số nguyên; tổng = cộng điểm các phần (như phiếu
 * điểm HSK). Chưa chấm xong phần AI thì tổng là điểm TẠM.
 */

const SECTIONS = ['listening', 'reading', 'writing']
// Mỗi học viên được AI chấm tối đa chừng này bài / 24 giờ (chặn tốn tiền AI).
const AI_DAILY_LIMIT = () => Number(process.env.EXAM_AI_DAILY_LIMIT) || 10

const matches = (given, expected) =>
    String(expected || '')
        .split('/')
        .map(normalizeAnswer)
        .filter(Boolean)
        .includes(normalizeAnswer(given))

/**
 * Tính kết quả từ câu trả lời + đáp án. `aiVerdicts`: { no: { verdict, comment,
 * corrected } } đã có (giữ lại khi chỉ chấm lại phần máy chấm).
 */
function scoreAttempt(attempt, test, { aiVerdicts = {}, ai = { status: 'none' } } = {}) {
    const key = new Map((test?.items || []).map((it) => [it.no, it]))
    const answers = attempt.answers || {}
    const items = {}
    const raw = { listening: 0, reading: 0, writing: 0 }
    const max = { listening: 0, reading: 0, writing: 0 }
    const count = { listening: [0, 0], reading: [0, 0], writing: [0, 0] } // [đúng / đạt, tổng]
    for (const g of attempt.snapshot.groups) {
        for (let no = g.from; no <= g.to; no++) {
            const given = String(answers[no] ?? '')
            const k = key.get(no) || {}
            count[g.section][1]++
            if (g.type === 'sentence') {
                const vp = g.verdictPoints || {}
                max[g.section] += Number(vp.dat) || 0
                const item = { type: g.type, given, keyword: k.keyword || attempt.snapshot.keywords?.[no] || '', sample: k.sample || '' }
                if (!given.trim()) {
                    Object.assign(item, { verdict: 'blank', points: 0, comment: 'Bạn chưa viết câu này.' })
                } else if (aiVerdicts[no]) {
                    const v = aiVerdicts[no]
                    Object.assign(item, { verdict: v.verdict, comment: v.comment || '', corrected: v.corrected || '', points: Number(vp[v.verdict]) || 0 })
                    if (v.verdict === 'dat') count[g.section][0]++
                } else {
                    Object.assign(item, { verdict: null, points: 0 }) // chờ AI
                }
                raw[g.section] += item.points
                items[no] = item
                continue
            }
            const points = Number(g.points) || 0
            max[g.section] += points
            const ok = g.type === 'choice' ? Boolean(given) && given === String(k.answer || '') : Boolean(given.trim()) && matches(given, k.answer)
            if (ok) {
                raw[g.section] += points
                count[g.section][0]++
            }
            items[no] = { type: g.type, given, correct: k.answer || '', ok, points: ok ? points : 0 }
        }
    }
    const sections = {}
    let total = 0
    let maxTotal = 0
    for (const s of SECTIONS) {
        if (!count[s][1]) continue
        sections[s] = { score: Math.round(raw[s]), max: Math.round(max[s]), correct: count[s][0], total: count[s][1] }
        total += sections[s].score
        maxTotal += sections[s].max
    }
    const passScore = Number(test?.passScore) || 0
    return {
        gradedAt: new Date(),
        items,
        sections,
        total,
        max: maxTotal,
        passScore,
        passed: total >= passScore,
        ai,
    }
}

/** Câu đặt câu cần AI chấm (có viết). */
function sentenceTodo(attempt, test) {
    const key = new Map((test?.items || []).map((it) => [it.no, it]))
    const out = []
    for (const g of attempt.snapshot.groups) {
        if (g.type !== 'sentence') continue
        for (let no = g.from; no <= g.to; no++) {
            const answer = String(attempt.answers?.[no] ?? '')
            if (!answer.trim()) continue
            const k = key.get(no) || {}
            out.push({ id: String(no), examNo: no, word: k.keyword || attempt.snapshot.keywords?.[no] || '', sample: k.sample || '', hint: k.hint || '', answer, page: g.page || 0 })
        }
    }
    return out
}

const running = new Set()

/**
 * Chấm một bài đã nộp: phần máy chấm ngay, rồi cho AI chấm phần đặt câu.
 * `keepAi`: chỉ chấm lại phần máy chấm, giữ nguyên nhận xét AI cũ.
 * `ignoreLimit`: admin bấm chấm lại — không tính hạn mức AI mỗi ngày.
 * Không ném lỗi — lỗi AI ghi vào result.ai.
 */
async function gradeAttempt(attemptId, { keepAi = false, ignoreLimit = false } = {}) {
    const id = String(attemptId)
    if (running.has(id)) return null
    running.add(id)
    try {
        const attempt = await ExamAttempt.findById(id).lean()
        if (!attempt || attempt.status !== 'submitted') return null
        const test = await ExamTest.findById(attempt.testId).lean()
        const oldVerdicts = {}
        for (const [no, it] of Object.entries(attempt.result?.items || {})) {
            if (it.type === 'sentence' && it.verdict && it.verdict !== 'blank') oldVerdicts[no] = it
        }
        const todo = sentenceTodo(attempt, test)

        if (keepAi || todo.length === 0) {
            const result = scoreAttempt(attempt, test, {
                aiVerdicts: keepAi ? oldVerdicts : {},
                ai: todo.length === 0 ? { status: 'none' } : attempt.result?.ai || { status: 'none' },
            })
            await ExamAttempt.updateOne({ _id: id }, { $set: { result } })
            return result
        }

        // Phần AI.
        let aiState
        if (!isAiConfigured()) aiState = { status: 'unavailable' }
        else if (!ignoreLimit && (await aiUsedToday(attempt)) >= AI_DAILY_LIMIT()) aiState = { status: 'limited' }
        if (aiState) {
            const result = scoreAttempt(attempt, test, { ai: aiState })
            await ExamAttempt.updateOne({ _id: id }, { $set: { result } })
            return result
        }
        await ExamAttempt.updateOne({ _id: id }, { $set: { result: scoreAttempt(attempt, test, { ai: { status: 'pending', startedAt: new Date() } }) } })
        let result
        try {
            const pageNos = [...new Set(todo.map((t) => t.page).filter(Boolean))]
            const pageImages = pageNos.map((n) => testPagePath(test, n - 1)).filter(Boolean)
            const graded = await gradeSentences(todo, { pageImages })
            const verdicts = {}
            for (const t of todo) verdicts[t.examNo] = graded.items[t.id]
            result = scoreAttempt(attempt, test, { aiVerdicts: verdicts, ai: { status: 'done', model: graded.model, at: new Date() } })
        } catch (err) {
            result = scoreAttempt(attempt, test, { ai: { status: 'error', error: err.message.slice(0, 300), at: new Date() } })
        }
        await ExamAttempt.updateOne({ _id: id }, { $set: { result } })
        return result
    } finally {
        running.delete(id)
    }
}

/** Số bài của học viên này đã được AI chấm trong 24 giờ qua (không tính bài đang chấm). */
function aiUsedToday(attempt) {
    return ExamAttempt.countDocuments({
        student: attempt.student,
        _id: { $ne: attempt._id },
        'result.ai.status': { $in: ['done', 'error'] },
        'result.ai.at': { $gte: new Date(Date.now() - 24 * 3600 * 1000) },
    })
}

/** Bài vừa nộp -> chấm (chạy nền, không chặn request đang xử lý). */
function onSubmitted(attemptId) {
    setImmediate(() => gradeAttempt(attemptId).catch((err) => console.error('[examGrading]', err.message)))
}

/**
 * Quét định kỳ: bài quá giờ mà học viên bỏ đi (không ai mở lại) -> cho chạy
 * tới hiện tại để tự nộp + chấm; bài đã nộp mà chưa có kết quả / kẹt "đang
 * chấm" (máy chủ tắt giữa chừng) -> chấm lại.
 */
async function sweepExamAttempts() {
    const { advance } = require('./examAttempt')
    const open = await ExamAttempt.find({ status: 'in_progress' }).lean()
    for (const a of open) await advance(a)
    const stuck = await ExamAttempt.find({
        status: 'submitted',
        $or: [
            { result: { $exists: false } },
            { result: null },
            { 'result.ai.status': 'pending', 'result.ai.startedAt': { $lt: new Date(Date.now() - 5 * 60 * 1000) } },
        ],
    })
        .select('_id')
        .lean()
    for (const a of stuck) await gradeAttempt(a._id)
}

let sweeper = null
function startExamSweeper() {
    if (sweeper) return
    const run = () => sweepExamAttempts().catch((err) => console.error('[examGrading] quét:', err.message))
    run()
    sweeper = setInterval(run, 60 * 1000)
    sweeper.unref?.()
}

module.exports = { scoreAttempt, gradeAttempt, onSubmitted, sweepExamAttempts, startExamSweeper, AI_DAILY_LIMIT }
