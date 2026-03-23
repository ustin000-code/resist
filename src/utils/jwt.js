const jwt = require('jsonwebtoken');

exports.generateToken = (user) => {
  return jwt.sign(
    { id: user.id },
    'supersecret',
    { expiresIn: '30d' }
  );
};

