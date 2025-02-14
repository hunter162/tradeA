import { WalletService } from '../services/walletService.js';
import { SolanaService } from '../services/solanaService.js';

async function main() {
    try {
        // 初始化服务
        const solanaService = new SolanaService();
        await solanaService.initialize();
        
        const walletService = new WalletService(solanaService);
        await walletService.initialize();

        // 1. 首先创建组
        const mainGroup = await walletService.createGroup('main', '主要钱包组');
        const tradeGroup = await walletService.createGroup('trade', '交易钱包组');
        console.log('创建的组:', { mainGroup, tradeGroup });

        // 2. 然后创建钱包
        const wallet = await walletService.createWallet('main', 1);
        console.log('创建的钱包:', {
            publicKey: wallet.publicKey,
            groupType: wallet.groupType,
            accountNumber: wallet.accountNumber
        });

        // 3. 批量创建钱包
        const batchResult = await walletService.batchCreateWallets('trade', 1, 5);
        console.log('批量创建结果:', batchResult);

        // 4. 查询组信息
        const groupStats = await walletService.getGroupStats('trade');
        console.log('组统计信息:', groupStats);

        // 获取钱包（包含解密的私钥）
        const retrievedWallet = await walletService.getWallet('main', 1);
        console.log('获取的钱包:', {
            publicKey: retrievedWallet.publicKey,
            hasPrivateKey: !!retrievedWallet.privateKey
        });

    } catch (error) {
        console.error('测试失败:', error);
    }
}

main().catch(console.error); 