function normalizePhone(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) return '';

  if (digits.length === 11 && digits.startsWith('8')) {
    return `7${digits.slice(1)}`;
  }
  if (digits.length === 10) {
    return `7${digits}`;
  }
  return digits;
}

function isValidPhone(rawPhone) {
  const normalized = normalizePhone(rawPhone);
  return /^7\d{10}$/.test(normalized);
}

module.exports = {
  normalizePhone,
  isValidPhone,
};
