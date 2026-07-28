const express = require('express')
const {
    listAdminCurricula,
    createCurriculum,
    updateCurriculum,
    deleteCurriculum,
} = require('../controllers/curriculumController')
const { protectAdmin } = require('../middleware/auth')

const router = express.Router()
router.use(protectAdmin)

router.get('/', listAdminCurricula)
router.post('/', createCurriculum)
router.put('/:id', updateCurriculum)
router.delete('/:id', deleteCurriculum)

module.exports = router