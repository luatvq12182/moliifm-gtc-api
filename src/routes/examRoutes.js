const express = require('express')
const {
    listMyLevels,
    getMyLevel,
    getMyVideo,
    getMyVideoThumb,
    saveMyVideoProgress,
    getMyTest,
    startAttempt,
    getMyAttempt,
    saveMyAnswers,
    finishMySection,
    regradeMyAttempt,
    getMyAttemptPage,
    streamExamAudio,
} = require('../controllers/examController')
const { protectStudent } = require('../middleware/auth')

// Luyện thi HSK 3.0 — phía học viên. Mọi hàm kiểm quyền theo cấp thi ở máy chủ.
const router = express.Router()
// File nghe: thẻ <audio> không gửi được token đăng nhập -> dùng vé ký riêng
// cho từng lượt làm (xem streamExamAudio). Khai TRƯỚC protectStudent.
router.get('/audio/:token', streamExamAudio)
router.use(protectStudent)

router.get('/levels', listMyLevels)
router.get('/levels/:slug', getMyLevel)
router.get('/videos/:id', getMyVideo)
router.get('/videos/:id/thumb', getMyVideoThumb)
router.put('/videos/:id/progress', saveMyVideoProgress)
router.get('/tests/:id', getMyTest)
router.post('/tests/:id/attempts', startAttempt)
router.get('/attempts/:id', getMyAttempt)
router.put('/attempts/:id/answers', saveMyAnswers)
router.post('/attempts/:id/finish', finishMySection)
router.post('/attempts/:id/regrade', regradeMyAttempt)
router.get('/attempts/:id/pages/:n', getMyAttemptPage)

module.exports = router
