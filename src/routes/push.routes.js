const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const pushController = require('../controllers/push.controller');

router.post('/register', auth, pushController.registerToken);
router.post('/unregister', auth, pushController.unregisterToken);

module.exports = router;
