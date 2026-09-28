import { serve } from '@hono/node-server'
import { Apis } from './apis.ts'
import { createApp } from './app.ts'
import { Auth } from './auth.ts'
import { loadConfig } from './config.ts'
import { openDb } from './db.ts'
import { Logs } from './logs.ts'
import { Sources } from './sources.ts'

process.umask(0o077) // the data directory holds keys and password hashes
const config = loadConfig()
const db = openDb(config.dbFile)
const auth = new Auth(db, config)
const sources = new Sources(db, config)
const apis = new Apis(db, sources, config)
const logs = new Logs(db)

const passwordFile = await auth.bootstrap()
if (passwordFile) console.log(`Initial admin password for "${config.adminUsername}" written to ${passwordFile}`)
apis.startSchedules()

const housekeeping = setInterval(() => {
  logs.prune(config.logRetentionDays)
  apis.pruneSyncHistory(config.logRetentionDays)
  auth.prune()
}, 60 * 60 * 1000)
housekeeping.unref()
logs.prune(config.logRetentionDays)
apis.pruneSyncHistory(config.logRetentionDays)

const app = createApp({ config, db, auth, sources, apis, logs })
const server = serve({ fetch: app.fetch, port: config.port }, info => {
  console.log(`DataBridge listening on port ${info.port} (time zone ${config.timezone})`)
})

async function shutdown() {
  apis.stopSchedules()
  server.close()
  await sources.closeAll()
  db.close()
  process.exit(0)
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
