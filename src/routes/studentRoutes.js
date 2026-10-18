const express = require('express')
const {
  getStudents,
  getStudent,
  createStudent,
  updateStudent,
  toggleStudentStatus,
  resetStudentPassword,
  deleteStudent,
  resetStudentDevices,
} = require('../controllers/studentController')
const {
  getStudentPracticeAttempts,
  getPracticeAttemptAudio,
  deleteStudentPracticeAttempts,
} = require('../controllers/practiceAttemptController')
const {
  previewImport,
  commitImport,
  downloadTemplate,
} = require('../controllers/studentImportController')
const {
  listStudentLessonAttempts,
  getStudentLessonAttempt,
  getStudentRecording,
} = require('../controllers/lessonAttemptController')
const uploadSpreadsheet = require('../middleware/uploadSpreadsheet')
const { protectAdmin } = require('../middleware/auth')

const router = express.Router()

// Toàn bộ route quản lý học viên đều yêu cầu admin đã đăng nhập
router.use(protectAdmin)

router.get('/', getStudents)
router.post('/', createStudent)

// Nhập hàng loạt từ file Excel/CSV. Đặt TRƯỚC '/:id' vì Express khớp theo thứ
// tự — để sau thì 'import' bị hiểu là một id học viên.
router.get('/import/template', downloadTemplate)
router.post('/import/preview', uploadSpreadsheet.single('file'), previewImport)
router.post('/import/commit', uploadSpreadsheet.single('file'), commitImport)
router.get('/:id', getStudent)
router.put('/:id', updateStudent)
router.patch('/:id/status', toggleStudentStatus)
router.patch('/:id/reset-password', resetStudentPassword)
router.delete('/:id', deleteStudent)
router.patch('/:id/reset-devices', resetStudentDevices)

// Lịch sử hoàn thành bài học — màn đối chiếu chính của giáo viên.
router.get('/:id/lesson-attempts', listStudentLessonAttempts)
router.get('/:id/lesson-attempts/:attemptId', getStudentLessonAttempt)
router.get('/:id/recordings/:attemptId', getStudentRecording)

// Chi tiết từng lượt luyện nói (chấm từng chữ + ghi âm) của một học viên.
router.get('/:id/practice-attempts', getStudentPracticeAttempts)
router.get('/:id/practice-attempts/:attemptId/audio', getPracticeAttemptAudio)
router.delete('/:id/practice-attempts', deleteStudentPracticeAttempts)

module.exports = router
