import { serve } from '@hono/node-server'
import { Apis } from './apis.ts'
import { createApp } from './app.ts'
import { Auth } from './auth.ts'
import { loadConfig } from './config.ts'
import { openDb } from './db.ts'
import { Logs } from './logs.ts'
import { Sources } from './sources.ts'
import { Exports } from './exports.ts'

process.umask(0o077) // the data directory holds keys and password hashes
const config = loadConfig()
const db = openDb(config.dbFile)
const auth = new Auth(db, config)
const sources = new Sources(db, config)
const apis = new Apis(db, sources, config)
const logs = new Logs(db)
const exports = new Exports(config)
await exports.initialize()

const passwordFile = await auth.bootstrap()
if (passwordFile) console.log(`Initial admin password for "${config.adminUsername}" written to ${passwordFile}`)
apis.startSchedules()
apis.directory.start()

const housekeeping = setInterval(() => {
  logs.prune(config.logRetentionDays)
  apis.pruneSyncHistory(config.logRetentionDays)
  auth.prune()
}, 60 * 60 * 1000)
housekeeping.unref()
logs.prune(config.logRetentionDays)
apis.pruneSyncHistory(config.logRetentionDays)

const app = createApp({ config, db, auth, sources, apis, logs, exports })
const server = serve({ fetch: app.fetch, port: config.port }, info => {
  console.log(`DataBridge listening on port ${info.port} (time zone ${config.timezone})`)
})

const SHUTDOWN_GRACE_MS = 8000 // below Docker's default 10 s stop timeout

async function shutdown() {
  apis.stopSchedules()
  // Let in-flight calls finish and write their logs; streams still open after the grace period are cut.
  const grace = setTimeout(() => { if ('closeAllConnections' in server) server.closeAllConnections() }, SHUTDOWN_GRACE_MS)
  await new Promise(resolve => server.close(resolve))
  clearTimeout(grace)
  // Each step runs even if an earlier one fails, so the database is always closed.
  for (const step of [() => exports.close(), () => sources.closeAll(), () => db.close()]) {
    try {
      await step()
    } catch (error) {
      console.error('Shutdown step failed:', error)
    }
  }
  process.exit(0)
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
