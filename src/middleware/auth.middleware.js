const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
  try {
    const authHeader =
  req.headers.authorization ||
  req.headers.Authorization;

if (!authHeader) {
  console.log("❌ НЕТ ЗАГОЛОВКА", req.headers);
  return res.status(401).json({ error: 'No token' });
}

const token = authHeader.split(' ')[1];

if (!token) {
  console.log("❌ ПУСТОЙ ТОКЕН", authHeader);
  return res.status(401).json({ error: 'No token' });
}

    const decoded = jwt.verify(token, 'supersecret');

    req.user = decoded;

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};
