/**
 * Dời từ vựng + bài tập từ cấp BÀI HỌC xuống cấp VIDEO.
 *
 * BỐI CẢNH: khách hàng soạn một file docx cho mỗi video, và muốn học viên xem
 * video nào thì chỉ thấy nội dung của video ấy. Nội dung vì thế thuộc về video
 * chứ không thuộc về bài học — xem ghi chú trong models/Lesson.js.
 *
 * CHẠY THỬ trước (mặc định), xem in ra rồi mới ghi:
 *   npm run migrate:video-content
 *   npm run migrate:video-content -- --apply
 *
 * CHỈ TỰ ĐỘNG DỜI ĐƯỢC KHI BÀI CÓ ĐÚNG MỘT VIDEO.
 * Bài nhiều video thì không có cách nào đoán câu hỏi nào thuộc video nào —
 * đoán sai còn tệ hơn không làm. Những bài đó được liệt kê riêng để giảng viên
 * tự tách trong trang quản trị. Chúng vẫn chạy bình thường nhờ cơ chế lùi:
 * video chưa có nội dung riêng thì giao diện lấy tạm ở cấp bài học.
 */

require('dotenv').config()
const mongoose = require('mongoose')
const connectDB = require('../config/db')
const Lesson = require('../models/Lesson')

const TYPES = ['multipleChoice', 'trueFalse', 'sentenceOrder', 'shortAnswer']
const APPLY = process.argv.includes('--apply')

function countExercises(exercises) {
    return TYPES.reduce((sum, k) => sum + (exercises?.[k]?.length || 0), 0)
}

async function main() {
    await connectDB()

    // lean() = false: cần document thật để .save() chạy validate của schema.
    const lessons = await Lesson.find({})

    const moved = []
    const needsManualSplit = []
    const untouched = []

    for (const lesson of lessons) {
        const vocabCount = lesson.vocabulary?.length || 0
        const exCount = countExercises(lesson.exercises)

        if (vocabCount === 0 && exCount === 0) {
            untouched.push({ lesson, reason: 'không có nội dung ở cấp bài học' })
            continue
        }
        if ((lesson.videos?.length || 0) !== 1) {
            needsManualSplit.push({ lesson, vocabCount, exCount })
            continue
        }

        const video = lesson.videos[0]
        // KHÔNG ghi đè: video đã có nội dung riêng nghĩa là ai đó đã soạn rồi.
        if ((video.vocabulary?.length || 0) > 0 || countExercises(video.exercises) > 0) {
            untouched.push({ lesson, reason: 'video đã có nội dung riêng' })
            continue
        }

        moved.push({ lesson, video, vocabCount, exCount })

        if (APPLY) {
            video.vocabulary = lesson.vocabulary
            TYPES.forEach((k) => {
                video.exercises[k] = lesson.exercises?.[k] || []
            })
            lesson.vocabulary = []
            TYPES.forEach((k) => {
                lesson.exercises[k] = []
            })
            await lesson.save()
        }
    }

    const line = '─'.repeat(78)
    console.log('\n' + line)
    console.log(APPLY ? '  ĐÃ GHI VÀO CƠ SỞ DỮ LIỆU' : '  CHẠY THỬ — chưa ghi gì. Thêm --apply để ghi thật.')
    console.log(line + '\n')

    if (moved.length > 0) {
        console.log(`DỜI ĐƯỢC (${moved.length} bài):\n`)
        moved.forEach(({ lesson, video, vocabCount, exCount }) => {
            console.log(`  ${lesson.title}`)
            console.log(`     -> video "${video.title || 'không tên'}": ${vocabCount} từ vựng, ${exCount} câu hỏi`)
        })
        console.log()
    }

    if (needsManualSplit.length > 0) {
        console.log(`CẦN TÁCH TAY (${needsManualSplit.length} bài) — nhiều video, không đoán được:\n`)
        needsManualSplit.forEach(({ lesson, vocabCount, exCount }) => {
            console.log(`  ${lesson.title}  (${lesson.videos.length} video, ${vocabCount} từ vựng, ${exCount} câu hỏi)`)
            console.log('     Vẫn chạy bình thường nhờ cơ chế lùi. Tách trong trang quản trị khi rảnh.')
        })
        console.log()
    }

    if (untouched.length > 0) {
        console.log(`BỎ QUA (${untouched.length} bài):\n`)
        untouched.forEach(({ lesson, reason }) => console.log(`  ${lesson.title} — ${reason}`))
        console.log()
    }

    if (!APPLY && moved.length > 0) {
        console.log('Xem ổn thì chạy lại với:  npm run migrate:video-content -- --apply\n')
    }

    await mongoose.connection.close()
}

main().catch((err) => {
    console.error('\nLỖI:', err.message, '\n')
    process.exit(1)
})
