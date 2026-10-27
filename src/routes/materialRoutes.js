const express = require('express')
const { listMyCourses, getMyCourse, getMyDeck, getMyDeckPage } = require('../controllers/materialController')
const { protectStudent } = require('../middleware/auth')

// Học liệu khoá học — phía học viên. Mọi hàm kiểm quyền theo khoá ở máy chủ.
const router = express.Router()
router.use(protectStudent)

router.get('/courses', listMyCourses)
router.get('/courses/:slug', getMyCourse)
router.get('/decks/:id', getMyDeck)
router.get('/decks/:id/pages/:n', getMyDeckPage)

module.exports = router
