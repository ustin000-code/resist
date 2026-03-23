const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const userController = require('../controllers/user.controller');

router.get('/', auth, userController.getUsers);
router.post('/match', auth, userController.matchUsersByPhones);
router.get('/me', auth, userController.getMe);
router.patch('/me', auth, userController.patchMe);
router.get('/:userId/profile', auth, userController.getPeerProfile);

module.exports = router;
