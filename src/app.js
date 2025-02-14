import express from 'express';
import cors from 'cors';
import { errorHandler } from './api/middleware/errorHandler.js';
import { logger } from './modules/utils/index.js';

export function createApp(routes, services) {
    try {
        // 创建 Express 应用
        const app = express();
        logger.info('Express 实例创建成功');

        // 初始化 app.locals
        app.locals = {
            services
        };
        
        // 基础中间件
        app.use(cors());
        app.use(express.json());
        app.use(express.urlencoded({ extended: true }));

        // 日志中间件
        app.use((req, res, next) => {
            logger.info(`${req.method} ${req.path}`, {
                query: req.query,
                body: req.method === 'GET' ? undefined : req.body
            });
            next();
        });

        // API 路由
        if (routes) {
            app.use('/api/v1', routes);
            logger.info('API 路由已挂载');
        }

        // 静态文件
        app.use(express.static('public'));

        // 错误处理
        app.use(errorHandler);

        // 404 处理
        app.use((req, res) => {
            res.status(404).json({
                success: false,
                error: 'Not Found',
                path: req.originalUrl
            });
        });

        logger.info('Express 应用配置完成');
        return app;
    } catch (error) {
        logger.error('Express 应用创建失败:', {
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
} 