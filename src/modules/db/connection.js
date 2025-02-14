import { Sequelize } from 'sequelize';
import { config } from '../../config/index.js';
import { logger } from '../utils/index.js';

// 导入模型定义
import defineTokenModel from './models/token.js';
import defineTransactionModel from './models/transaction.js';
import defineGroupModel from './models/group.js';
import defineWalletModel from './models/wallet.js';

// 创建 Sequelize 实例
const sequelize = new Sequelize({
    dialect: 'mysql',
    host: config.database.host,
    port: config.database.port,
    username: config.database.username,
    password: config.database.password,
    database: config.database.database,
    pool: {
        max: 10,
        min: 0,
        acquire: 30000,
        idle: 10000
    },
    retry: {
        max: 3,
        timeout: 5000,
        match: [
            /Deadlock/i,
            /deadlock/i,
            /connection lost/i
        ]
    },
    dialectOptions: {
        connectTimeout: 60000,
        dateStrings: true,
        typeCast: true
    },
    logging: false
});

// 初始化所有模型
const models = {
    Token: defineTokenModel(sequelize),
    Transaction: defineTransactionModel(sequelize),
    Group: defineGroupModel(sequelize),
    Wallet: defineWalletModel(sequelize)
};

// 设置模型关联
Object.values(models).forEach(model => {
    if (model.associate) {
        model.associate(models);
    }
});

let retryCount = 0;
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;

// 初始化数据库
async function initializeDatabase() {
    try {
        // 测试连接
        await sequelize.authenticate();
        logger.info('数据库连接成功');

        // 同步表结构
        await sequelize.sync({ 
            alter: true,
            force: false,
            logging: false
        });

        logger.info('数据库表同步完成');

        // 初始化默认数据
        await initializeDefaultData();

        return true;
    } catch (error) {
        logger.error('数据库初始化失败:', {
            error: error.message,
            retry: retryCount
        });

        if (retryCount < MAX_RETRIES) {
            retryCount++;
            logger.info(`尝试重新连接 (${retryCount}/${MAX_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            return initializeDatabase();
        }

        throw error;
    }
}

// 初始化默认数据
async function initializeDefaultData() {
    try {
        // 创建默认钱包组
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

        logger.info('默认组创建完成');
    } catch (error) {
        logger.error('初始化默认数据失败:', error);
        throw error;
    }
}

const db = {
    sequelize,
    Sequelize,
    models,
    initializeDatabase
};

export { initializeDatabase };
export default db; 