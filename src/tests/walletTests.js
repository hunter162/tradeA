import { SolanaService } from '../modules/services/solanaService.js';
import { logger } from '../modules/utils.js';
import { Keypair } from '@solana/web3.js';

async function testBasicWalletFunctions() {
    try {
        logger.info('=== 开始基础钱包功能测试 ===');

        // 1. 初始化 Solana 服务
        const solanaService = new SolanaService();
        await solanaService.initialize();
        logger.info('Solana 服务初始化成功');

        // 2. 创建新钱包
        const wallet = Keypair.generate();
        logger.info('创建新钱包:', {
            publicKey: wallet.publicKey.toString()
        });

        // 3. 获取钱包余额
        const balance = await solanaService.getBalance(wallet.publicKey);
        logger.info('钱包余额:', {
            address: wallet.publicKey.toString(),
            balance: `${balance} SOL`
        });

        // 4. 测试 SPL 代币余额查询
        try {
            // 使用一个已知的 SPL 代币地址作为示例
            const tokenMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
            const tokenBalance = await solanaService.getSPLBalance(tokenMint, wallet.publicKey);
            logger.info('代币余额:', {
                token: tokenMint,
                balance: tokenBalance
            });
        } catch (error) {
            logger.warn('获取代币余额失败:', error.message);
        }

        // 5. 测试 RPC 连接
        const connectionTest = await solanaService.testConnection();
        logger.info('RPC 连接测试:', {
            success: connectionTest,
            endpoint: solanaService.connection.rpcEndpoint
        });

        logger.info('=== 钱包功能测试完成 ===');
        return {
            success: true,
            wallet: wallet.publicKey.toString(),
            balance
        };

    } catch (error) {
        logger.error('钱包测试失败:', {
            error: error.message,
            stack: error.stack
        });
        return {
            success: false,
            error: error.message
        };
    }
}

// 运行测试
console.log('开始运行钱包测试...');
testBasicWalletFunctions()
    .then(result => {
        console.log('测试结果:', result);
        process.exit(0);
    })
    .catch(error => {
        console.error('测试执行错误:', error);
        process.exit(1);
    }); 