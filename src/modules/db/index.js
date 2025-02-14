import { Sequelize } from 'sequelize';
import { config } from '../../config/index.js';
import { logger } from '../utils/index.js';
import fs from 'fs';
import path from 'path';

// 导入模型定义
import defineTokenModel from './models/token.js';
import defineTokenBalanceModel from './models/tokenBalance.js';
import defineTransactionModel from './models/transaction.js';
import defineGroupModel from './models/group.js';
import defineWalletModel from './models/wallet.js';
import defineTradeStrategyModel from './models/tradeStrategy.js';
import defineTradeExecutionModel from './models/tradeExecution.js';
import defineTradeTaskModel from './models/tradeTask.js';

// 创建 Sequelize 实例
const sequelize = new Sequelize({
    dialect: 'mysql',  // 明确指定数据库类型
    host: config.database.host,
    port: config.database.port,
    username: config.database.username,
    password: config.database.password,
    database: config.database.database,
    pool: config.database.pool,
    logging: (msg) => logger.debug(msg),
    define: config.database.define,
    dialectOptions: {
        connectTimeout: 60000
    },
    retry: {
        max: 3,
        match: [
            /Deadlock/i,
            /SequelizeConnectionError/,
            /SequelizeConnectionRefusedError/,
            /SequelizeHostNotFoundError/,
            /SequelizeHostNotReachableError/,
            /SequelizeInvalidConnectionError/,
            /SequelizeConnectionTimedOutError/,
            /TimeoutError/
        ]
    }
});

// 初始化所有模型
const models = {
    Token: defineTokenModel(sequelize),
    TokenBalance: defineTokenBalanceModel(sequelize),
    Transaction: defineTransactionModel(sequelize),
    Group: defineGroupModel(sequelize),
    Wallet: defineWalletModel(sequelize),
    TradeStrategy: defineTradeStrategyModel(sequelize),
    TradeExecution: defineTradeExecutionModel(sequelize),
    TradeTask: defineTradeTaskModel(sequelize)
};

// 设置模型关联关系
Object.values(models).forEach(model => {
    if (model.associate) {
        model.associate(models);
    }
});

// 初始化数据库
async function initializeDatabase() {
    try {
        // 1. 创建一个没有指定数据库的连接
        const tempSequelize = new Sequelize({
            dialect: 'mysql',
            host: config.database.host,
            port: config.database.port,
            username: config.database.username,
            password: config.database.password,
            logging: false
        });

        // 2. 创建数据库（如果不存在）
        await tempSequelize.query(
            `CREATE DATABASE IF NOT EXISTS ${config.database.database} 
             CHARACTER SET utf8mb4 
             COLLATE utf8mb4_unicode_ci;`
        );

        await tempSequelize.close();
        logger.info('数据库创建成功');

        // 3. 测试主连接
        await sequelize.authenticate();
        logger.info('数据库连接成功');

        // 4. 同步表结构
        await sequelize.sync({ alter: true });
        logger.info('数据库表同步完成');

        // 5. 初始化默认数据
        await initializeDefaultData();

        return true;
    } catch (error) {
        logger.error('数据库初始化失败:', {
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
}

// 初始化默认数据
async function initializeDefaultData() {
    try {
        // 检查并创建默认组
        const defaultGroups = [
            { groupType: 'main', description: '主钱包组' },
            { groupType: 'sub', description: '子钱包组' },
            { groupType: 'trade', description: '交易钱包组' }
        ];

        for (const group of defaultGroups) {
            await models.Group.findOrCreate({
                where: { groupType: group.groupType },
                defaults: {
                    ...group,
                    status: 'active',
                    metadata: {
                        isDefault: true,
                        createdAt: new Date().toISOString()
                    }
                }
            });
        }

        logger.info('默认数据初始化完成');
    } catch (error) {
        logger.error('默认数据初始化失败:', error);
        throw error;
    }
}

// 数据库健康检查
async function healthCheck() {
    try {
        await sequelize.authenticate();
        return {
            status: 'connected',
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        logger.error('数据库健康检查失败:', {
            error: error.message,
            timestamp: new Date().toISOString()
        });
        return {
            status: 'error',
            message: error.message,
            timestamp: new Date().toISOString()
        };
    }
}

// 关闭数据库连接
async function cleanup() {
    try {
        await sequelize.close();
        logger.info('数据库连接已关闭');
    } catch (error) {
        logger.error('关闭数据库连接失败:', {
            error: error.message,
            stack: error.stack
        });
    }
}

// 事务包装器
async function withTransaction(callback) {
    const t = await sequelize.transaction();
    try {
        const result = await callback(t);
        await t.commit();
        return result;
    } catch (error) {
        await t.rollback();
        throw error;
    }
}

// 创建数据库对象
const db = {
    sequelize,
    Sequelize,
    models,
    initializeDatabase,
    cleanup,
    healthCheck,
    withTransaction,
    ...models
};

// 只导出一次
export default db;