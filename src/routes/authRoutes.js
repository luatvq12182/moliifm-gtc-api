const express = require('express')
const { login, getMe, studentLogin, getStudentMe } = require('../controllers/authController')
const { protectAdmin, protectStudent } = require('../middleware/auth')

const router = express.Router()

router.post('/login', login)
router.get('/me', protectAdmin, getMe)

router.post('/student/login', studentLogin)
router.get('/student/me', protectStudent, getStudentMe)

module.exports = router