function normalizeEmail(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase();
}

function isValidEmail(email) {
  // pragmatic validation for login flows
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

module.exports = {
  normalizeEmail,
  isValidEmail,
};
