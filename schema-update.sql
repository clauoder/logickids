-- LOGICKIDS · ampliación de la base D1 existente
-- Ejecutar una sola vez en D1 > Console.

ALTER TABLE estudiantes ADD COLUMN username TEXT;
ALTER TABLE estudiantes ADD COLUMN pin_hash TEXT;
ALTER TABLE estudiantes ADD COLUMN pin_salt TEXT;
ALTER TABLE estudiantes ADD COLUMN course TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_estudiantes_username
ON estudiantes(username);

CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY,
  estudiante_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  creado_en TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (estudiante_id) REFERENCES estudiantes(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_diploma_estudiante
ON diplomas(estudiante_id);

-- El índice de progreso puede existir ya; esta orden es segura.
CREATE UNIQUE INDEX IF NOT EXISTS idx_progreso_unico
ON progreso(estudiante_id, aventura, reto);
