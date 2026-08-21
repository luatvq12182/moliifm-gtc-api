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
const { protectAdmin } = require('../middleware/auth')

const router = express.Router()

// Toàn bộ route quản lý học viên đều yêu cầu admin đã đăng nhập
router.use(protectAdmin)

router.get('/', getStudents)
router.post('/', createStudent)
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
