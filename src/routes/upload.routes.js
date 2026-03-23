const path = require('path');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const authMiddleware = require('../middleware/auth.middleware');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const safe = path.basename(file.originalname || 'file').replace(/[^a-zA-Z0-9._\-\u0400-\u04FF]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 МБ
});

router.post('/', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Файл не получен' });
  }

  const relativePath = `/uploads/${req.file.filename}`;

  res.json({
    fileUrl: relativePath,
    fileName: req.file.originalname,
    mimeType: req.file.mimetype,
    size: req.file.size,
  });
});

module.exports = router;
