import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const ROOT = dirname(fileURLToPath(import.meta.url));
const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const SESSION_MS = 8 * 60 * 60 * 1000;
export const SERVICES = Object.freeze({
  automation: { title: 'AI-автоматизация процессов', price: '80–300 тыс. ₽', unit: 'за проект' },
  website: { title: 'Сайты и веб-разработка', price: '180–600 тыс. ₽', unit: 'за проект' },
  crm: { title: 'CRM и автоматизация продаж', price: '85–300 тыс. ₽', unit: 'за внедрение' },
  video: { title: 'AI-видео и рекламный контент', price: '60–150 тыс. ₽', unit: 'за ролик' },
  qa: { title: 'Тестирование сайтов и приложений', price: '30–100 тыс. ₽', unit: 'за этап' },
  saas: { title: 'SaaS и запуск цифрового продукта', price: '500 тыс.–1,5 млн ₽', unit: 'за MVP' }
});
const STATUSES = ['new', 'in_progress', 'done', 'archived'];
const BUDGETS = ['Пока не определён', 'До 100 000 ₽', '100 000–300 000 ₽', '300 000–700 000 ₽', '700 000–1 500 000 ₽', 'От 1 500 000 ₽'];
const RECIPIENTS = ['С менеджером', 'С руководителем проекта'];
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function requireText(value, label, min, max) {
  if (typeof value !== 'string') throw new HttpError(400, `Проверь поле «${label}».`);
  const text = value.trim();
  if (text.length < min || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new HttpError(400, `Проверь поле «${label}»: от ${min} до ${max} символов.`);
  return text;
}
function validateRequest(body) {
  const name = requireText(body.name, 'Имя', 2, 80);
  const company = requireText(body.company ?? '', 'Компания', 0, 120);
  const contact = requireText(body.contact, 'Контакт', 5, 160);
  const phoneDigits = contact.replace(/\D/g, '');
  const phoneValid = /^\+?[\d\s()\-]{7,30}$/.test(contact) && phoneDigits.length >= 7 && phoneDigits.length <= 15;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) && !/^@[A-Za-z0-9_]{5,32}$/.test(contact) && !phoneValid) throw new HttpError(400, 'Укажи email, телефон или Telegram в формате @username.');
  const task = requireText(body.task, 'Задача', 10, 3000);
  if (!BUDGETS.includes(body.budget) || !RECIPIENTS.includes(body.recipient)) throw new HttpError(400, 'Выбери бюджет и получателя из списка.');
  if (!Array.isArray(body.services) || body.services.length > 6 || body.services.some(id => typeof id !== 'string' || !Object.hasOwn(SERVICES, id))) throw new HttpError(400, 'В списке есть недоступная услуга. Обнови страницу и выбери услуги заново.');
  if (body.website) throw new HttpError(400, 'Не удалось принять заявку.');
  const ids = [...new Set(body.services)].sort();
  return { name, company, contact, task, budget: body.budget, recipient: body.recipient, services: ids.map(id => ({ id, ...SERVICES[id] })) };
}
async function bodyJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Ожидается JSON.');
  let size = 0; const parts = [];
  for await (const part of req) { size += part.length; if (size > 16384) throw new HttpError(413, 'Заявка слишком большая.'); parts.push(part); }
  try { const body = JSON.parse(Buffer.concat(parts).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error(); return body; }
  catch { throw new HttpError(400, 'Некорректные данные.'); }
}
function send(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
function rowToRequest(row) {
  return { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, status: row.status, version: row.version, ...JSON.parse(row.payload) };
}

export function createApp({ dbPath = join(ROOT, 'data/dmd.sqlite') } = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK(id=1), login TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, payload_hash TEXT NOT NULL, payload TEXT NOT NULL, search_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','in_progress','done','archived')), version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS requests_date ON requests(created_at DESC);
    CREATE INDEX IF NOT EXISTS requests_status ON requests(status);`);
  const limits = new Map();
  function rate(req, bucket, max) {
    const key = `${bucket}:${req.socket.remoteAddress}`; const now = Date.now();
    let state = limits.get(key);
    if (!state || state.until <= now) { state = { n: 0, until: now + 15 * 60 * 1000 }; limits.set(key, state); }
    if (++state.n > max) throw new HttpError(429, 'Слишком много попыток. Попробуй через 15 минут.');
  }
  function sessionToken(req) { return (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('dmd_session='))?.slice(12) || ''; }
  function authenticated(req) {
    const token = sessionToken(req); if (!/^[a-f0-9]{64}$/.test(token)) return false;
    return !!db.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires>?').get(digest(token), Date.now());
  }
  function requireAdmin(req) { if (!authenticated(req)) throw new HttpError(401, 'Войди в админку.'); }
  function issueSession(res) {
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES (?,?)').run(digest(token), Date.now() + SESSION_MS);
    res.setHeader('Set-Cookie', `dmd_session=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${SESSION_MS / 1000}`);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    try {
      const port = server.address()?.port;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) throw new HttpError(403, 'Недопустимый адрес сервера.');
      const origin = `http://${req.headers.host}`;
      const url = new URL(req.url, origin), path = url.pathname;
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Запрос с другого сайта запрещён.');
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) throw new HttpError(403, 'Отправляй форму с сайта DMD.');
      if (req.method === 'GET' && path === '/api/health') return send(res, 200, { ok: true, application: 'dmd-local' });
      if (req.method === 'POST' && path === '/api/requests') {
        const body = await bodyJson(req), payload = validateRequest(body);
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[a-f0-9-]{36}$/i.test(key)) throw new HttpError(400, 'Не удалось определить номер отправки. Обнови страницу.');
        const encoded = JSON.stringify(payload), hash = digest(encoded);
        const previous = db.prepare('SELECT id,payload_hash FROM requests WHERE request_key=?').get(key);
        if (previous) { if (previous.payload_hash !== hash) throw new HttpError(409, 'Состав заявки изменился. Отправь её повторно.'); return send(res, 200, { id: previous.id, received: true }); }
        rate(req, 'requests', 20);
        const id = `DMD-${randomUUID()}`, date = new Date().toISOString();
        db.prepare('INSERT INTO requests (id,request_key,payload_hash,payload,search_text,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, key, hash, encoded, encoded.toLocaleLowerCase('ru'), date, date);
        return send(res, 201, { id, received: true });
      }
      if (req.method === 'GET' && path === '/api/admin/session') {
        const admin = db.prepare('SELECT login FROM admin WHERE id=1').get();
        return send(res, 200, { setupRequired: !admin, authenticated: authenticated(req), login: authenticated(req) ? admin?.login : undefined });
      }
      if (req.method === 'POST' && ['/api/admin/setup', '/api/admin/login'].includes(path)) {
        rate(req, 'login', 12);
        const body = await bodyJson(req);
        const login = requireText(body.login, 'Логин', 3, 50).toLowerCase();
        if (!/^[a-z0-9._-]+$/.test(login)) throw new HttpError(400, 'Логин: латинские буквы, цифры, точка, дефис или подчёркивание.');
        const password = requireText(body.password, 'Пароль', path.endsWith('setup') ? 12 : 1, 128);
        const admin = db.prepare('SELECT * FROM admin WHERE id=1').get();
        if (path.endsWith('setup')) {
          if (admin) throw new HttpError(409, 'Администратор уже создан. Войди с логином и паролем.');
          const salt = randomBytes(16).toString('hex'), hash = (await derive(password, salt, 64)).toString('hex');
          // Recheck after async hashing so concurrent setup requests cannot replace an account.
          if (db.prepare('SELECT id FROM admin WHERE id=1').get()) throw new HttpError(409, 'Администратор уже создан.');
          db.prepare('INSERT INTO admin VALUES (1,?,?,?)').run(login, salt, hash);
        } else {
          const hash = await derive(password, admin?.salt || 'dmd-invalid-login-salt', 64);
          if (!admin || login !== admin.login || !timingSafeEqual(hash, Buffer.from(admin.password_hash, 'hex'))) throw new HttpError(401, 'Неверный логин или пароль.');
        }
        issueSession(res); return send(res, 200, { authenticated: true, login });
      }
      if (path.startsWith('/api/admin/')) {
        requireAdmin(req);
        if (req.method === 'POST' && path === '/api/admin/logout') {
          db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(sessionToken(req)));
          res.setHeader('Set-Cookie', 'dmd_session=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0');
          return send(res, 200, { ok: true });
        }
        if (req.method === 'GET' && path === '/api/admin/requests') {
          const status = url.searchParams.get('status') || 'all', query = (url.searchParams.get('q') || '').trim().slice(0, 160);
          const page = Number(url.searchParams.get('page') || 1);
          if (!['all', ...STATUSES].includes(status) || !Number.isInteger(page) || page < 1 || page > 100000) throw new HttpError(400, 'Некорректный фильтр.');
          const clauses = [], args = [];
          if (status !== 'all') { clauses.push('status=?'); args.push(status); }
          if (query) { clauses.push('(instr(search_text,?)>0 OR instr(lower(id),?)>0)'); args.push(query.toLocaleLowerCase('ru'), query.toLocaleLowerCase('ru')); }
          const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
          const total = db.prepare(`SELECT count(*) AS n FROM requests${where}`).get(...args).n;
          const items = db.prepare(`SELECT * FROM requests${where} ORDER BY created_at DESC,id DESC LIMIT 30 OFFSET ?`).all(...args, (page - 1) * 30).map(rowToRequest);
          const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
          for (const row of db.prepare('SELECT status,count(*) AS n FROM requests GROUP BY status').all()) counts[row.status] = row.n;
          return send(res, 200, { items, total, page, pages: Math.max(1, Math.ceil(total / 30)), counts });
        }
        const match = path.match(/^\/api\/admin\/requests\/(DMD-[a-f0-9-]{36})$/);
        if (match && req.method === 'PATCH') {
          const body = await bodyJson(req);
          if (!STATUSES.includes(body.status) || !Number.isInteger(body.version)) throw new HttpError(400, 'Некорректный статус.');
          const result = db.prepare('UPDATE requests SET status=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(body.status, new Date().toISOString(), match[1], body.version);
          if (!result.changes) throw new HttpError(409, 'Заявка уже обновлена. Обнови список перед изменением.');
          return send(res, 200, rowToRequest(db.prepare('SELECT * FROM requests WHERE id=?').get(match[1])));
        }
      }
      if (['GET', 'HEAD'].includes(req.method) && ['/', '/index.html', '/admin', '/admin/', '/admin.html'].includes(path)) {
        const html = readFileSync(join(ROOT, 'dist', path.startsWith('/admin') ? 'admin.html' : 'index.html'), 'utf8');
        const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`).join(' ');
        res.setHeader('Content-Security-Policy', `default-src 'self'; script-src ${hashes}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(req.method === 'HEAD' ? '' : html);
      }
      throw new HttpError(404, 'Страница не найдена.');
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 429) res.setHeader('Retry-After', '900');
      send(res, status, { error: status === 500 ? 'Не удалось сохранить данные. Попробуй ещё раз.' : error.message });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('PORT должен быть от 1024 до 65535.');
  const app = createApp({ dbPath: process.env.DMD_DB_PATH || join(ROOT, 'data/dmd.sqlite') });
  app.on('error', err => { console.error(err.code === 'EADDRINUSE' ? `Порт ${port} уже занят. Закрой другой сервер или укажи PORT.` : 'Не удалось запустить DMD.'); process.exitCode = 1; });
  app.listen(port, '127.0.0.1', () => console.log(`DMD запущен локально.\nСайт: http://127.0.0.1:${port}\nАдминка: http://127.0.0.1:${port}/admin\nОстановка: Ctrl+C`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { app.close(); app.closeIdleConnections(); });
}
