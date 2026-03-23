const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const searchController = require('../controllers/search.controller');

router.get('/', auth, searchController.searchMessages);

module.exports = router;
