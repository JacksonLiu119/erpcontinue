import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { pool, ensureProcurementSchema } from './db.js';
import { registerApi } from './routes.js';
import { authMiddleware, authorizationMiddleware, registerAuthRoutes } from './auth.js';

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', async (_req, res, next) => {
  try {
    await pool.query('SELECT 1 AS ok');
    res.json({ ok: true, db: true });
  } catch (error) {
    next(error);
  }
});

app.use('/api', authMiddleware, authorizationMiddleware);
registerAuthRoutes(app);
registerApi(app);

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({
    ok: false,
    error: error.message || 'Internal Server Error'
  });
});

const port = Number(process.env.PORT || 3000);
async function start() {
  await ensureProcurementSchema();
  app.listen(port, () => {
    console.log(`Inventory ERP running on http://127.0.0.1:${port}`);
  });
}
start().catch((error) => {
  console.error('ERP startup failed', error);
  process.exit(1);
});
