/**
 * Chấm lại toàn bộ lịch sử luyện nói bằng công thức HIỆN TẠI trong
 * lib/pronunciationScore.js.
 *
 * DÙNG KHI NÀO:
 *  1. Vừa đổi công thức/trọng số -> các bản ghi cũ vẫn mang điểm theo công thức
 *     cũ, để lẫn lộn thì không so sánh được với nhau nữa.
 *  2. Muốn thử một bộ trọng số mới trên dữ liệu THẬT trước khi chốt — chạy với
 *     --dry để chỉ xem kết quả, không ghi gì vào DB.
 *
 * Chạy được vì mỗi bản ghi đã lưu sẵn điểm GỐC của iFLYTEK (rawScores) và chi
 * tiết từng chữ (chars) — hai thứ đó là đầu vào của công thức. Không cần và
 * không bao giờ cần ghi âm lại.
 *
 *   node src/scripts/rescorePracticeAttempts.js --dry   # chỉ xem, không ghi
 *   node src/scripts/rescorePracticeAttempts.js         # ghi thật
 */

require('dotenv').config()
const mongoose = require('mongoose')
const connectDB = require('../config/db')
const PracticeAttempt = require('../models/PracticeAttempt')
const { computePronunciationScore } = require('../lib/pronunciationScore')
const { buildWordFeedback } = require('../lib/wordFeedback')
const { computeSpokenMatch } = require('../lib/spokenTextMatch')

const DRY_RUN = process.argv.includes('--dry')

async function main() {
    await connectDB()

    const attempts = await PracticeAttempt.find({}).sort({ createdAt: 1 })
    console.log(`\nTìm thấy ${attempts.length} lượt luyện nói.`)
    console.log(DRY_RUN ? 'CHẾ ĐỘ THỬ — không ghi gì vào DB.\n' : 'Đang ghi lại điểm...\n')

    let changed = 0
    let totalOld = 0
    let totalNew = 0
    let counted = 0

    for (const attempt of attempts) {
        const summary = {
            // total_score BẮT BUỘC phải có: điểm hiển thị giờ lấy thẳng từ nó.
            total_score: attempt.rawScores?.total_score,
            phone_score: attempt.rawScores?.phone_score,
            tone_score: attempt.rawScores?.tone_score,
            fluency_score: attempt.rawScores?.fluency_score,
            integrity_score: attempt.rawScores?.integrity_score,
            is_rejected: attempt.isRejected,
        }
        const score = computePronunciationScore(summary)

        // Siết trần theo đối chiếu IAT, giống hệt luồng chạy thật.
        const spokenMatch = computeSpokenMatch(attempt.referenceText, attempt.spokenText)
        let cappedFrom = null
        if (spokenMatch.cap !== null && typeof score.score === 'number' && score.score > spokenMatch.cap) {
            cappedFrom = score.score
            score.score = spokenMatch.cap
        }
        // Dựng lại luôn phần nhận xét theo từ cho các bản ghi cũ (chưa có).
        const wordFeedback = buildWordFeedback(attempt.chars || [], attempt.referencePinyin, attempt.referenceText)

        const oldScore = attempt.pronScore
        const newScore = score.score

        if (typeof oldScore === 'number' && typeof newScore === 'number') {
            totalOld += oldScore
            totalNew += newScore
            counted++
        }

        if (oldScore !== newScore) {
            changed++
            const arrow = `${String(oldScore ?? '--').padStart(3)} -> ${String(newScore ?? '--').padStart(3)}`
            const words = wordFeedback.words.map((w) => w.content).join('|')
            console.log(`  ${arrow}  [${wordFeedback.method}] ${words}`)
        }

        if (!DRY_RUN) {
            attempt.pronScore = score.score
            attempt.spokenMatch = {
                applicable: spokenMatch.applicable,
                ratio: spokenMatch.ratio,
                matched: spokenMatch.matched,
                total: spokenMatch.total,
                missedText: spokenMatch.missedText,
                cap: spokenMatch.cap,
                cappedFrom,
            }
            attempt.words = wordFeedback.words.map((w) => ({
                content: w.content,
                pinyin: w.pinyin,
                score: w.score,
                status: w.status,
                issue: w.issue,
            }))
            attempt.wordGroupingMethod = wordFeedback.method
            attempt.feedback = wordFeedback.feedback
            await attempt.save()
        }
    }

    console.log(`\n${changed}/${attempts.length} lượt có điểm thay đổi.`)
    if (counted > 0) {
        console.log(
            `Điểm trung bình: ${(totalOld / counted).toFixed(1)} -> ${(totalNew / counted).toFixed(1)}`
        )
    }
    console.log(DRY_RUN ? '\nChưa ghi gì. Bỏ --dry để ghi thật.\n' : '\nĐã ghi xong.\n')

    await mongoose.connection.close()
}

main().catch(async (err) => {
    console.error('Lỗi:', err.message)
    await mongoose.connection.close().catch(() => { })
    process.exit(1)
})
