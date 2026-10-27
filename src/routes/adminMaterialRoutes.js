const express = require('express')
const c = require('../controllers/materialAdminController')
const { protectAdmin } = require('../middleware/auth')

// Học liệu khoá học — phía quản trị.
const router = express.Router()
router.use(protectAdmin)

router.get('/courses', c.listCourses)
router.post('/courses', c.createCourse)
router.put('/courses/:id', c.updateCourse)
router.delete('/courses/:id', c.deleteCourse)

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

router.get('/access', c.listAccess)
router.patch('/access', c.updateAccess)

module.exports = router
