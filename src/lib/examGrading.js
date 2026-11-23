const ExamAttempt = require('../models/ExamAttempt')
const ExamTest = require('../models/ExamTest')
const ExamLevel = require('../models/ExamLevel')
const { normalizeAnswer } = require('./exercise')
const { gradeExamSentences, isAiConfigured } = require('./aiGrader')
const { testPagePath, sentenceMaxOr, isEssay } = require('./examTest')

/**
 * CHẤM BÀI LUYỆN THI.
 *
 *   - Câu chọn đáp án / viết chữ Hán: máy chấm ngay khi nộp, theo đáp án của
 *     đề lúc chấm (đáp án đúng được chép vào kết quả — admin sửa đáp án sau thì
 *     bài cũ giữ nguyên, tới khi admin bấm "chấm lại").
 *   - Câu đặt câu: AI CHO ĐIỂM (chạy nền vài chục giây), từ 0 tới điểm tối
 *     đa mỗi câu của đề (khách chốt 10); bỏ trống 0 điểm, không gửi AI.
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

// Bài chấm theo cách cũ (đạt / gần đạt / chưa đạt) -> quy ra điểm khi chấm lại.
const VERDICT_RATIO = { dat: 1, gan_dat: 2 / 3, chua_dat: 1 / 3 }
// Câu đặt câu được tính là "đạt" (đếm câu đạt, lọc câu sai) khi từ 60% điểm tối đa.
const PASS_RATIO = 0.6

/**
 * Tính kết quả từ câu trả lời + đáp án. `aiScores`: { no: { score, comment,
 * corrected } } AI đã chấm (giữ lại khi chỉ chấm lại phần máy chấm).
 */
function scoreAttempt(attempt, test, { aiScores = {}, ai = { status: 'none' } } = {}) {
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
                const cap = sentenceMaxOr(g)
                max[g.section] += cap
                const item = { type: g.type, given, max: cap, keyword: k.keyword || attempt.snapshot.keywords?.[no] || '', sample: k.sample || '' }
                if (isEssay(g)) Object.assign(item, { essay: true, minChars: g.minChars, hint: k.hint || '' })
                const v = aiScores[no]
                if (!given.trim()) {
                    Object.assign(item, { blank: true, score: 0, points: 0, ok: false, comment: isEssay(g) ? 'Bạn chưa viết bài này.' : 'Bạn chưa viết câu này.' })
                } else if (v) {
                    const score = Math.max(0, Math.min(cap, v.score ?? Math.round(cap * (VERDICT_RATIO[v.verdict] || 0))))
                    Object.assign(item, { score, points: score, ok: score >= cap * PASS_RATIO, comment: v.comment || '', corrected: v.corrected || '' })
                } else {
                    Object.assign(item, { score: null, points: 0, ok: false }) // chờ AI
                }
                if (item.ok) count[g.section][0]++
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

/** Câu đặt câu / đoạn văn cần AI chấm (có viết). */
function sentenceTodo(attempt, test) {
    const key = new Map((test?.items || []).map((it) => [it.no, it]))
    const out = []
    for (const g of attempt.snapshot.groups) {
        if (g.type !== 'sentence') continue
        for (let no = g.from; no <= g.to; no++) {
            const answer = String(attempt.answers?.[no] ?? '')
            if (!answer.trim()) continue
            const k = key.get(no) || {}
            out.push({
                id: String(no),
                examNo: no,
                word: k.keyword || attempt.snapshot.keywords?.[no] || '',
                sample: k.sample || '',
                hint: k.hint || '',
                answer,
                page: g.page || 0,
                max: sentenceMaxOr(g),
                essay: isEssay(g),
                minChars: g.minChars || 0,
            })
        }
    }
    return out
}

/** Cấp HSK (số) của cấp thi, vd. "hsk4" -> 4; không đoán được thì 3. */
async function levelNumber(levelId) {
    const level = await ExamLevel.findById(levelId).select('slug name').lean()
    return Number((`${level?.slug || ''} ${level?.name || ''}`.match(/hsk\s*([1-9])/i) || [])[1]) || 3
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
        const oldScores = {}
        for (const [no, it] of Object.entries(attempt.result?.items || {})) {
            if (it.type === 'sentence' && !it.blank && (it.score != null || (it.verdict && it.verdict !== 'blank'))) oldScores[no] = it
        }
        const todo = sentenceTodo(attempt, test)

        if (keepAi || todo.length === 0) {
            const result = scoreAttempt(attempt, test, {
                aiScores: keepAi ? oldScores : {},
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
            const level = await levelNumber(attempt.levelId)
            // Mỗi nhóm có thể có điểm tối đa khác nhau, đoạn văn chấm riêng -> gọi AI
            // theo từng loại (thường chỉ một, HSK4 là hai).
            const scores = {}
            let model = ''
            const kinds = new Map()
            for (const t of todo) {
                const kind = `${t.essay}:${t.max}`
                kinds.set(kind, [...(kinds.get(kind) || []), t])
            }
            for (const list of kinds.values()) {
                const { essay, max } = list[0]
                // Đoạn văn: đề bài là chữ, không cần gửi ảnh trang đề.
                const pageNos = essay ? [] : [...new Set(list.map((t) => t.page).filter(Boolean))]
                const pageImages = pageNos.map((n) => testPagePath(test, n - 1)).filter(Boolean)
                const graded = await gradeExamSentences(list, { maxScore: max, pageImages, essay, level })
                model = graded.model || model
                for (const t of list) scores[t.examNo] = graded.items[t.id]
            }
            result = scoreAttempt(attempt, test, { aiScores: scores, ai: { status: 'done', model, at: new Date() } })
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
