import { WalletController } from './walletController.js';
import { GroupController } from './groupController.js';
import { SolanaController } from './solanaController.js';
import { TransactionController } from './transactionController.js';
import { TradeController } from './tradeController.js';
import { TransferController } from './transferController.js';
import { logger } from '../../modules/utils/index.js';

export function createControllers(services) {
    const { 
        solanaService, 
        walletService, 
        transferService,
        tokenTradeService,
        redisService
    } = services;

    if (!solanaService || !walletService || !tokenTradeService) {
        logger.error('缺少必要的服务:', {
            hasSolanaService: !!solanaService,
            hasWalletService: !!walletService,
            hasTokenTradeService: !!tokenTradeService
        });
        throw new Error('Required services not provided');
    }

    logger.info('开始创建控制器...', {
        availableServices: Object.keys(services)
    });

    // 创建所有控制器实例
    const controllers = {
        walletController: new WalletController(solanaService, walletService),
        groupController: new GroupController(walletService),
        solanaController: new SolanaController(solanaService),
        transactionController: new TransactionController(solanaService, walletService),
        tradeController: new TradeController(solanaService, walletService, tokenTradeService),
        transferController: new TransferController(solanaService, walletService, transferService)
    };

    // 初始化需要初始化的控制器
    Object.values(controllers).forEach(controller => {
        if (typeof controller.initialize === 'function') {
            controller.initialize();
        }
    });

    logger.info('控制器创建完成:', {
        controllers: Object.keys(controllers)
    });

    return controllers;
}

export {
    WalletController,
    GroupController,
    SolanaController,
    TransactionController,
    TradeController,
    TransferController
}; 