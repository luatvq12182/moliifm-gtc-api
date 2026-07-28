const express = require('express')
const { listPublicCurricula, getPublicCurriculum } = require('../controllers/curriculumController')
const { listPublicCoursesByCurriculum, getPublicCourse } = require('../controllers/courseController')
const { listPublicLessonsByCourse, getPublicLesson } = require('../controllers/lessonController')
const { protectStudent } = require('../middleware/auth')

const router = express.Router()

// Toàn bộ route bên dưới giờ yêu cầu học viên đã đăng nhập — tên file/tên
// hàm vẫn giữ chữ "Public" (để đỡ phải đổi tên hàng loạt), nhưng thực chất
// không còn public nữa kể từ dòng router.use() này.
router.use(protectStudent)

// Giáo trình
router.get('/curricula', listPublicCurricula)
router.get('/curricula/:slug', getPublicCurriculum)

// Khóa học trong 1 giáo trình
router.get('/curricula/:curriculumSlug/courses', listPublicCoursesByCurriculum)
router.get('/curricula/:curriculumSlug/courses/:courseSlug', getPublicCourse)

// Bài học trong 1 khóa học
router.get('/curricula/:curriculumSlug/courses/:courseSlug/lessons', listPublicLessonsByCourse)
router.get('/curricula/:curriculumSlug/courses/:courseSlug/lessons/:lessonSlug', getPublicLesson)

module.exports = router