const express = require('express')
const authRoutes = require('./authRoutes')
const studentRoutes = require('./studentRoutes')
const publicCatalogRoutes = require('./publicCatalogRoutes')
const adminCurriculumRoutes = require('./adminCurriculumRoutes')
const adminCourseRoutes = require('./adminCourseRoutes')
const adminLessonRoutes = require('./adminLessonRoutes')
const uploadRoutes = require('./uploadRoutes')
const lessonAttemptRoutes = require('./lessonAttemptRoutes')
const materialRoutes = require('./materialRoutes')
const adminMaterialRoutes = require('./adminMaterialRoutes')

const router = express.Router()

router.get('/health', (req, res) => res.json({ status: 'ok' }))

// Cờ tính năng cho frontend. Công khai, không chứa gì nhạy cảm.
//
// Hiện không còn cờ nào: PRACTICE_HISTORY_ENABLED đã được gỡ khi lưu lịch sử
// luyện nói trở thành tính năng chính thức thay vì dữ liệu nghiệm thu. Giữ lại
// endpoint để giao diện không phải đổi và để còn chỗ cho cờ sau này.
router.get('/config', (req, res) => res.json({}))

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
router.use('/admin/materials', adminMaterialRoutes)
router.use('/admin/uploads', uploadRoutes)

// Lịch sử học của học viên. Mount ở '/lesson-attempts' nên phải đứng TRƯỚC
// publicCatalogRoutes (mount ở '/' và khớp mọi đường dẫn) — cùng lý do đã ghi
// ở khối comment phía trên.
router.use('/lesson-attempts', lessonAttemptRoutes)

// Học liệu khoá học (slide bài giảng). Cũng phải đứng TRƯỚC publicCatalogRoutes.
router.use('/materials', materialRoutes)

// Học viên xem (public, cần đăng nhập học viên — xem publicCatalogRoutes.js)
router.use('/', publicCatalogRoutes)

module.exports = router