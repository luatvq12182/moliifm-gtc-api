const express = require('express')
const {
    createLessonAttempt,
    getCurrentAttempt,
    saveCurrentAttempt,
    discardCurrentAttempt,
    listMyLessonAttempts,
    getMyLessonAttempt,
    getMyRecording,
} = require('../controllers/lessonAttemptController')
const { protectStudent } = require('../middleware/auth')

const router = express.Router()

// Lịch sử học của CHÍNH học viên đang đăng nhập. Mọi hàm trong controller đều
// lọc theo req.student._id ngay trong truy vấn, nên không có đường nào đọc
// được lịch sử của người khác bằng cách đổi id trên URL.
router.use(protectStudent)

router.post('/', createLessonAttempt)
router.get('/', listMyLessonAttempts)

// Lượt ĐANG DỞ của một bài: lấy về để học tiếp, lưu tiến độ, bỏ để học lại.
// Đặt TRƯỚC '/:id' — để sau thì 'current' bị hiểu là một id lượt học.
router.get('/current', getCurrentAttempt)
router.put('/current', saveCurrentAttempt)
router.delete('/current', discardCurrentAttempt)

// Đặt TRƯỚC '/:id' — để sau thì 'recordings' bị hiểu là một id lượt học.
router.get('/recordings/:attemptId', getMyRecording)
router.get('/:id', getMyLessonAttempt)

module.exports = router
