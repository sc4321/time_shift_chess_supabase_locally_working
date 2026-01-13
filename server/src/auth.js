import jwt from 'jsonwebtoken';

export function signJwt({ userId, username }, jwtSecret) {
  return jwt.sign({ sub: userId, username }, jwtSecret, { expiresIn: '30d' });
}

export function verifyJwt(token, jwtSecret) {
  return jwt.verify(token, jwtSecret);
}

export function getBearerToken(req) {
  const header = req.headers.authorization;
  if (!header) return null;
  const [kind, token] = header.split(' ');
  if (kind !== 'Bearer' || !token) return null;
  return token;
}