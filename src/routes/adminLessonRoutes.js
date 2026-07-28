const express = require('express')
const {
    listAdminLessons,
    getAdminLesson,
    createLesson,
    updateLesson,
    toggleLessonStatus,
    deleteLesson,
} = require('../controllers/lessonController')
const { protectAdmin } = require('../middleware/auth')

const router = express.Router()
router.use(protectAdmin)

router.get('/', listAdminLessons)
router.get('/:id', getAdminLesson)
router.post('/', createLesson)
router.put('/:id', updateLesson)
router.patch('/:id/status', toggleLessonStatus)
router.delete('/:id', deleteLesson)

module.exports = router