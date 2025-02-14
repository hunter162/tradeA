import { Router } from 'express';
import { routes } from './routes/index.js';

const router = Router();

// 挂载所有路由
router.use('/', routes);

export { router }; 