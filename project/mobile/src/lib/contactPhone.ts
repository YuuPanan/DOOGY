export function contactDialUrl(phone: string) {
  const number = phone.trim().replace(/[\s()-]/g, '');
  if (!/^\+?\d{3,20}$/.test(number)) throw new Error('此号码格式不支持直接拨号，请复制原始号码并在电话应用中核对。');
  return `tel:${number}`;
}
