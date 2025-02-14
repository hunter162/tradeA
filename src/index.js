import db from './modules/db/connection.js';
import { createApp } from './app.js';
import { logger } from './modules/utils/index.js';
import express from 'express';
import cors from 'cors';
import { errorHandler } from './api/middleware/errorHandler.js';
import path from 'path';
import fs from 'fs';
import { createServices } from './modules/services/index.js';
import { createControllers } from './api/controllers/index.js';
import { createRoutes } from './api/routes/index.js';
import { config } from './config/index.js';
import { RedisService } from './modules/services/redisService.js';

class Application {
    constructor() {
        this.app = null;
        this.server = null;
        this.services = null;
        this.controllers = null;
    }

    async initialize() {
        try {
            logger.info('开始初始化应用...');

            // 1. 初始化数据库
            await db.initializeDatabase();
            logger.info('数据库初始化完成');

            // 2. 初始化 Redis
            const redisService = new RedisService(config.redis);
            const redisConnected = await redisService.connect();
            
            if (!redisConnected) {
                logger.warn('Redis 服务初始化失败，将不使用缓存');
            }

            // 3. 创建所有服务
            this.services = await createServices();
            logger.info('服务创建成功:', {
                services: Object.keys(this.services)
            });

            // 4. 确保 Solana 服务
            await this.services.solanaService.initialize();
            
            // 5. 创建控制器
            this.controllers = createControllers(this.services);
            logger.info('控制器创建成功:', {
                controllers: Object.keys(this.controllers)
            });

            // 6. 创建路由
            const routes = createRoutes(this.controllers);
            logger.info('路由创建完成');

            // 7. 创建 Express 应用
            this.app = createApp(routes, this.services);
            logger.info('Express 应用创建完成');

            return {
                app: this.app,
                services: this.services,
                controllers: this.controllers
            };
        } catch (error) {
            logger.error('应用初始化失败:', error);
            throw error;
        }
    }

    getApp() {
        return this.app;
    }

    getServices() {
        return this.services;
    }

    getControllers() {
        return this.controllers;
    }

    setupMiddleware() {
        // CORS 配置
        this.app.use(cors({
            origin: '*',  // 允许所有来源访问
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization'],
            exposedHeaders: ['Content-Range', 'X-Content-Range'],
            credentials: true,
            maxAge: 86400
        }));

        // JSON 解析配置
        this.app.use(express.json({
            limit: '10mb',
            strict: true,
            verify: (req, res, buf) => {
                try {
                    JSON.parse(buf);
                } catch(e) {
                    res.status(400).json({
                        success: false,
                        error: 'Invalid JSON'
                    });
                    throw new Error('Invalid JSON');
                }
            }
        }));

        // URL 编码解析
        this.app.use(express.urlencoded({
            extended: true,
            limit: '10mb'
        }));

        // 请求日志中间件
        this.app.use((req, res, next) => {
            const startTime = Date.now();
            const requestId = crypto.randomUUID();

            // 添加请求ID到响应头
            res.setHeader('X-Request-ID', requestId);

            // 记录请求开始
            logger.info(`请求开始 [${requestId}]`, {
                method: req.method,
                path: req.path,
                ip: req.ip,
                userAgent: req.get('user-agent'),
                query: req.query,
                body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? req.body : undefined,
                headers: {
                    ...req.headers,
                    authorization: req.headers.authorization ? '[FILTERED]' : undefined
                }
            });

            // 响应完成后记录日志
            res.on('finish', () => {
                const duration = Date.now() - startTime;
                const level = res.statusCode >= 400 ? 'error' : 'info';

                logger[level](`请求完成 [${requestId}]`, {
                    method: req.method,
                    path: req.path,
                    status: res.statusCode,
                    duration: `${duration}ms`,
                    responseHeaders: {
                        ...res.getHeaders(),
                        'set-cookie': res.getHeader('set-cookie') ? '[FILTERED]' : undefined
                    },
                    ip: req.ip,
                    userAgent: req.get('user-agent')
                });
            });

            // 错误处理
            res.on('error', (error) => {
                logger.error(`请求错误 [${requestId}]`, {
                    method: req.method,
                    path: req.path,
                    error: error.message,
                    stack: error.stack
                });
            });

            next();
        });

        // 安全相关的响应头
        this.app.use((req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('X-XSS-Protection', '1; mode=block');
            res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
            res.setHeader('Content-Security-Policy', "default-src 'self'");
            next();
        });

        // 请求速率限制
        const limiter = rateLimit({
            windowMs: 15 * 60 * 1000, // 15分钟
            max: 100, // 限制每个IP 15分钟内最多100个请求
            message: {
                success: false,
                error: '请求过于频繁，请稍后再试'
            },
            standardHeaders: true,
            legacyHeaders: false,
            handler: (req, res) => {
                logger.warn('速率限制触发', {
                    ip: req.ip,
                    path: req.path
                });
                res.status(429).json({
                    success: false,
                    error: '请求过于频繁，请稍后再试'
                });
            }
        });

        // 对API路由应用速率限制
        this.app.use('/api/', limiter);

        // 压缩响应
        this.app.use(compression());

        // 基本安全防护
        this.app.use(helmet());
    }


    setupRoutes() {
        // API 路由
        this.app.use('/api/v1', routes);

        // 健康检查
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                uptime: process.uptime(),
                timestamp: new Date().toISOString(),
                version: process.env.npm_package_version
            });
        });

        // API 文档重定向
        this.app.get('/', (req, res) => {
            res.redirect('/api/v1/docs');
        });

        // 404 处理
        this.app.use((req, res) => {
            res.status(404).json({
                success: false,
                error: 'Not Found',
                path: req.path
            });
        });
    }

    setupErrorHandling() {
        this.app.use(errorHandler);

        // 优雅关闭
        process.on('SIGTERM', () => this.shutdown());
        process.on('SIGINT', () => this.shutdown());
    }

    async shutdown() {
        logger.info('正在关闭应用...');
        
        try {
            // 关闭数据库连接
            await db.sequelize.close();
            logger.info('数据库连接已关闭');

            // 关闭 HTTP 服务器
            if (this.server) {
                await new Promise((resolve) => {
                    this.server.close(resolve);
                });
                logger.info('HTTP 服务器已关闭');
            }

            logger.info('应用已成功关闭');
            process.exit(0);
        } catch (error) {
            logger.error('关闭应用时出错:', error);
            process.exit(1);
        }
    }

    async start() {
        try {
            const port = config.api.port || 3000;

            this.server = this.app.listen(port, '0.0.0.0', () => {
                const localAddress = `http://localhost:${port}`;
                // 获取本机 IP 地址
                const networkInterfaces = require('os').networkInterfaces();
                const ipAddresses = [];

                Object.keys(networkInterfaces).forEach((interfaceName) => {
                    networkInterfaces[interfaceName].forEach((netInterface) => {  // 改为 netInterface
                        // 跳过内部 IP 和 IPv6
                        if (netInterface.family === 'IPv4' && !netInterface.internal) {
                            ipAddresses.push(netInterface.address);
                        }
                    });
                });

                logger.info('=================================');
                logger.info(`服务器启动成功，监听端口 ${port}`);
                logger.info(`本地访问: ${localAddress}`);
                logger.info('远程访问:');
                ipAddresses.forEach(ip => {
                    logger.info(`http://${ip}:${port}`);
                });
                logger.info(`健康检查: ${localAddress}/health`);
                logger.info('=================================');
            });

            // 设置超时时间
            this.server.timeout = 120000; // 2分钟

            // 增加错误处理
            this.server.on('error', (error) => {
                if (error.code === 'EADDRINUSE') {
                    logger.error(`端口 ${port} 已被占用`);
                } else {
                    logger.error('服务器错误:', error);
                }
            });

        } catch (error) {
            logger.error('应用启动失败:', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }
}

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
    logger.error('未捕获的异常:', error);
    logger.error(error.stack);
});

process.on('unhandledRejection', (error) => {
    logger.error('未处理的 Promise 拒绝:', error);
    if (error.stack) {
        logger.error(error.stack);
    }
});

// 启动应用
async function main() {
    try {
        const application = new Application();
        await application.initialize();
        
        const app = application.getApp();
        if (!app) {
            throw new Error('Application initialization failed');
        }

        const port = process.env.PORT || 3000;
        app.listen(port, () => {
            logger.info(`服务器启动成功，监听端口 ${port}`);
        });
    } catch (error) {
        logger.error('应用启动失败:', {
            error: error.message,
            name: error.name,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        process.exit(1);
    }
}

main();

export { Application }; 