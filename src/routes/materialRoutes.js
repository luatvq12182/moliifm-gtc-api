const express = require('express')
const {
    listMyCourses,
    getMyCourse,
    getMyDeck,
    getMyDeckPage,
    getMyVideo,
    getMyVideoThumb,
    saveMyVideoProgress,
    getMyExercise,
    submitMyExercise,
    regradeMyAttempt,
} = require('../controllers/materialController')
const { protectStudent } = require('../middleware/auth')

// Học liệu khoá học — phía học viên. Mọi hàm kiểm quyền theo khoá ở máy chủ.
const router = express.Router()
router.use(protectStudent)

router.get('/courses', listMyCourses)
router.get('/courses/:slug', getMyCourse)
router.get('/decks/:id', getMyDeck)
router.get('/decks/:id/pages/:n', getMyDeckPage)
router.get('/videos/:id', getMyVideo)
router.get('/videos/:id/thumb', getMyVideoThumb)
router.put('/videos/:id/progress', saveMyVideoProgress)
router.get('/courses/:slug/exercise', getMyExercise)
router.post('/courses/:slug/exercise/attempts', submitMyExercise)
router.post('/exercise-attempts/:id/regrade', regradeMyAttempt)

module.exports = router
