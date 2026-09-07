import 'dotenv/config'
import { createApp } from './index.js'

const PORT = process.env.PORT || 3100

const app = createApp()

app.listen(PORT, () => {
  console.log(`[job-hunter] Dev server running at http://localhost:${PORT}`)
})
