import { Keypair } from "@solana/web3.js";
import { logger } from '../utils.js';
import { helpers } from '../utils.js';
import bs58 from 'bs58';
import path from 'path';
import { fileURLToPath } from 'url';
import * as web3 from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import pkg from 'pumpdotfun-sdk';
import { PublicKey } from "@solana/web3.js";
import { SolanaService } from '../services/solanaService.js';
const { MPL_TOKEN_METADATA_PROGRAM_ID, DEFAULT_DECIMALS } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class SolanaExample {
    constructor(solanaService) {
        if (!solanaService) {
            throw new Error('SolanaService instance is required');
        }
        this.solanaService = solanaService;
        this.keypairs = new Map();
        this.mint = Keypair.generate();
    }

    async demonstrateTokenCreation() {
        try {
            logger.info('生成新的 Mint Keypair', {
                publicKey: this.mint.publicKey.toBase58()
            });

            // 创建代币元数据
            const metadata = {
                name: 'Test Token',
                symbol: 'TEST',
                description: 'Test token description',
                image: null,
                twitter: '',
                telegram: '',
                website: ''
            };

            // 确保有钱包实例
            if (!this.solanaService.wallet) {
                throw new Error('Wallet not initialized');
            }

            // 调用完整测试流程
            const result = await this.solanaService.sdk.testFullProcess(
                this.solanaService.wallet,  // 确保传入钱包
                this.mint,                  // mint
                metadata,                   // metadata
                0.01,                       // initialAmount (0.01 SOL)
                0.1                         // secondBuyAmount (0.1 SOL)
            );

            logger.info('完整测试流程执行结果', {
                createAndBuy: {
                    signature: result.createAndBuy.signature,
                    amount: result.summary.initialBuy
                },
                secondBuy: {
                    signature: result.secondBuy.signature,
                    amount: result.summary.secondBuy
                },
                sell: {
                    signature: result.sell.signature,
                    amount: result.summary.totalSold
                },
                duration: result.summary.duration
            });

            return result;
        } catch (error) {
            logger.error('代币创建测试失败', error);
            throw error;
        }
    }

    // 获取保存的密钥对信息
    getKeypairs() {
        const pairs = Object.fromEntries(this.keypairs);
        logger.info('获取密钥对信息', {
            availableKeys: Object.keys(pairs),
            hasToken: !!pairs.token
        });
        return pairs;
    }

    // 添加卖出代币的示例方法
    async demonstrateTokenSale(usePriorityFee = false) {
        try {
            logger.info('开始代币卖出示例');

            // 加载账户
            const account = await helpers.loadWalletFromFile('test_account');
            if (!account) {
                logger.error('未找到测试账户');
                return;
            }

            // 获取最近创建的代币信息
            const tokenInfo = this.keypairs.get('token');
            if (!tokenInfo) {
                logger.error('未找到代币信息');
                return;
            }

            // 验证代币地址
            try {
                const mintPubkey = new PublicKey(tokenInfo.address);
                logger.info('验证代币地址', {
                    address: tokenInfo.address,
                    isOnChain: await this.solanaService.connection.getAccountInfo(mintPubkey) !== null
                });
            } catch (error) {
                logger.error('代币地址无效', {
                    address: tokenInfo.address,
                    error: error.message
                });
                return;
            }

            logger.info('准备卖出代币', {
                account: account.publicKey.toBase58(),
                tokenAddress: tokenInfo.address,
                tokenInfo  // 输出完整的代币信息
            });

            // 检查代币余额
            const tokenBalance = await this.solanaService.getSPLBalance(
                tokenInfo.address,
                account.publicKey
            );

            logger.info('当前代币余额', {
                tokenAddress: tokenInfo.address,
                balance: tokenBalance,
                decimals: DEFAULT_DECIMALS
            });

            if (tokenBalance <= 0) {
                logger.error('代币余额为零，无法卖出');
                return;
            }

            // 获取绑定曲线信息
            const curve = await this.solanaService.getBondingCurve(tokenInfo.address);
            logger.info('代币绑定曲线信息', curve);

            // 添加优先费用配置
            const priorityFeeConfig = usePriorityFee ? {
                tipAmountSol: 0.002,  // 从 0.01 改为 0.002 SOL
                estimatedCost: '包含 0.002 SOL 优先费用'
            } : {
                tipAmountSol: 0,
                estimatedCost: '标准费用'
            };

            logger.info('开始卖出代币...', {
                usePriorityFee,
                ...priorityFeeConfig,
                tokenAddress: tokenInfo.address,
                balance: tokenBalance
            });

            const sellResult = await this.solanaService.sellTokens(
                account, 
                tokenInfo.address,
                usePriorityFee ? priorityFeeConfig : undefined
            );

            if (sellResult.success) {
                logger.info('代币卖出成功', {
                    txId: sellResult.txId,
                    amountSold: sellResult.amountSold
                });

                // 等待 15 秒确保交易确认
                logger.info('等待卖出交易确认 (15秒)...');
                await helpers.sleep(15000);

                // 检查卖出后的余额
                const balanceAfterSell = await this.solanaService.getSPLBalance(
                    tokenInfo.address,
                    account.publicKey
                );
                const solBalanceAfterSell = await this.solanaService.getBalance(account.publicKey);

                logger.info('卖出后的余额', {
                    tokenBalance: balanceAfterSell,
                    solBalance: `${solBalanceAfterSell} SOL`
                });
            } else {
                logger.error('代币卖出失败', sellResult);
            }

        } catch (error) {
            logger.error('卖出示例执行失败', error);
        }
    }

    // 添加买入示例方法
    async demonstrateTokenBuy(tokenAddress, amountSol, usePriorityFee = false) {
        try {
            const account = await helpers.loadWalletFromFile('test_account');
            if (!account) {
                logger.error('未找到测试账户');
                return;
            }

            // 添加优先费用配置
            const priorityFeeConfig = usePriorityFee ? {
                tipAmountSol: 0.002,  // 从 0.01 改为 0.002 SOL
                estimatedTotalCost: `~${(amountSol + 0.002).toFixed(3)} SOL (包含优先费用)`
            } : {
                tipAmountSol: 0,
                estimatedTotalCost: `~${amountSol} SOL`
            };

            logger.info('准备购买代币', {
                tokenAddress,
                amount: `${amountSol} SOL`,
                usePriorityFee,
                ...priorityFeeConfig
            });

            const buyResult = await this.solanaService.buyTokens(
                account,
                tokenAddress,
                amountSol,
                usePriorityFee ? priorityFeeConfig : undefined
            );

            if (buyResult.success) {
                logger.info('代币购买成功', {
                    txId: buyResult.txId,
                    tokenAddress,
                    amount: amountSol,
                    usedPriorityFee: usePriorityFee
                });

                // 等待 15 秒确保交易确认
                logger.info('等待购买交易确认 (15秒)...');
                await helpers.sleep(15000);
            }

        } catch (error) {
            logger.error('购买示例执行失败', error);
        }
    }
} 