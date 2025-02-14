import { ENCRYPTION_CONFIG } from './encryption.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';
import fs from 'fs';
import { logger } from '../modules/utils/index.js';

// 加载 .env 文件
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 从环境变量获取 RPC 端点列表
const getRpcEndpoints = () => {
    try {
        // 尝试解析 JSON 格式的 endpoints
        const endpoints = process.env.SOLANA_RPC_ENDPOINTS 
            ? JSON.parse(process.env.SOLANA_RPC_ENDPOINTS)
            : [];
            
        if (Array.isArray(endpoints) && endpoints.length > 0) {
            return endpoints;
        }
        
        // 如果没有配置或解析失败，使用备用节点
        return ["https://api.mainnet-beta.solana.com"];
    } catch (error) {
        logger.error('解析 RPC endpoints 失败:', error);
        return ["https://api.mainnet-beta.solana.com"];
    }
};

// 数据库目录配置
const DB_DIR = path.join(process.cwd(), 'db');
const DB_FILE = 'wallet.sqlite';
const DB_PATH = path.join(DB_DIR, DB_FILE);

// 验证配置
function validateConfig(config) {
    // 验证 Solana RPC 配置
    if (!config.solana.rpcEndpoints || config.solana.rpcEndpoints.length === 0) {
        logger.error('缺少 Solana RPC 配置');
        throw new Error('No Solana RPC endpoints configured');
    }

    logger.info('已加载 RPC 节点配置:', {
        count: config.solana.rpcEndpoints.length,
        endpoints: config.solana.rpcEndpoints.map(e => e.replace(/api-key=([^&]+)/, 'api-key=***'))
    });

    // 验证其他必要配置...
}

// 添加文件上传配置
const uploadConfig = {
    supportedImageFormats: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    maxFileSize: 5 * 1024 * 1024, // 5MB
    uploadDir: 'uploads',
    tokenImageDir: 'token-images',
    ipfsGateway: 'https://gateway.pinata.cloud/ipfs'
};

// 解析环境变量
const config = {
    encryption: ENCRYPTION_CONFIG,
    solana: {
        network: process.env.SOLANA_NETWORK || 'mainnet-beta',
        rpcEndpoints: getRpcEndpoints(),
        commitment: 'confirmed',
        preflightCommitment: 'confirmed',
        skipPreflight: false,
        get rpcEndpoint() {
            // 使用第一个节点作为主节点
            const endpoint = this.rpcEndpoints[0];
            if (!endpoint) {
                throw new Error('No Solana RPC endpoint configured');
            }
            return endpoint;
        },
        get wsEndpoint() {
            // 将 HTTP RPC 转换为 WebSocket URL
            return this.rpcEndpoint.replace('https://', 'wss://');
        }
    },
    database: {
        host: '149.28.67.64',
        port: 3306,
        username: 'root',
        password: 'cd123321',
        database: 'dsw_db',
        dialect: 'mysql',
        pool: {
            max: 10,
            min: 0,
            acquire: 30000,
            idle: 10000
        },
        dialectOptions: {
            connectTimeout: 60000,
            enableReconnect: true,
            reconnect: true,
            keepAlive: true,
            keepaliveInterval: 10000,
        },
        retry: {
            match: [
                /Deadlock/i,
                /deadlock/i,
                /connection lost/i,
                /Connection lost/i,
                /PROTOCOL_CONNECTION_LOST/i
            ],
            max: 3
        },
        logging: false,
        define: {
            timestamps: true,
            underscored: true
        }
    },
    api: {
        port: parseInt(process.env.PORT) || 3000,
        cors: {
            origin: '*',
            methods: ['GET', 'POST', 'PUT', 'DELETE']
        }
    },
    redis: {
        host: process.env.REDIS_HOST || '149.28.67.64',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD || 'cd123321LL',
        db: parseInt(process.env.REDIS_DB || '0'),
        retryStrategy: (times) => {
            if (times > 3) {
                logger.warn('Redis 重试次数超过限制');
                return null;
            }
            return Math.min(times * 1000, 3000);
        },
        connectTimeout: 10000,
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        autoResubscribe: true,
        reconnectOnError: function (err) {
            const targetError = 'READONLY';
            if (err.message.includes(targetError)) {
                return true;
            }
            return false;
        },
        tls: process.env.REDIS_TLS === 'true' ? {} : undefined
    },
    pinata: {
        apiKey: process.env.PINATA_API_KEY,
        apiSecret: process.env.PINATA_API_SECRET,
        jwt: process.env.PINATA_JWT
    },
    upload: uploadConfig
};

// 验证配置
validateConfig(config);

// 验证数据库配置
const validateDbConfig = () => {
    // 验证必要的数据库配置
    const required = ['host', 'port', 'database', 'password'];
    const missing = required.filter(field => !config.database[field]);
    
    if (missing.length > 0) {
        logger.error('MySQL 配置缺失:', { missing });
        throw new Error(`Missing required MySQL configuration: ${missing.join(', ')}`);
    }

    logger.info('数据库配置验证通过:', {
        type: 'mysql',
        host: config.database.host,
        port: config.database.port,
        database: config.database.database
    });
};

// 在导出配置前验证
validateConfig(config);
validateDbConfig();

// 输出配置信息（不包含敏感信息）
logger.info('加载配置完成:', {
    network: config.solana.network,
    rpcEndpointsCount: config.solana.rpcEndpoints.length,
    wsEndpoint: config.solana.wsEndpoint.replace(/\?.*$/, '...'),
    commitment: config.solana.commitment,
    port: config.api.port,
    dbType: 'mysql'
});

export { config }; 