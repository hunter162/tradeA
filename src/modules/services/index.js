import { SolanaService } from './solanaService.js';
import { WalletService } from './walletService.js';
import { CustomPumpSDK } from './customPumpSDK.js';
import { WebSocketManager } from './webSocketManager.js';
import { RedisService } from './redisService.js';
import { JitoService } from './jitoService_new.js';  //
import { PinataService } from './pinataService.js';
import { TokenSubscriptionService } from './tokenSubscriptionService.js';
import { TransferService } from './transferService.js';
import { TokenTradeService } from './tokenTradeService.js';
import { TradeController } from '../../api/controllers/tradeController.js';
import { logger } from '../utils/index.js';
import { config } from '../../config/index.js';

// 创建服务实例的工厂函数
export async function createServices() {
    try {
        // 1. 首先创建 Redis 服务
        const redisService = new RedisService(config.redis);
        await redisService.connect();
        logger.info('Redis 服务初始化成功');

        // 2. 创建其他服务，并传入 redisService
        const solanaService = new SolanaService();
        solanaService.setRedisService(redisService); // 设置 Redis 服务

        const walletService = new WalletService(solanaService);
        const tokenTradeService = new TokenTradeService(solanaService, redisService);
        const transferService = new TransferService(solanaService, walletService);
        const tokenSubscriptionService = new TokenSubscriptionService(redisService, solanaService);

        // 3. 初始化其他服务
        await Promise.all([
            solanaService.initialize(),
            tokenSubscriptionService.initialize()
        ]);

        // 4. 设置服务依赖
        solanaService.setWalletService(walletService);
        solanaService.setTokenSubscriptionService(tokenSubscriptionService);

        logger.info('所有服务初始化完成');

        return {
            solanaService,
            walletService,
            tokenTradeService,
            transferService,
            redisService,
            tokenSubscriptionService
        };
    } catch (error) {
        logger.error('服务创建失败:', {
            error: error.message,
            stack: error.stack,
            name: error.name
        });
        throw error;
    }
}

// 导出服务类
export {
    SolanaService,
    WalletService,
    CustomPumpSDK,
    WebSocketManager,
    RedisService,
    JitoService,
    PinataService,
    TokenTradeService
}; 