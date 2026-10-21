/**
 * Lượt học ĐANG DỞ — phần dùng chung giữa HTTP (lưu tiến độ, hoàn thành bài)
 * và WebSocket chấm phát âm (mỗi lượt đọc gắn ngay vào lượt học đang dở).
 *
 * Xem chú thích đầu models/LessonAttempt.js về yêu cầu "làm đến đâu lưu đến
 * đó".
 */
const mongoose = require('mongoose')
const LessonAttempt = require('../models/LessonAttempt')
const PracticeAttempt = require('../models/PracticeAttempt')
const Lesson = require('../models/Lesson')
const Course = require('../models/Course')
const Curriculum = require('../models/Curriculum')
const { groupLineAttempts } = require('./lessonAttemptClaim')

const isId = (v) => Boolean(v) && mongoose.Types.ObjectId.isValid(String(v))
const text = (v, max) => String(v || '').slice(0, max)

/**
 * Tra ngược tên khóa học và giáo trình từ bài học.
 *
 * CHỤP LẠI TÊN, không chỉ lưu id: khóa có thể bị đổi tên hoặc xóa, nhưng lịch
 * sử phải đọc được nguyên vẹn mà không cần join tới bản ghi có thể đã biến mất.
 *
 * Tra ở máy chủ chứ không nhận từ client vì trang học chỉ có slug trên URL.
 *
 * Không tra được thì trả chuỗi rỗng, KHÔNG chặn: không được mất tiến độ của
 * học viên chỉ vì thiếu một cái nhãn.
 */
async function resolveCourseNames(lessonId) {
    try {
        const lesson = await Lesson.findById(lessonId).select('courseId').lean()
        if (!lesson) return { courseName: '', curriculumName: '' }
        const course = await Course.findById(lesson.courseId).select('name thumbnail curriculumId').lean()
        if (!course) return { courseName: '', curriculumName: '' }
        const curriculum = await Curriculum.findById(course.curriculumId).select('name').lean()
        return {
            courseName: course.name || '',
            courseThumbnail: course.thumbnail || '',
            curriculumName: (curriculum && curriculum.name) || '',
        }
    } catch (err) {
        console.error('[lessonProgress] Không tra được tên khóa:', err.message)
        return { courseName: '', curriculumName: '' }
    }
}

/** Bối cảnh bài học (slug, tiêu đề) lấy từ dữ liệu client, đã cắt độ dài. */
function lessonMeta(src = {}) {
    const meta = {
        curriculumSlug: text(src.curriculumSlug, 200),
        courseSlug: text(src.courseSlug, 200),
        lessonSlug: text(src.lessonSlug, 200),
        lessonTitle: text(src.lessonTitle, 300),
    }
    const order = Number(src.lessonOrder)
    if (Number.isFinite(order) && order > 0) meta.lessonOrder = order
    return meta
}

/**
 * Lấy lượt đang dở của (học viên, bài); chưa có thì tạo.
 *
 * AN TOÀN KHI GỌI ĐỒNG THỜI: lượt đọc đầu tiên (WebSocket) và lần lưu tiến độ
 * đầu tiên (HTTP) hay tới gần như cùng lúc, cả hai đều "tìm không thấy thì
 * tạo". Chỉ mục duy nhất `one_in_progress_per_lesson` chặn bản thứ hai; bên
 * thua nhận lỗi trùng khoá và đọc lại bản bên kia vừa tạo.
 */
async function ensureInProgress(studentId, lessonId, meta = {}) {
    if (!isId(lessonId)) return null
    const filter = { student: studentId, lesson: lessonId, status: 'in_progress' }

    const existing = await LessonAttempt.findOne(filter)
    if (existing) return existing

    const names = await resolveCourseNames(lessonId)
    try {
        return await LessonAttempt.create({
            ...filter,
            ...lessonMeta(meta),
            ...names,
            completedAt: null,
            activityAt: new Date(),
            progressPercent: 0,
        })
    } catch (err) {
        if (err && err.code === 11000) return LessonAttempt.findOne(filter)
        throw err
    }
}

/**
 * Gắn các lượt đọc còn "tạm" (lessonAttempt = null) của đúng bài này vào lượt
 * học. Đó là lượt đọc ghi bởi bản máy chủ cũ, hoặc khi chưa tạo được lượt học
 * vì lỗi thoáng qua — thiếu bước này thì chúng bị tác vụ dọn xoá sau 24 giờ.
 */
async function claimProvisional(attempt) {
    if (!attempt || !attempt.lesson) return 0
    const res = await PracticeAttempt.updateMany(
        { student: attempt.student, lesson: attempt.lesson, lessonAttempt: null },
        { $set: { lessonAttempt: attempt._id } }
    )
    return res.modifiedCount || 0
}

/** Mọi câu luyện nói của một lượt học, dựng lại từ dữ liệu máy chủ. */
async function spokenLinesOf(attemptId) {
    const readings = await PracticeAttempt.find({ lessonAttempt: attemptId })
        .select('videoIndex lineIndex pronScore referenceText referencePinyin createdAt')
        .lean()
    return groupLineAttempts(readings)
}

/**
 * Chỉ lấy đúng các trường đã biết từ câu trả lời client gửi lên.
 *
 * Cắt độ dài và chặn số lượng: dữ liệu từ trình duyệt mà phình to thì nằm lại
 * trong cơ sở dữ liệu mãi mãi.
 */
function cleanAnswers(raw) {
    if (!Array.isArray(raw)) return []
    return raw.slice(0, 200).map((w) => ({
        correct: Boolean(w?.correct),
        type: text(w?.type, 100),
        question: text(w?.question, 500),
        pinyin: text(w?.pinyin, 500),
        yourAnswer: text(w?.yourAnswer, 500),
        yourPinyin: text(w?.yourPinyin, 500),
        correctAnswer: text(w?.correctAnswer, 500),
        correctPinyin: text(w?.correctPinyin, 500),
        correction: text(w?.correction, 500),
        correctionPinyin: text(w?.correctionPinyin, 500),
    }))
}

/**
 * Gộp phần BÀI TẬP (client gửi) với phần LUYỆN NÓI (máy chủ dựng) theo video.
 *
 * Với lượt đang dở, `exercise.total` là số câu ĐÃ LÀM chứ không phải số câu
 * của cả video — "2/3 câu đúng" nghĩa là trong 3 câu đã làm.
 */
function buildVideos(rawVideos, spokenLines) {
    const list = Array.isArray(rawVideos) ? rawVideos.slice(0, 50) : []
    return list.map((v, i) => {
        const index = Number.isFinite(Number(v?.index)) ? Number(v.index) : i
        const lines = spokenLines.filter((l) => l.videoIndex === index)
        const scores = lines.map((l) => l.score).filter((n) => typeof n === 'number')
        const total = Number(v?.exercise?.total)

        return {
            index,
            title: text(v?.title, 200),
            exercise:
                Number.isFinite(total) && total > 0
                    ? {
                        correct: Math.max(0, Number(v.exercise.correct) || 0),
                        total,
                        answers: cleanAnswers(v.exercise.answers),
                    }
                    // Không có bài tập (hoặc chưa làm câu nào) -> null, KHÔNG
                    // phải 0/0: "0 điểm" cho phần chưa chấm là báo sai.
                    : { correct: null, total: null, answers: [] },
            speaking: {
                avgScore: scores.length
                    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
                    : null,
                lines,
            },
        }
    })
}

/**
 * Bù trạng thái cho bản ghi tạo trước khi có lượt đang dở: chúng đều là lượt
 * đã hoàn thành. Chạy mỗi lần máy chủ khởi động; lần thứ hai trở đi không còn
 * gì để sửa nên gần như không tốn gì — đỡ phải nhớ chạy script tay khi deploy.
 */
async function backfillLessonAttemptStatus() {
    try {
        const res = await LessonAttempt.collection.updateMany({ status: { $exists: false } }, [
            {
                $set: {
                    status: 'completed',
                    activityAt: { $ifNull: ['$completedAt', '$createdAt'] },
                    progressPercent: 100,
                },
            },
        ])
        if (res.modifiedCount) {
            console.log(`[lessonProgress] Đã bù trạng thái cho ${res.modifiedCount} lượt học cũ.`)
        }
    } catch (err) {
        console.error('[lessonProgress] Không bù được trạng thái lượt học cũ:', err.message)
    }
}

module.exports = {
    resolveCourseNames,
    lessonMeta,
    ensureInProgress,
    claimProvisional,
    spokenLinesOf,
    cleanAnswers,
    buildVideos,
    backfillLessonAttemptStatus,
}
