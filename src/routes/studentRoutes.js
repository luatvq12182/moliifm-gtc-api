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

// Lịch sử luyện nói — chỉ hoạt động khi PRACTICE_HISTORY_ENABLED bật.
// Xem src/config/features.js.
router.get('/:id/practice-attempts', getStudentPracticeAttempts)
router.get('/:id/practice-attempts/:attemptId/audio', getPracticeAttemptAudio)
router.delete('/:id/practice-attempts', deleteStudentPracticeAttempts)

module.exports = router
