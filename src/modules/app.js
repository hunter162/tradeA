import { config } from './config.js';
import { logger } from './utils.js';
import { SolanaService } from './services/solanaService.js';
import { SolanaExample } from './examples/solanaExample.js';
import dotenv from 'dotenv';

export class App {
    constructor() {
        try {
            this.name = config.appName;
            this.version = config.version;
            dotenv.config();
            
            // 验证环境变量
            this.validateEnvironment();
            
            // 创建单个 SolanaService 实例
            this.solanaService = new SolanaService();
            // 传入已创建的实例
            this.solanaExample = new SolanaExample(this.solanaService);
        } catch (error) {
            logger.error('应用初始化失败', error);
            throw error;
        }
    }

    validateEnvironment() {
        const requiredEnvVars = {
            'HELIUS_RPC_URLS': process.env.HELIUS_RPC_URLS,
            'PINATA_API_KEY': process.env.PINATA_API_KEY,
            'PINATA_API_SECRET': process.env.PINATA_API_SECRET,
            'PINATA_JWT': process.env.PINATA_JWT
        };

        const missingVars = Object.entries(requiredEnvVars)
            .filter(([_, value]) => !value)
            .map(([key]) => key);

        if (missingVars.length > 0) {
            throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
        }

        // 验证 RPC URLs 格式
        try {
            const rpcUrls = JSON.parse(process.env.HELIUS_RPC_URLS);
            if (!Array.isArray(rpcUrls) || rpcUrls.length === 0) {
                throw new Error('HELIUS_RPC_URLS must be a non-empty array');
            }
        } catch (error) {
            throw new Error('Invalid HELIUS_RPC_URLS format. Must be a JSON array of URLs');
        }
    }

    init() {
        logger.info(`${this.name} v${this.version} 初始化成功`);
    }

    async start() {
        try {
            logger.info('应用启动...');
            
            // 等待 Solana 服务初始化
            await this.solanaService.initialize();  // 先初始化 service
            
            // 创建代币
            const result = await this.solanaExample.demonstrateTokenCreation();
            
            logger.info('应用执行完成', result);
        } catch (error) {
            logger.error('应用执行失败', {
                message: error.message,
                stack: error.stack,
                name: error.name
            });
            throw error;
        }
    }
}