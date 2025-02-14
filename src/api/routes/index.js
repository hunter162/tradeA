import { Router } from 'express';
import { logger } from '../../modules/utils/index.js';
import { createWalletRoutes } from './wallet.js';
import { createTransferRoutes } from './transfer.js';
import { createGroupRoutes } from './group.js';
import { createSolanaRoutes } from './solana.js';
import { createTransactionRoutes } from './transaction.js';
import { createTradeRoutes } from './trade.js';

// 创建路由的工厂函数
export function createRoutes(controllers) {
    const router = Router();
    const {
        walletController,
        transferController,
        groupController,
        solanaController,
        transactionController,
        tradeController
    } = controllers;

    if (!walletController || !transferController) {
        throw new Error('Required controllers not provided');
    }

    logger.info('开始创建路由...', {
        availableControllers: Object.keys(controllers)
    });

    // 路由注册前的日志中间件
    router.use((req, res, next) => {
        logger.info(`${req.method} ${req.originalUrl}`, {
            query: req.query,
            body: req.method === 'POST' ? req.body : undefined
        });
        next();
    });

    // 挂载各个路由
    router.use('/wallets', createWalletRoutes(walletController));
    router.use('/transfer', createTransferRoutes(transferController));
    router.use('/groups', createGroupRoutes(groupController));
    router.use('/solana', createSolanaRoutes(solanaController));
    router.use('/transactions', createTransactionRoutes(transactionController));
    router.use('/trade', createTradeRoutes(tradeController));

    // 404 处理
    router.use((req, res) => {
        logger.warn('路由未找到:', {
            method: req.method,
            path: req.originalUrl,
            query: req.query,
            body: req.method === 'POST' ? req.body : undefined
        });
        res.status(404).json({
            success: false,
            error: 'Not Found',
            path: req.originalUrl
        });
    });

    logger.info('路由创建完成');

    return router;
} 