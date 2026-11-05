const express = require('express')
const c = require('../controllers/materialAdminController')
const v = require('../controllers/materialVideoAdminController')
const ai = require('../controllers/aiGradingAdminController')
const { protectAdmin } = require('../middleware/auth')

// Học liệu khoá học — phía quản trị.
const router = express.Router()
router.use(protectAdmin)

router.get('/courses', c.listCourses)
router.post('/courses', c.createCourse)
router.put('/courses/:id', c.updateCourse)
router.delete('/courses/:id', c.deleteCourse)
router.get('/courses/:id/exercise', c.getCourseExercise)
router.put('/courses/:id/exercise', c.saveCourseExercise)

router.get('/decks', c.listDecks)
router.post('/decks', c.createDeck)
router.post('/decks/google', c.createGoogleDeck)
// Đường dẫn cố định khai báo TRƯỚC đường dẫn có tham số.
router.put('/decks/reorder', c.reorderDecks)
router.get('/decks/:id', c.getDeck)
router.put('/decks/:id', c.updateDeck)
router.delete('/decks/:id', c.deleteDeck)
router.post('/decks/:id/file', c.replaceDeckFile)
router.post('/decks/:id/retry', c.retryDeck)
router.post('/decks/:id/sync', c.syncGoogleDeck)
router.get('/decks/:id/pages/:n', c.getDeckPage)

router.get('/videos', v.listVideos)
router.post('/videos', v.createVideo)
router.put('/videos/reorder', v.reorderVideos)
router.put('/videos/:id', v.updateVideo)
router.delete('/videos/:id', v.deleteVideo)
router.get('/videos/:id/thumb', v.getVideoThumb)

router.get('/ai-grading', ai.getAiGrading)
router.put('/ai-grading', ai.saveAiGrading)
router.post('/ai-grading/test', ai.testAiGrading)

router.get('/access', c.listAccess)
router.patch('/access', c.updateAccess)

module.exports = router
