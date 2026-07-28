const Lesson = require('../models/Lesson')
const Course = require('../models/Course')
const Curriculum = require('../models/Curriculum')
const asyncHandler = require('../utils/asyncHandler')

// Chỉ lấy field nhẹ cho màn hình danh sách bài học — chưa cần kéo theo
// dialogue/vocabulary/exercises (nặng, chỉ cần khi vào đúng 1 bài cụ thể)
const LIST_FIELDS = 'title slug description order status createdAt updatedAt'

async function resolvePublishedCourse(curriculumSlug, courseSlug) {
    const curriculum = await Curriculum.findOne({ slug: curriculumSlug, status: 'published' })
    if (!curriculum) return null

    return Course.findOne({ curriculumId: curriculum._id, slug: courseSlug, status: 'published' })
}

const listPublicLessonsByCourse = asyncHandler(async function listPublicLessonsByCourse(req, res) {
    const course = await resolvePublishedCourse(req.params.curriculumSlug, req.params.courseSlug)
    if (!course) {
        res.status(404)
        throw new Error('Không tìm thấy khóa học.')
    }

    const lessons = await Lesson.find({ courseId: course._id, status: 'published' })
        .select(LIST_FIELDS)
        .sort({ order: 1 })

    res.json(lessons)
})

const getPublicLesson = asyncHandler(async function getPublicLesson(req, res) {
    const course = await resolvePublishedCourse(req.params.curriculumSlug, req.params.courseSlug)
    if (!course) {
        res.status(404)
        throw new Error('Không tìm thấy khóa học.')
    }

    const lesson = await Lesson.findOne({
        courseId: course._id,
        slug: req.params.lessonSlug,
        status: 'published',
    })
    if (!lesson) {
        res.status(404)
        throw new Error('Không tìm thấy bài học.')
    }

    res.json(lesson)
})

const listAdminLessons = asyncHandler(async function listAdminLessons(req, res) {
    const { courseId } = req.query
    const query = courseId ? { courseId } : {}
    const lessons = await Lesson.find(query).select(LIST_FIELDS).sort({ order: 1 })
    res.json(lessons)
})

const getAdminLesson = asyncHandler(async function getAdminLesson(req, res) {
    const lesson = await Lesson.findById(req.params.id)
    if (!lesson) {
        res.status(404)
        throw new Error('Không tìm thấy bài học.')
    }
    res.json(lesson)
})

const createLesson = asyncHandler(async function createLesson(req, res) {
    const { courseId, title, slug, description, videos, order, status, vocabulary, exercises } = req.body

    if (!courseId || !title || !slug) {
        res.status(400)
        throw new Error('Vui lòng chọn khóa học và nhập tiêu đề, slug bài học.')
    }

    const course = await Course.findById(courseId)
    if (!course) {
        res.status(400)
        throw new Error('Khóa học không tồn tại.')
    }

    const lesson = await Lesson.create({
        courseId,
        title,
        slug,
        description,
        videos,
        order,
        status,
        vocabulary,
        exercises,
    })

    res.status(201).json(lesson)
})

const updateLesson = asyncHandler(async function updateLesson(req, res) {
    const lesson = await Lesson.findById(req.params.id)
    if (!lesson) {
        res.status(404)
        throw new Error('Không tìm thấy bài học.')
    }

    const fields = ['title', 'slug', 'description', 'videos', 'order', 'status', 'vocabulary', 'exercises']
    fields.forEach((f) => {
        if (req.body[f] !== undefined) lesson[f] = req.body[f]
    })

    await lesson.save()
    res.json(lesson)
})

const toggleLessonStatus = asyncHandler(async function toggleLessonStatus(req, res) {
    const lesson = await Lesson.findById(req.params.id)
    if (!lesson) {
        res.status(404)
        throw new Error('Không tìm thấy bài học.')
    }

    lesson.status = lesson.status === 'published' ? 'draft' : 'published'
    await lesson.save()
    res.json(lesson)
})

const deleteLesson = asyncHandler(async function deleteLesson(req, res) {
    const lesson = await Lesson.findById(req.params.id)
    if (!lesson) {
        res.status(404)
        throw new Error('Không tìm thấy bài học.')
    }

    await lesson.deleteOne()
    res.json({ message: 'Đã xóa bài học.' })
})

module.exports = {
    listPublicLessonsByCourse,
    getPublicLesson,
    listAdminLessons,
    getAdminLesson,
    createLesson,
    updateLesson,
    toggleLessonStatus,
    deleteLesson,
}