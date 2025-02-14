import express from 'express';
import cors from 'cors';
import { routes } from './routes/index.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from '../modules/utils/index.js';

const app = express();

// 中间件
app.use(cors());
app.use(express.json());

// 路由
app.use('/api/v1', routes);

// 错误处理
app.use(errorHandler);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    logger.info(`API server running on port ${PORT}`);
}); 