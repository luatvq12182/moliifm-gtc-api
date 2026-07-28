const Course = require('../models/Course')
const Curriculum = require('../models/Curriculum')
const asyncHandler = require('../utils/asyncHandler')

const listPublicCoursesByCurriculum = asyncHandler(async function listPublicCoursesByCurriculum(req, res) {
    const curriculum = await Curriculum.findOne({ slug: req.params.curriculumSlug, status: 'published' })
    if (!curriculum) {
        res.status(404)
        throw new Error('Không tìm thấy giáo trình.')
    }

    const courses = await Course.find({ curriculumId: curriculum._id, status: 'published' }).sort({ order: 1 })
    res.json(courses)
})

const getPublicCourse = asyncHandler(async function getPublicCourse(req, res) {
    const curriculum = await Curriculum.findOne({ slug: req.params.curriculumSlug, status: 'published' })
    if (!curriculum) {
        res.status(404)
        throw new Error('Không tìm thấy giáo trình.')
    }

    const course = await Course.findOne({
        curriculumId: curriculum._id,
        slug: req.params.courseSlug,
        status: 'published',
    })
    if (!course) {
        res.status(404)
        throw new Error('Không tìm thấy khóa học.')
    }

    res.json(course)
})

const listAdminCourses = asyncHandler(async function listAdminCourses(req, res) {
    const { curriculumId } = req.query
    const query = curriculumId ? { curriculumId } : {}
    const courses = await Course.find(query).sort({ order: 1 })
    res.json(courses)
})

const createCourse = asyncHandler(async function createCourse(req, res) {
    const { curriculumId, name, slug, description, thumbnail, level, certificate, order, status } = req.body

    if (!curriculumId || !name || !slug) {
        res.status(400)
        throw new Error('Vui lòng chọn giáo trình và nhập tên, slug khóa học.')
    }

    const curriculum = await Curriculum.findById(curriculumId)
    if (!curriculum) {
        res.status(400)
        throw new Error('Giáo trình không tồn tại.')
    }

    const course = await Course.create({
        curriculumId,
        name,
        slug,
        description,
        thumbnail,
        level,
        certificate,
        order,
        status,
    })
    res.status(201).json(course)
})

const updateCourse = asyncHandler(async function updateCourse(req, res) {
    const course = await Course.findById(req.params.id)
    if (!course) {
        res.status(404)
        throw new Error('Không tìm thấy khóa học.')
    }

    const fields = ['name', 'slug', 'description', 'thumbnail', 'level', 'certificate', 'order', 'status']
    fields.forEach((f) => {
        if (req.body[f] !== undefined) course[f] = req.body[f]
    })

    await course.save()
    res.json(course)
})

const deleteCourse = asyncHandler(async function deleteCourse(req, res) {
    const course = await Course.findById(req.params.id)
    if (!course) {
        res.status(404)
        throw new Error('Không tìm thấy khóa học.')
    }

    await course.deleteOne()
    res.json({ message: 'Đã xóa khóa học.' })
})

module.exports = {
    listPublicCoursesByCurriculum,
    getPublicCourse,
    listAdminCourses,
    createCourse,
    updateCourse,
    deleteCourse,
}