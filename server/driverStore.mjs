import Database from 'better-sqlite3'

export function createDriverStore(databasePath = ':memory:') {
  const database = new Database(databasePath)
  database.pragma('journal_mode = WAL')
  database.exec(`
    CREATE TABLE IF NOT EXISTS employee_accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      username_key TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)
  const employeeColumns = new Set(database.pragma('table_info(employee_accounts)').map(({ name }) => name))
  if (!employeeColumns.has('phone')) {
    database.exec('ALTER TABLE employee_accounts ADD COLUMN phone TEXT')
  }
  if (!employeeColumns.has('plate')) {
    database.exec('ALTER TABLE employee_accounts ADD COLUMN plate TEXT')
  }
  if (!employeeColumns.has('car_name')) {
    database.exec('ALTER TABLE employee_accounts ADD COLUMN car_name TEXT')
  }
  database.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')

  return {
    getSetting(key) {
      return database.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null
    },
    setSetting(key, value) {
      database.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value)
    },
    createEmployee(employee) {
      database.prepare(`
        INSERT INTO employee_accounts (id, name, phone, plate, car_name, username_key, password_salt, password_hash, created_at)
        VALUES (@id, @name, @phone, @plate, @carName, @usernameKey, @passwordSalt, @passwordHash, @createdAt)
      `).run({
        ...employee,
        phone: employee.phone ?? null,
        plate: employee.plate ?? null,
        carName: employee.carName ?? null,
      })
      return {
        id: employee.id,
        name: employee.name,
        ...(employee.phone === undefined ? {} : { phone: employee.phone }),
        ...(employee.plate === undefined ? {} : { plate: employee.plate }),
        ...(employee.carName === undefined ? {} : { carName: employee.carName }),
        username: employee.usernameKey,
      }
    },
    findEmployeeByUsername(usernameKey) {
      return database.prepare(`
        SELECT
          id, name, phone, plate, car_name AS carName, username_key AS username, password_salt AS passwordSalt,
          password_hash AS passwordHash
        FROM employee_accounts WHERE username_key = ?
      `).get(usernameKey)
    },
    listAccounts() {
      return database.prepare(`
        SELECT
          id, name, phone, plate, car_name AS carName, username_key AS username, password_salt AS passwordSalt,
          password_hash AS passwordHash
        FROM employee_accounts ORDER BY created_at, name
      `).all()
    },
    listEmployees() {
      return database.prepare(`
        SELECT id, name, plate, car_name AS carName, username_key AS username
        FROM employee_accounts ORDER BY created_at, name
      `).all()
    },
    updateEmployee({ id, name, plate, carName, usernameKey, passwordSalt, passwordHash }) {
      if (passwordHash) {
        return database.prepare(`
          UPDATE employee_accounts
          SET name = @name, plate = @plate, car_name = @carName, username_key = @usernameKey,
            password_salt = @passwordSalt, password_hash = @passwordHash
          WHERE id = @id
        `).run({ id, name, plate, carName, usernameKey, passwordSalt, passwordHash }).changes > 0
      }
      return database.prepare('UPDATE employee_accounts SET name = @name, plate = @plate, car_name = @carName, username_key = @usernameKey WHERE id = @id')
        .run({ id, name, plate, carName, usernameKey }).changes > 0
    },
    deleteEmployee(id) {
      return database.prepare('DELETE FROM employee_accounts WHERE id = ?').run(id).changes > 0
    },
    close() {
      database.close()
    },
  }
}
