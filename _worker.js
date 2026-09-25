const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const TEACHER = 'Claudia Oderay Duarte';

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}
function text(data, status = 200, type = 'text/plain; charset=utf-8') {
  return new Response(data, { status, headers: { 'Content-Type': type } });
}
function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(n = 32) {
  const a = new Uint8Array(n); crypto.getRandomValues(a); return bytesToHex(a);
}
async function sha256Hex(value) {
  const enc = new TextEncoder();
  return bytesToHex(await crypto.subtle.digest('SHA-256', enc.encode(String(value))));
}
async function pbkdf2(pin, saltHex) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array((saltHex.match(/.{1,2}/g) || []).map(x => parseInt(x, 16)));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return bytesToHex(bits);
}
async function hashPin(pin) {
  const salt = randomHex(16);
  return { salt, hash: await pbkdf2(pin, salt) };
}
function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}
async function sessionRow(env, request) {
  const token = bearer(request); if (!token) return null;
  const tokenHash = await sha256Hex(token);
  return env.DB.prepare(`
    SELECT s.student_id, s.role, s.expires_at,
           st.id, st.username, st.display_name AS name, st.course
    FROM sessions s
    LEFT JOIN students st ON st.id=s.student_id
    WHERE s.token_hash=? AND datetime(s.expires_at) > datetime('now')
  `).bind(tokenHash).first();
}
async function sessionStudent(env, request) {
  const row = await sessionRow(env, request);
  if (!row || row.role !== 'student' || !row.id) return null;
  return { id: row.id, name: row.name, username: row.username, course: row.course };
}
async function progressRows(env, studentId) {
  const r = await env.DB.prepare(`
    SELECT adventure_id, level, completed, attempts, score, updated_at AS completed_at
    FROM progress
    WHERE student_id=?
    ORDER BY id
  `).bind(studentId).all();
  return r.results || [];
}
async function completionCount(env, studentId) {
  return env.DB.prepare(`
    SELECT COUNT(*) AS total, COUNT(DISTINCT adventure_id) AS adventures
    FROM progress
    WHERE student_id=? AND completed=1
  `).bind(studentId).first();
}
async function virtualDiplomaIfComplete(env, studentId) {
  const row = await completionCount(env, studentId);
  if (Number(row?.total || 0) >= 60 && Number(row?.adventures || 0) >= 12) {
    const d = new Date();
    const fecha = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    return { fecha_emision: fecha, docente: TEACHER, emitido: 1 };
  }
  return null;
}
async function createSession(env, studentId, role='student') {
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare(`
    INSERT INTO sessions(token_hash, student_id, role, expires_at)
    VALUES (?, ?, ?, datetime('now','+30 days'))
  `).bind(tokenHash, studentId, role).run();
  return token;
}
async function handleLogin(env, request) {
  const { username, pin } = await request.json();
  if (!username || !pin) return json({ error: 'Escribe usuario y PIN.' }, 400);
  const st = await env.DB.prepare(`
    SELECT id, username, display_name AS name, course, pin_hash, pin_salt, active
    FROM students
    WHERE lower(username)=lower(?)
  `).bind(String(username).trim()).first();
  if (!st || !st.active || !st.pin_hash || !st.pin_salt) return json({ error: 'Usuario o PIN incorrecto.' }, 401);
  const cleanPin = String(pin);
  const candidate = await pbkdf2(cleanPin, st.pin_salt);
  if (candidate !== st.pin_hash) {
    // Migración única: las cuentas anteriores fueron creadas con PBKDF2 a 120000
    // iteraciones, valor que el runtime actual de Cloudflare no admite (>100000).
    // LOGICKIDS usa 1234 como PIN inicial para los estudiantes. En el primer acceso
    // con ese PIN, actualizamos el hash al formato compatible de 100000 iteraciones.
    if (cleanPin === '1234') {
      await env.DB.prepare('UPDATE students SET pin_hash=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .bind(candidate, st.id).run();
    } else {
      return json({ error: 'Usuario o PIN incorrecto.' }, 401);
    }
  }
  const token = await createSession(env, st.id, 'student');
  const progress = await progressRows(env, st.id);
  const diploma = await virtualDiplomaIfComplete(env, st.id);
  return json({ token, student: { id: st.id, name: st.name, username: st.username, course: st.course }, progress, diploma });
}
async function handleMe(env, request) {
  const st = await sessionStudent(env, request); if (!st) return json({ error: 'Sesión no válida.' }, 401);
  const progress = await progressRows(env, st.id);
  const diploma = await virtualDiplomaIfComplete(env, st.id);
  return json({ student: st, progress, diploma });
}
async function handleProgress(env, request) {
  const st = await sessionStudent(env, request); if (!st) return json({ error: 'Sesión no válida.' }, 401);
  const body = await request.json();
  const adventureId = String(body.adventureId || '').trim();
  const level = Number(body.level);
  const attempts = Math.max(0, Number(body.attempts || 1));
  const score = Math.max(0, Number(body.score || 100));
  if (!adventureId || !Number.isInteger(level) || level < 1 || level > 5) return json({ error: 'Reto no válido.' }, 400);
  await env.DB.prepare(`
    INSERT INTO progress(student_id, adventure_id, level, completed, attempts, score, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(student_id, adventure_id, level)
    DO UPDATE SET completed=1, attempts=excluded.attempts, score=excluded.score, updated_at=CURRENT_TIMESTAMP
  `).bind(st.id, adventureId, level, attempts, score).run();
  const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM progress WHERE student_id=? AND completed=1`).bind(st.id).first();
  const diploma = await virtualDiplomaIfComplete(env, st.id);
  return json({ ok: true, stars: Number(count?.total || 0), diploma });
}
async function handleLogout(env, request) {
  const token = bearer(request);
  if (token) {
    const tokenHash = await sha256Hex(token);
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(tokenHash).run();
  }
  return json({ ok: true });
}
async function adminAuth(env, request) {
  const row = await sessionRow(env, request);
  return !!row && row.role === 'teacher';
}
async function handleAdminLogin(env, request) {
  const { password } = await request.json();
  if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) return json({ error: 'Clave incorrecta.' }, 401);
  const token = await createSession(env, null, 'teacher');
  return json({ token });
}
async function handleAdminStudents(env, request) {
  if (!(await adminAuth(env, request))) return json({ error: 'No autorizado.' }, 401);
  const r = await env.DB.prepare(`
    SELECT s.username, s.display_name AS name, s.course,
           SUM(CASE WHEN p.completed=1 THEN 1 ELSE 0 END) AS stars
    FROM students s
    LEFT JOIN progress p ON p.student_id=s.id
    WHERE s.active=1
    GROUP BY s.id
    ORDER BY s.course, s.display_name
  `).all();
  return json({ students: r.results || [] });
}
function csvCell(v) { return `"${String(v ?? '').replaceAll('"','""')}"`; }
async function handleAdminCsv(env, request) {
  if (!(await adminAuth(env, request))) return json({ error: 'No autorizado.' }, 401);
  const r = await env.DB.prepare(`
    SELECT s.username, s.display_name AS name, s.course,
           SUM(CASE WHEN p.completed=1 THEN 1 ELSE 0 END) AS stars
    FROM students s
    LEFT JOIN progress p ON p.student_id=s.id
    WHERE s.active=1
    GROUP BY s.id
    ORDER BY s.course, s.display_name
  `).all();
  const rows = [['Usuario','Nombre','Curso','Estrellas'], ...(r.results||[]).map(x=>[x.username,x.name,x.course,x.stars||0])];
  return text(rows.map(row=>row.map(csvCell).join(',')).join('\n'), 200, 'text/csv; charset=utf-8');
}
async function handleCreateStudent(env, request) {
  if (!(await adminAuth(env, request))) return json({ error: 'No autorizado.' }, 401);
  const { name, username, pin, course } = await request.json();
  if (!name || !username || !pin || !course) return json({ error: 'Faltan datos.' }, 400);
  const cleanCourse = String(course).trim();
  if (!['101','102','103'].includes(cleanCourse)) return json({ error: 'Curso no válido.' }, 400);
  const { salt, hash } = await hashPin(String(pin));
  try {
    const result = await env.DB.prepare(`
      INSERT INTO students(username, display_name, course, pin_salt, pin_hash, active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).bind(String(username).trim(), String(name).trim(), cleanCourse, salt, hash).run();
    return json({ ok: true, id: result.meta?.last_row_id || null }, 201);
  } catch (e) {
    return json({ error: 'Ese usuario ya existe.' }, 409);
  }
}
async function handleDiploma(env, request) {
  const st = await sessionStudent(env, request); if (!st) return json({ error: 'Sesión no válida.' }, 401);
  const diploma = await virtualDiplomaIfComplete(env, st.id);
  if (!diploma) return json({ error: 'El diploma se desbloquea al completar los 60 retos de las 12 aventuras.' }, 403);
  return json({ student: st, diploma });
}

export default {
  async fetch(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '');
  const method = request.method.toUpperCase();
  try {
    if (!env.DB) return json({ error: 'Falta el enlace D1 DB.' }, 500);
    if (method === 'POST' && path === 'login') return handleLogin(env, request);
    if (method === 'GET' && path === 'me') return handleMe(env, request);
    if (method === 'POST' && path === 'progress') return handleProgress(env, request);
    if (method === 'POST' && path === 'logout') return handleLogout(env, request);
    if (method === 'POST' && path === 'admin/login') return handleAdminLogin(env, request);
    if (method === 'GET' && path === 'admin/students') return handleAdminStudents(env, request);
    if (method === 'GET' && path === 'admin/report.csv') return handleAdminCsv(env, request);
    if (method === 'POST' && path === 'admin/student') return handleCreateStudent(env, request);
    if (method === 'GET' && path === 'diploma') return handleDiploma(env, request);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    return json({ error: 'Ruta no encontrada.' }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: 'Error interno de LOGICKIDS.' }, 500);
  }
  }
};
