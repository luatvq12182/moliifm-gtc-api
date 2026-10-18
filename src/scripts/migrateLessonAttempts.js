/**
 * Chuẩn hoá các bản ghi LessonAttempt tạo bởi bản đầu của tính năng.
 *
 *   npm run migrate:lesson-attempts            xem trước
 *   npm run migrate:lesson-attempts -- --apply sửa thật
 *
 * Hai việc:
 *
 *  1. `exercise.wrong` -> `exercise.answers`
 *     Bản đầu chỉ lưu CÂU SAI. Sau khi đổi sang lưu mọi câu, trường cũ không
 *     còn trong schema nên Mongoose không trả về nữa — bản ghi cũ mở ra sẽ
 *     trống trơn phần bài tập, trông như mất dữ liệu.
 *
 *     KHÔNG CỨU ĐƯỢC: các câu học viên làm ĐÚNG chưa bao giờ được ghi lại.
 *     Bản ghi sau khi chuyển vẫn nói "4/6 câu đúng" nhưng chỉ liệt kê được 2
 *     câu sai. Không có cách nào dựng lại 4 câu kia.
 *
 *  2. Điền `courseName` / `curriculumName`
 *     Bản đầu chỉ lưu slug. "Bài 1" một mình thì vô nghĩa vì mỗi khóa HSK đều
 *     có Bài 1. Tra ngược qua lessonId; bài học nào đã bị xoá thì đành bỏ
 *     trống, không có nguồn nào khác.
 */
require('dotenv').config()
const mongoose = require('mongoose')
const connectDB = require('../config/db')

const APPLY = process.argv.includes('--apply')

async function main() {
    await connectDB()
    const db = mongoose.connection.db
    // Đi thẳng qua driver: `wrong` đã bị gỡ khỏi schema nên Mongoose lọc nó đi.
    const col = db.collection('lessonattempts')

    const docs = await col
        .find({
            $or: [
                { 'videos.exercise.wrong': { $exists: true } },
                { courseName: { $in: [null, ''] } },
                { courseName: { $exists: false } },
                // courseThumbnail thêm sau courseName, nên bản ghi đã điền tên
                // vẫn có thể thiếu ảnh.
                { courseThumbnail: { $exists: false } },
            ],
        })
        .toArray()

    console.log(`\n${docs.length} bản ghi cần chuẩn hoá.\n`)
    if (docs.length === 0) return

    let changed = 0
    for (const d of docs) {
        const set = {}
        const notes = []

        // --- 1. wrong -> answers ---
        if ((d.videos || []).some((v) => Array.isArray(v.exercise?.wrong))) {
            let missing = 0
            set.videos = (d.videos || []).map((v) => {
                const e = v.exercise || {}
                if (!Array.isArray(e.wrong)) return v
                const answers = (e.answers || []).length
                    ? e.answers
                    // Mọi câu trong `wrong` đều là câu SAI — đó là toàn bộ ý
                    // nghĩa của trường cũ.
                    : e.wrong.map((w) => ({ ...w, correct: false }))
                missing += Math.max(0, (Number(e.total) || 0) - answers.length)
                const { wrong, ...rest } = e
                return { ...v, exercise: { ...rest, answers } }
            })
            notes.push(
                `wrong->answers` + (missing ? ` (thiếu ${missing} câu làm đúng, không dựng lại được)` : '')
            )
        }

        // --- 2. tên khóa / giáo trình ---
        if ((!d.courseName || d.courseThumbnail === undefined) && d.lesson) {
            const lesson = await db.collection('lessons').findOne({ _id: d.lesson }, { projection: { courseId: 1 } })
            const course = lesson && (await db.collection('courses').findOne({ _id: lesson.courseId }, { projection: { name: 1, thumbnail: 1, curriculumId: 1 } }))
            const curriculum = course && (await db.collection('curriculums').findOne({ _id: course.curriculumId }, { projection: { name: 1 } }))
            if (course) {
                set.courseName = course.name || ''
                set.courseThumbnail = course.thumbnail || ''
                set.curriculumName = (curriculum && curriculum.name) || ''
                notes.push(`khóa="${set.courseName}"` + (set.courseThumbnail ? ' + ảnh bìa' : ' (khóa chưa có ảnh bìa)'))
            } else {
                notes.push('không tra được tên khóa (bài học đã bị xoá?)')
            }
        }

        console.log(`  ${d._id}  ${d.lessonTitle || '(không tên)'}  —  ${notes.join(', ')}`)

        if (APPLY && Object.keys(set).length > 0) {
            await col.updateOne({ _id: d._id }, { $set: set })
            changed++
        }
    }

    console.log(
        APPLY ? `\nĐã sửa ${changed} bản ghi.\n` : '\nMới chỉ xem trước. Thêm --apply để sửa thật.\n'
    )
}

main()
    .catch((err) => {
        console.error('LỖI:', err.message)
        process.exitCode = 1
    })
    .finally(() => mongoose.disconnect())
