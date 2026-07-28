const express = require('express')
const authRoutes = require('./authRoutes')
const studentRoutes = require('./studentRoutes')
const publicCatalogRoutes = require('./publicCatalogRoutes')
const adminCurriculumRoutes = require('./adminCurriculumRoutes')
const adminCourseRoutes = require('./adminCourseRoutes')
const adminLessonRoutes = require('./adminLessonRoutes')
const uploadRoutes = require('./uploadRoutes')

const router = express.Router()

router.get('/health', (req, res) => res.json({ status: 'ok' }))

router.use('/auth', authRoutes)
router.use('/students', studentRoutes)

// QUAN TRỌNG: đăng ký các route /admin/* TRƯỚC route public catch-all mount
// ở "/" bên dưới. publicCatalogRoutes mount ở "/" khớp với MỌI đường dẫn
// (kể cả /admin/...), nên middleware protectStudent bên trong nó sẽ chặn
// nhầm request của admin nếu đặt trước — phải để phần cụ thể hơn (/admin/*)
// chạy trước phần tổng quát hơn ("/").
router.use('/admin/curricula', adminCurriculumRoutes)
router.use('/admin/courses', adminCourseRoutes)
router.use('/admin/lessons', adminLessonRoutes)
router.use('/admin/uploads', uploadRoutes)

// Học viên xem (public, cần đăng nhập học viên — xem publicCatalogRoutes.js)
router.use('/', publicCatalogRoutes)

module.exports = router