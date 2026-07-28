const express = require('express')
const { listAdminCourses, createCourse, updateCourse, deleteCourse } = require('../controllers/courseController')
const { protectAdmin } = require('../middleware/auth')

const router = express.Router()
router.use(protectAdmin)

router.get('/', listAdminCourses)
router.post('/', createCourse)
router.put('/:id', updateCourse)
router.delete('/:id', deleteCourse)

module.exports = router