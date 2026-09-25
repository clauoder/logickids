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
async function pbkdf2(pin, saltHex) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array((saltHex.match(/.{1,2}/g) || []).map(x => parseInt(x, 16)));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 120000 }, key, 256);
  return bytesToHex(bits);
}
async function hashPin(pin) {
  const salt = randomHex(16); return { salt, hash: await pbkdf2(pin, salt) };
}
function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}
async function sessionStudent(env, request) {
  const token = bearer(request); if (!token) return null;
  return await env.DB.prepare(`
    SELECT e.id, e.nombre AS name, e.username, e.course
    FROM sesiones s JOIN estudiantes e ON e.id=s.estudiante_id
    WHERE s.token=? AND datetime(s.expires_at) > datetime('now')
  `).bind(token).first();
}
async function progressRows(env, studentId) {
  const r = await env.DB.prepare(`
    SELECT aventura AS adventure_id, reto AS level, completado AS completed,
           fecha_completado AS completed_at
    FROM progreso WHERE estudiante_id=? ORDER BY id
  `).bind(studentId).all();
  return r.results || [];
}
async function issueDiplomaIfComplete(env, studentId) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS total,
           COUNT(DISTINCT aventura) AS adventures
    FROM progreso
    WHERE estudiante_id=? AND completado=1
  `).bind(studentId).first();
  if (Number(row?.total || 0) >= 60 && Number(row?.adventures || 0) >= 12) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO diplomas(estudiante_id, fecha_emision, docente, emitido)
      VALUES (?, date('now'), ?, 1)
    `).bind(studentId, TEACHER).run();
    return await env.DB.prepare(`SELECT fecha_emision, docente, emitido FROM diplomas WHERE estudiante_id=?`).bind(studentId).first();
  }
  return null;
}
async function handleLogin(env, request) {
  const { username, pin } = await request.json();
  if (!username || !pin) return json({ error: 'Escribe usuario y PIN.' }, 400);
  const st = await env.DB.prepare(`SELECT id, nombre AS name, username, course, pin_hash, pin_salt FROM estudiantes WHERE lower(username)=lower(?)`).bind(String(username).trim()).first();
  if (!st || !st.pin_hash || !st.pin_salt) return json({ error: 'Usuario o PIN incorrecto.' }, 401);
  const candidate = await pbkdf2(String(pin), st.pin_salt);
  if (candidate !== st.pin_hash) return json({ error: 'Usuario o PIN incorrecto.' }, 401);
  const token = randomHex(32);
  await env.DB.prepare(`INSERT INTO sesiones(token, estudiante_id, expires_at) VALUES (?, ?, datetime('now','+30 days'))`).bind(token, st.id).run();
  const progress = await progressRows(env, st.id);
  const diploma = await env.DB.prepare(`SELECT fecha_emision, docente, emitido FROM diplomas WHERE estudiante_id=?`).bind(st.id).first();
  return json({ token, student: { id: st.id, name: st.name, username: st.username, course: st.course }, progress, diploma: diploma || null });
}
async function handleMe(env, request) {
  const st = await sessionStudent(env, request); if (!st) return json({ error: 'Sesión no válida.' }, 401);
  const progress = await progressRows(env, st.id);
  const diploma = await env.DB.prepare(`SELECT fecha_emision, docente, emitido FROM diplomas WHERE estudiante_id=?`).bind(st.id).first();
  return json({ student: st, progress, diploma: diploma || null });
}
async function handleProgress(env, request) {
  const st = await sessionStudent(env, request); if (!st) return json({ error: 'Sesión no válida.' }, 401);
  const body = await request.json();
  const adventureId = String(body.adventureId || '').trim();
  const level = Number(body.level);
  if (!adventureId || !Number.isInteger(level) || level < 1 || level > 5) return json({ error: 'Reto no válido.' }, 400);

  await env.DB.prepare(`
    INSERT INTO progreso(estudiante_id, aventura, reto, completado, fecha_completado)
    VALUES (?, ?, ?, 1, datetime('now'))
    ON CONFLICT(estudiante_id, aventura, reto)
    DO UPDATE SET completado=1, fecha_completado=datetime('now')
  `).bind(st.id, adventureId, level).run();

  const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM progreso WHERE estudiante_id=? AND completado=1`).bind(st.id).first();
  const diploma = await issueDiplomaIfComplete(env, st.id);
  return json({ ok: true, stars: Number(count?.total || 0), diploma });
}
async function handleLogout(env, request) {
  const token = bearer(request); if (token) await env.DB.prepare('DELETE FROM sesiones WHERE token=?').bind(token).run();
  return json({ ok: true });
}
async function adminAuth(env, request) {
  return bearer(request) && bearer(request) === env.ADMIN_TOKEN;
}
async function handleAdminLogin(env, request) {
  const { password } = await request.json();
  if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) return json({ error: 'Clave incorrecta.' }, 401);
  return json({ token: env.ADMIN_TOKEN });
}
async function handleAdminStudents(env, request) {
  if (!(await adminAuth(env, request))) return json({ error: 'No autorizado.' }, 401);
  const r = await env.DB.prepare(`
    SELECT e.username, e.nombre AS name, e.course,
           SUM(CASE WHEN p.completado=1 THEN 1 ELSE 0 END) AS stars
    FROM estudiantes e LEFT JOIN progreso p ON p.estudiante_id=e.id
    GROUP BY e.id ORDER BY e.course, e.nombre
  `).all();
  return json({ students: r.results || [] });
}
function csvCell(v) { return `"${String(v ?? '').replaceAll('"','""')}"`; }
async function handleAdminCsv(env, request) {
  if (!(await adminAuth(env, request))) return json({ error: 'No autorizado.' }, 401);
  const r = await env.DB.prepare(`
    SELECT e.username, e.nombre AS name, e.course,
           SUM(CASE WHEN p.completado=1 THEN 1 ELSE 0 END) AS stars
    FROM estudiantes e LEFT JOIN progreso p ON p.estudiante_id=e.id
    GROUP BY e.id ORDER BY e.course, e.nombre
  `).all();
  const rows = [['Usuario','Nombre','Curso','Estrellas'], ...(r.results||[]).map(x=>[x.username,x.name,x.course,x.stars||0])];
  return text(rows.map(row=>row.map(csvCell).join(',')).join('\n'), 200, 'text/csv; charset=utf-8');
}
async function handleCreateStudent(env, request) {
  if (!(await adminAuth(env, request))) return json({ error: 'No autorizado.' }, 401);
  const { name, username, pin, course } = await request.json();
  if (!name || !username || !pin || !course) return json({ error: 'Faltan datos.' }, 400);
  const { salt, hash } = await hashPin(String(pin));
  try {
    const result = await env.DB.prepare(`INSERT INTO estudiantes(nombre, username, pin_hash, pin_salt, course) VALUES (?, ?, ?, ?, ?)`).bind(String(name).trim(), String(username).trim(), hash, salt, String(course).trim()).run();
    return json({ ok: true, id: result.meta?.last_row_id || null }, 201);
  } catch (e) {
    return json({ error: 'Ese usuario ya existe.' }, 409);
  }
}
async function handleDiploma(env, request) {
  const st = await sessionStudent(env, request); if (!st) return json({ error: 'Sesión no válida.' }, 401);
  const diploma = await issueDiplomaIfComplete(env, st.id);
  if (!diploma) return json({ error: 'El diploma se desbloquea al completar los 60 retos de las 12 aventuras.' }, 403);
  return json({ student: st, diploma });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '');
  const method = request.method.toUpperCase();
  try {
    if (method === 'POST' && path === 'login') return handleLogin(env, request);
    if (method === 'GET' && path === 'me') return handleMe(env, request);
    if (method === 'POST' && path === 'progress') return handleProgress(env, request);
    if (method === 'POST' && path === 'logout') return handleLogout(env, request);
    if (method === 'POST' && path === 'admin/login') return handleAdminLogin(env, request);
    if (method === 'GET' && path === 'admin/students') return handleAdminStudents(env, request);
    if (method === 'GET' && path === 'admin/report.csv') return handleAdminCsv(env, request);
    if (method === 'POST' && path === 'admin/student') return handleCreateStudent(env, request);
    if (method === 'GET' && path === 'diploma') return handleDiploma(env, request);
    return json({ error: 'Ruta no encontrada.' }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: 'Error interno de LOGICKIDS.' }, 500);
  }
}
