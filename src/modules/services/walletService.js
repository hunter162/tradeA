import {Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction} from '@solana/web3.js';
import {EncryptionManager, logger} from '../utils/index.js';
import db from '../db/index.js';
import bs58 from 'bs58';
import {CustomError} from '../utils/errors.js';
import {ErrorCodes} from '../../constants/errorCodes.js';
import {config} from '../../config/index.js';
import {
    getAccount,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    createTransferInstruction,
    getMint
} from '@solana/spl-token';
// 交易限制配置
const TRANSACTION_LIMITS = {
    MAX_INSTRUCTIONS: 12,            // Solana推荐每个交易的最大指令数
    TRANSACTION_SIZE: 1232,          // 最大交易大小(bytes)
    SOL_TRANSFER_SIZE: 96,           // SOL转账指令大小
    TOKEN_TRANSFER_SIZE: 450,        // Token转账指令大小（包含ATA创建）
    BASE_TRANSACTION_SIZE: 100       // 基础交易大小
};

// 不同规模配置
const SCALE_CONFIG = {
    SMALL: {
        maxSize: 20,
        instructionsPerTx: 6,     // 每笔交易6条指令
        maxConcurrent: 2          // 并发2个交易
    },
    MEDIUM: {
        maxSize: 100,
        instructionsPerTx: 8,     // 每笔交易8条指令
        maxConcurrent: 3          // 并发3个交易
    },
    LARGE: {
        maxSize: 500,
        instructionsPerTx: 10,    // 每笔交易10条指令
        maxConcurrent: 4          // 并发4个交易
    },
    XLARGE: {
        maxSize: 1000,
        instructionsPerTx: 12,    // 每笔交易12条指令
        maxConcurrent: 5          // 并发5个交易
    }
};
const BATCH_CLOSE_CONFIG = {
    SMALL: {
        maxSize: 20,
        batchSize: 4,         // 每批4个账户
        concurrentBatches: 1, // 串行处理
        retryAttempts: 3,
        delayBetweenBatches: 1000  // 1秒
    },
    MEDIUM: {
        maxSize: 50,
        batchSize: 10,        // 每批10个账户
        concurrentBatches: 2, // 并发2个批次
        retryAttempts: 3,
        delayBetweenBatches: 1500
    },
    LARGE: {
        maxSize: 100,
        batchSize: 20,        // 每批20个账户
        concurrentBatches: 2,
        retryAttempts: 3,
        delayBetweenBatches: 2000
    },
    XLARGE: {
        maxSize: 500,
        batchSize: 25,        // 每批25个账户
        concurrentBatches: 4,
        retryAttempts: 3,
        delayBetweenBatches: 2000
    },
    XXLARGE: {
        maxSize: 1000,
        batchSize: 50,        // 每批50个账户
        concurrentBatches: 4,
        retryAttempts: 3,
        delayBetweenBatches: 2500
    }
};

export class WalletService {
    constructor(solanaService) {
        if (!solanaService) {
            throw new Error('SolanaService is required');
        }
        this.solanaService = solanaService;
        this.encryptionManager = new EncryptionManager(config.encryption.masterKey);
        this.validGroupTypes = ['main', 'sub', 'trade'];
        this.wallets = new Map();
        
        // 使用 solanaService 中的 redis 实例
        this.redis = solanaService.redis;
        this.balanceSubscriptions = new Map();

        logger.info('WalletService 初始化完成');
    }

    // 使用 getter 获取 connection
    get connection() {
        return this.solanaService.connection;
    }

    async initialize() {
        try {
            // 检查数据库连接
            await db.sequelize.authenticate();
            logger.info('钱包服务初始化成功');
        } catch (error) {
            logger.error('钱包服务初始化失败:', error);
            throw error;
        }
    }

    _getScaleConfig(transferCount) {
        if (transferCount <= 4) return SCALE_CONFIG.SMALL;
        if (transferCount <= 50) return SCALE_CONFIG.MEDIUM;
        if (transferCount <= 100) return SCALE_CONFIG.LARGE;
        if (transferCount <= 500) return SCALE_CONFIG.XLARGE;
        return SCALE_CONFIG.XXLARGE;
    }

    /**
     * 计算每个交易可以包含的最大指令数
     */
    _calculateMaxInstructions(isToken) {
        const instructionSize = isToken ?
            TRANSACTION_LIMITS.TOKEN_TRANSFER_SIZE :
            TRANSACTION_LIMITS.SOL_TRANSFER_SIZE;

        const maxBySize = Math.floor(
            (TRANSACTION_LIMITS.TRANSACTION_SIZE - TRANSACTION_LIMITS.BASE_TRANSACTION_SIZE) /
            instructionSize
        );

        return Math.min(maxBySize, TRANSACTION_LIMITS.MAX_INSTRUCTIONS);
    }

    /**
     * 批量转账主方法
     */
    async batchTransfer({
                            fromType,
                            fromRange,
                            toType,
                            toRange,
                            amount,
                            mintAddress = null, // token转账时提供
                            transferType = 'oneToMany'
                        }) {
        try {
            // 解析账户范围
            const fromAccounts = this._parseAccountRange(fromRange);
            const toAccounts = this._parseAccountRange(toRange);

            // 获取转账参数
            const transferParams = await this._prepareTransferParams({
                fromAccounts,
                toAccounts,
                amount,
                mintAddress,
                transferType
            });

            // 创建交易批次
            const batches = this._createTransferBatches(
                transferParams,
                this._calculateMaxInstructions(!!mintAddress)
            );

            // 执行批量转账
            return await this._executeBatches(batches, mintAddress);

        } catch (error) {
            logger.error('批量转账失败:', {
                error: error.message,
                params: { fromType, fromRange, toType, toRange, amount, mintAddress }
            });
            throw error;
        }
    }

    /**
     * 准备转账参数
     */
    async _prepareTransferParams({
                                     fromAccounts,
                                     toAccounts,
                                     amount,
                                     mintAddress,
                                     transferType
                                 }) {
        // 获取代币信息（如果是token转账）
        let tokenInfo = null;
        if (mintAddress) {
            const mintPublicKey = new PublicKey(mintAddress);
            const mintAccount = await getMint(
                this.connection,
                mintPublicKey,
                'confirmed',
                TOKEN_PROGRAM_ID
            );
            tokenInfo = {
                decimals: mintAccount.decimals,
                mintAddress: mintAddress
            };
        }

        // 构建转账列表
        const transfers = [];
        switch (transferType) {
            case 'oneToMany':
                const sourceAccount = fromAccounts[0];
                toAccounts.forEach(targetAccount => {
                    transfers.push({
                        from: sourceAccount,
                        to: targetAccount,
                        amount
                    });
                });
                break;

            case 'manyToOne':
                const targetAccount = toAccounts[0];
                fromAccounts.forEach(sourceAccount => {
                    transfers.push({
                        from: sourceAccount,
                        to: targetAccount,
                        amount
                    });
                });
                break;

            case 'manyToMany':
                if (fromAccounts.length !== toAccounts.length) {
                    throw new Error('多对多转账：源账户和目标账户数量必须相同');
                }
                fromAccounts.forEach((sourceAccount, index) => {
                    transfers.push({
                        from: sourceAccount,
                        to: toAccounts[index],
                        amount
                    });
                });
                break;
        }

        return {
            transfers,
            tokenInfo,
            transferType
        };
    }

    /**
     * 创建转账批次
     */
    _createTransferBatches(transferParams, maxInstructionsPerTx) {
        const { transfers, tokenInfo } = transferParams;
        const batches = [];

        // 获取规模配置
        const scaleConfig = this._getScaleConfig(transfers.length);

        // 分批处理
        for (let i = 0; i < transfers.length; i += maxInstructionsPerTx) {
            const batchTransfers = transfers.slice(i, i + maxInstructionsPerTx);

            batches.push({
                transfers: batchTransfers,
                tokenInfo,
                batchIndex: Math.floor(i / maxInstructionsPerTx),
                config: scaleConfig
            });
        }

        return batches;
    }

    /**
     * 执行批量转账
     */
    async _executeBatches(batches, mintAddress) {
        const results = {
            successful: [],
            failed: [],
            skipped: []
        };

        // 获取并发配置
        const config = this._getScaleConfig(
            batches.reduce((sum, batch) => sum + batch.transfers.length, 0)
        );

        // 分组执行批次
        for (let i = 0; i < batches.length; i += config.maxConcurrent) {
            const currentBatches = batches.slice(i, i + config.maxConcurrent);

            // 并行执行当前批次
            const batchResults = await Promise.all(
                currentBatches.map(batch =>
                    this._processBatch(batch, mintAddress)
                )
            );

            // 合并结果
            batchResults.forEach(result => {
                results.successful.push(...result.successful);
                results.failed.push(...result.failed);
                results.skipped.push(...result.skipped);
            });

            // 批次间延迟
            if (i + config.maxConcurrent < batches.length) {
                await this._sleep(1000);
            }
        }

        return this._formatResults(results, mintAddress);
    }

    /**
     * 处理单个批次
     */
    async _processBatch(batch, mintAddress) {
        try {
            const { transfers, tokenInfo } = batch;

            // 创建交易
            const transaction = new Transaction();

            // 添加转账指令
            for (const transfer of transfers) {
                if (mintAddress) {
                    await this._addTokenTransferInstruction(
                        transaction,
                        transfer,
                        mintAddress,
                        tokenInfo.decimals
                    );
                } else {
                    await this._addSolTransferInstruction(
                        transaction,
                        transfer
                    );
                }
            }

            // 发送交易
            const result = await this._sendAndConfirmTransaction(transaction);

            return result;

        } catch (error) {
            logger.error('处理批次失败:', {
                error: error.message,
                batchIndex: batch.batchIndex
            });
            throw error;
        }
    }

    /**
     * 添加 SOL 转账指令
     */
    async _addSolTransferInstruction(transaction, transfer) {
        const fromKeypair = await this.walletService.getWalletKeypair(
            transfer.from.type,
            transfer.from.accountNumber
        );

        const toWallet = await this.walletService.getWallet(
            transfer.to.type,
            transfer.to.accountNumber
        );

        transaction.add(
            SystemProgram.transfer({
                fromPubkey: fromKeypair.publicKey,
                toPubkey: new PublicKey(toWallet.publicKey),
                lamports: Math.floor(transfer.amount * LAMPORTS_PER_SOL)
            })
        );
    }

    /**
     * 添加 Token 转账指令
     */
    async _addTokenTransferInstruction(transaction, transfer, mintAddress, decimals) {
        const fromKeypair = await this.walletService.getWalletKeypair(
            transfer.from.type,
            transfer.from.accountNumber
        );

        const toWallet = await this.walletService.getWallet(
            transfer.to.type,
            transfer.to.accountNumber
        );

        const mintPublicKey = new PublicKey(mintAddress);

        // 获取源和目标代币账户
        const fromATA = await getAssociatedTokenAddress(
            mintPublicKey,
            fromKeypair.publicKey
        );

        const toATA = await getAssociatedTokenAddress(
            mintPublicKey,
            new PublicKey(toWallet.publicKey)
        );

        // 检查并创建目标代币账户
        const toAccountInfo = await this.connection.getAccountInfo(toATA);
        if (!toAccountInfo) {
            transaction.add(
                createAssociatedTokenAccountInstruction(
                    fromKeypair.publicKey,
                    toATA,
                    new PublicKey(toWallet.publicKey),
                    mintPublicKey
                )
            );
        }

        // 添加转账指令
        const transferAmount = Math.floor(transfer.amount * Math.pow(10, decimals));
        transaction.add(
            createTransferInstruction(
                fromATA,
                toATA,
                fromKeypair.publicKey,
                transferAmount
            )
        );
    }

    // 辅助方法
    _parseAccountRange(range) {
        const [start, end] = range.split('-').map(Number);
        if (isNaN(start) || isNaN(end) || start > end) {
            throw new Error('Invalid account range format. Use format like "1-5"');
        }
        return Array.from(
            { length: end - start + 1 },
            (_, i) => ({
                accountNumber: start + i,
                type: 'account'
            })
        );
    }

    async _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 初始化默认组
    async initializeDefaultGroups() {
        try {
            const defaultGroups = ['main', 'sub'];
            
            for (const groupType of defaultGroups) {
                await db.models.Group.findOrCreate({
                    where: { groupType },
                    defaults: {
                        description: `${groupType} group`,
                        status: 'active',
                        metadata: {
                            isDefault: true,
                            createdAt: new Date().toISOString()
                        }
                    }
                });
            }

            logger.info('默认组初始化完成', {
                groups: defaultGroups
            });
        } catch (error) {
            logger.error('初始化默认组失败:', error);
            throw error;
        }
    }

    // 验证组类型和账户编号
    validateInput(groupType, accountNumber) {
        if (!this.validGroupTypes.includes(groupType)) {
            throw new Error(`Invalid group type. Valid types are: ${this.validGroupTypes.join(', ')}`);
        }
        if (typeof accountNumber !== 'number' || accountNumber < 1) {
            throw new Error('Account number must be a positive integer');
        }
    }

    // 1. 基础钱包功能
    async createWallet(groupType, accountNumber) {
        try {
            // 检查钱包是否已存在
            const existing = await db.models.Wallet.findOne({
                where: { groupType, accountNumber }
            });

            if (existing) {
                throw new Error(`Wallet ${groupType}-${accountNumber} already exists`);
            }

            // 创建新钱包
            const wallet = Keypair.generate();
            const privateKeyBase64 = Buffer.from(wallet.secretKey).toString('base64');

            // 加密私钥
            const encryptedData = await this.encryptionManager.encrypt(privateKeyBase64);

            // 保存到数据库
            const savedWallet = await db.models.Wallet.create({
                groupType,
                accountNumber,
                publicKey: wallet.publicKey.toString(),
                encryptedPrivateKey: encryptedData.encryptedData,
                iv: encryptedData.iv,
                salt: encryptedData.salt,
                authTag: encryptedData.authTag,
                status: 'active'
            });

            // 订阅余额变动
            await this.solanaService.subscribeToBalanceChanges([{
                publicKey: wallet.publicKey.toString(),
                lastKnownBalance: 0
            }]);

            // 缓存到 Redis
            if (this.redis) {
                const cacheKey = `wallet:${groupType}:${accountNumber}`;
                await this.redis.set(cacheKey, {
                    publicKey: wallet.publicKey.toString(),
                    balance: 0,
                    lastUpdated: new Date().toISOString()
                }, { EX: 3600 }); // 1小时过期
            }

            // 自动订阅余额变动
            await this.subscribeToBalance(groupType, accountNumber);

            logger.info('钱包创建成功:', {
                groupType,
                accountNumber,
                publicKey: wallet.publicKey.toString()
            });

            return savedWallet;
        } catch (error) {
            logger.error('创建钱包失败:', {
                error: error.message,
                groupType,
                accountNumber
            });
            throw error;
        }
    }

    async getWallet(groupType, accountNumber) {
        try {
            logger.info('开始获取钱包:', {
                groupType,
                accountNumber,
                validGroups: this.validGroupTypes
            });

            // 从数据库获取钱包信息
            const wallet = await db.models.Wallet.findOne({
                where: {
                    groupType,
                    accountNumber
                }
            });

            if (!wallet) {
                throw new Error(`Wallet not found: ${groupType}-${accountNumber}`);
            }

            // 检查钱包状态
            if (wallet.status === 'closed') {
                throw new Error(`Wallet ${groupType}-${accountNumber} is closed`);
            }

            // 解密私钥并创建 Keypair
            const privateKey = await this.encryptionManager.decrypt(
                wallet.encryptedPrivateKey,
                wallet.iv,
                wallet.salt,
                wallet.authTag
            );

            const keypair = Keypair.fromSecretKey(
                Buffer.from(privateKey, 'base64')
            );

            logger.info('钱包获取成功:', {
                groupType,
                accountNumber,
                publicKey: keypair.publicKey.toString()
            });

            return {
                groupType,
                accountNumber,
                publicKey: keypair.publicKey.toString(),
                keypair
            };
        } catch (error) {
            logger.error('获取钱包失败:', {
                error: error.message,
                groupType,
                accountNumber
            });
            throw error;
        }
    }

    // 获取单个钱包余额
    async getBalance(groupType, accountNumber) {
        try {
            // 获取钱包
            const wallet = await this.getWallet(groupType, accountNumber);
            if (!wallet) {
                throw new Error(`Wallet not found: ${groupType}-${accountNumber}`);
            }

            // 从 solanaService 获取余额 (返回 SOL)
            const balance = await this.solanaService.getBalance(wallet.publicKey);

            logger.info('获取钱包余额成功:', {
                groupType,
                accountNumber,
                publicKey: wallet.publicKey,
                balance
            });

            return balance;
        } catch (error) {
            logger.error('获取钱包余额失败:', {
                error: error.message,
                groupType,
                accountNumber
            });
            throw error;
        }
    }

    // 批量获取余额
    async getBatchBalances(groupType, accountRange) {
        try {
            logger.info('批量查询余额', {
                groupType,
                accountRange
            });

            // 解析账号范围
            const [startNum, endNum] = accountRange.split('-').map(Number);
            if (isNaN(startNum) || isNaN(endNum) || startNum > endNum) {
                throw new Error('Invalid account range format. Use format like "1-5"');
            }

            const results = [];
            for (let i = startNum; i <= endNum; i++) {
                try {
                    const balanceInfo = await this.getBalance(groupType, i);
                    results.push({
                        ...balanceInfo,
                        status: 'success'
                    });
                } catch (error) {
                    results.push({
                        groupType,
                        accountNumber: i,
                        status: 'failed',
                        error: error.message
                    });
                }
            }

            // 计算统计信息
            const successful = results.filter(r => r.status === 'success');
            const totalBalance = successful.reduce((sum, r) => sum + r.balance, 0);

            const summary = {
                groupType,
                accountRange: `${startNum}-${endNum}`,
                totalAccounts: results.length,
                successfulQueries: successful.length,
                failedQueries: results.length - successful.length,
                totalBalance: totalBalance,
                averageBalance: successful.length ? totalBalance / successful.length : 0
            };

            logger.info('批量余额查询完成', summary);

            return {
                summary,
                results
            };
        } catch (error) {
            logger.error('批量获取余额失败', {
                error: error.message,
                groupType,
                accountRange
            });
            throw error;
        }
    }

    // 获取组内所有钱包余额
    async getGroupBalances(groupType) {
        try {
            logger.info('查询组内所有钱包余额', { groupType });

            // 获取组内所有钱包
            const wallets = await this.getGroupWallets(groupType);
            if (!wallets.length) {
                return {
                    groupType,
                    totalWallets: 0,
                    totalBalance: 0,
                    wallets: []
                };
            }

            // 查询每个钱包的余额
            const results = await Promise.all(
                wallets.map(async (wallet) => {
                    try {
                        const balance = await this.connection.getBalance(
                            new PublicKey(wallet.publicKey)
                        );
                        return {
                            ...wallet,
                            balance: balance / LAMPORTS_PER_SOL,
                            status: 'success'
                        };
                    } catch (error) {
                        return {
                            ...wallet,
                            balance: 0,
                            status: 'failed',
                            error: error.message
                        };
                    }
                })
            );

            // 计算统计信息
            const successful = results.filter(r => r.status === 'success');
            const totalBalance = successful.reduce((sum, r) => sum + r.balance, 0);

            return {
                groupType,
                totalWallets: wallets.length,
                totalBalance,
                averageBalance: totalBalance / successful.length,
                wallets: results
            };
        } catch (error) {
            logger.error('获取组余额失败', {
                error: error.message,
                groupType
            });
            throw error;
        }
    }

    // 获取组内最大账号
    async getMaxAccountNumber(groupType) {
        try {
            const result = await db.models.Wallet.findOne({
                where: { groupType },
                order: [['accountNumber', 'DESC']],
                attributes: ['accountNumber']
            });
            return result ? result.accountNumber : 0;
        } catch (error) {
            logger.error('获取最大账号失败:', {
                error: error.message,
                groupType
            });
            return 0;
        }
    }

    // 批量创建钱包
    async batchCreateWallets(groupType, count) {
        try {
            if (typeof count !== 'number' || count < 1 || count > 100) {
                throw new Error('Count must be between 1 and 100');
            }

            // 获取当前最大账号
            const maxAccount = await db.models.Wallet.max('accountNumber', {
                where: { groupType }
            }) || 0;

            const results = {
                success: true,
                total: count,
                created: 0,
                failed: 0,
                wallets: [],
                errors: []
            };

            // 批量创建钱包
            for (let i = 0; i < count; i++) {
                const accountNumber = maxAccount + i + 1;
                try {
                    // 检查钱包是否已存在
                    const existing = await db.models.Wallet.findOne({
                        where: { groupType, accountNumber }
                    });

                    if (existing) {
                        logger.warn('钱包已存在，跳过:', {
                            groupType,
                            accountNumber,
                            publicKey: existing.publicKey
                        });
                        continue;
                    }

                    // 创建新钱包
                    const keypair = Keypair.generate();
                    const privateKeyBase64 = Buffer.from(keypair.secretKey).toString('base64');

                    // 加密私钥
                    const encryptedData = await this.encryptionManager.encrypt(privateKeyBase64);

                    try {
                        // 保存到数据库
                        const wallet = await db.models.Wallet.create({
                            groupType,
                            accountNumber,
                            publicKey: keypair.publicKey.toString(),
                            encryptedPrivateKey: encryptedData.encryptedData,
                            iv: encryptedData.iv,
                            salt: encryptedData.salt,
                            authTag: encryptedData.authTag,
                            status: 'active',
                            metadata: {
                                createdAt: new Date().toISOString()
                            }
                        }, {
                            // 添加详细的验证错误信息
                            validate: true,
                            logging: (sql, queryObject) => {
                                if (queryObject instanceof Error) {
                                    logger.error('SQL Error:', {
                                        error: queryObject.message,
                                        sql
                                    });
                                }
                            }
                        });

                        results.created++;
                        results.wallets.push({
                            groupType: wallet.groupType,
                            accountNumber: wallet.accountNumber,
                            publicKey: wallet.publicKey
                        });

                        logger.info('创建钱包成功:', {
                            groupType,
                            accountNumber,
                            publicKey: wallet.publicKey
                        });

                    } catch (dbError) {
                        // 详细记录数据库错误
                        logger.error('数据库操作失败:', {
                            error: dbError.message,
                            name: dbError.name,
                            errors: dbError.errors ? JSON.stringify(dbError.errors) : undefined,
                            sql: dbError.sql,
                            parameters: dbError.parameters,
                            groupType,
                            accountNumber
                        });

                        results.failed++;
                        results.errors.push({
                            accountNumber,
                            error: dbError.message,
                            details: dbError.errors ? JSON.stringify(dbError.errors) : undefined
                        });
                    }

                } catch (error) {
                    results.failed++;
                    results.errors.push({
                        accountNumber,
                        error: error.message
                    });

                    logger.error('创建钱包失败:', {
                        groupType,
                        accountNumber,
                        error: error.message,
                        stack: error.stack
                    });
                }
            }

            // 记录最终结果
            logger.info('批量创建钱包完成:', {
                groupType,
                total: results.total,
                created: results.created,
                failed: results.failed,
                errors: results.errors
            });

            return results;
        } catch (error) {
            logger.error('批量创建钱包失败:', {
                error: error.message,
                stack: error.stack,
                groupType,
                count
            });
            throw error;
        }
    }

    // 3. 转账功能
    async transfer(fromGroup, fromAccount, toGroup, toAccount, amount) {
        try {
            logger.info('开始转账:', {
                fromGroup, fromAccount,
                toGroup, toAccount,
                amount
            });

            // 获取源钱包和目标钱包
            const [fromWallet, toWallet] = await Promise.all([
                this.getWalletPrivateKey(fromGroup, fromAccount),
                this.getWallet(toGroup, toAccount)
            ]);

            if (!fromWallet || !toWallet) {
                throw new Error('Source or destination wallet not found');
            }

            // 创建源钱包的 Keypair
            const fromKeypair = Keypair.fromSecretKey(
                Buffer.from(fromWallet.privateKey, 'base64')
            );

            // 创建目标钱包的 PublicKey
            const toPublicKey = new PublicKey(toWallet.publicKey);

            // 创建转账交易
            const transaction = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: fromKeypair.publicKey,
                    toPubkey: toPublicKey,
                    lamports: Math.floor(amount * LAMPORTS_PER_SOL)
                })
            );

            // 获取最新的 blockhash
            const { blockhash } = await this.connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = fromKeypair.publicKey;

            // 签名交易
            transaction.sign(fromKeypair);

            // 使用 withRetry 包装发送交易
            const result = await this.solanaService.withRetry(async () => {
                const signature = await this.connection.sendRawTransaction(
                    transaction.serialize(),
                    {
                        skipPreflight: false,
                        preflightCommitment: 'confirmed'
                    }
                );

                // 使用 confirmed 而不是 finalized
                const confirmation = await this.connection.confirmTransaction(signature);
                return { signature, confirmation };
            });

            logger.info('转账成功:', {
                signature: result.signature,
                fromPublicKey: fromKeypair.publicKey.toString(),
                toPublicKey: toPublicKey.toString(),
                amount
            });

            return result;
        } catch (error) {
            logger.error('转账失败:', {
                error: error.message,
                fromGroup,
                fromAccount,
                toGroup,
                toAccount,
                amount
            });
            throw error;
        }
    }

    // 4. 归集功能
    async collectFunds(fromGroup, accountRange, toGroup, toAccount) {
        try {
            const [startNum, endNum] = accountRange.split('-').map(Number);
            const results = [];

            for (let i = startNum; i <= endNum; i++) {
                try {
                    const balance = await this.getBalance(fromGroup, i);
                    if (balance > 0.001) { // 保留 0.001 SOL 作为手续费
                        const transferAmount = balance - 0.001;
                        const result = await this.transfer(
                            fromGroup, i,
                            toGroup, toAccount,
                            transferAmount
                        );
                        results.push({
                            accountNumber: i,
                            amount: transferAmount,
                            status: 'success',
                            signature: result.signature
                        });
                    }
                } catch (error) {
                    results.push({
                        accountNumber: i,
                        status: 'failed',
                        error: error.message
                    });
                }
            }

            return {
                fromGroup,
                toGroup,
                toAccount,
                results
            };
        } catch (error) {
            logger.error('归集资金失败', error);
            throw error;
        }
    }

    // 5. 获取组内所有钱包
    async getGroupWallets(groupType) {
        try {
            const wallets = await db.models.Wallet.findAll({
                where: { groupType },
                order: [['accountNumber', 'ASC']]
            });

            return wallets.map(w => ({
                groupType: w.groupType,
                accountNumber: w.accountNumber,
                publicKey: w.publicKey,
                status: w.status
            }));
        } catch (error) {
            logger.error('获取组钱包失败', error);
            throw error;
        }
    }

    // 组管理功能
    async createGroup(groupType, description = '') {
        try {
            const [group, created] = await db.models.Group.findOrCreate({
                where: { groupType },
                defaults: {
                    description,
                    status: 'active',
                    metadata: {
                        createdAt: new Date().toISOString()
                    }
                }
            });

            if (created) {
                // 添加到有效组类型列表
                if (!this.validGroupTypes.includes(groupType)) {
                    this.validGroupTypes.push(groupType);
                }
                logger.info('创建组成功:', {
                    groupType,
                    description
                });
            } else {
                logger.info('组已存在:', {
                    groupType,
                    description
                });
            }

            return group;
        } catch (error) {
            logger.error('创建组失败:', {
                error: error.message,
                groupType,
                description
            });
            throw error;
        }
    }

    async getGroup(groupType) {
        try {
            const group = await db.models.Group.findOne({
                where: { groupType }
            });

            if (!group) {
                throw new Error(`Group ${groupType} not found`);
            }

            return {
                id: group.id,
                groupType: group.groupType,
                description: group.description,
                status: group.status,
                createdAt: group.createdAt,
                lastUsed: group.lastUsed
            };
        } catch (error) {
            logger.error('获取组信息失败', {
                error: error.message,
                groupType
            });
            throw error;
        }
    }

    async getAllGroups() {
        try {
            const groups = await db.models.Group.findAll({
                order: [['createdAt', 'DESC']]
            });

            return groups.map(group => ({
                id: group.id,
                groupType: group.groupType,
                description: group.description,
                status: group.status,
                createdAt: group.createdAt,
                lastUsed: group.lastUsed
            }));
        } catch (error) {
            logger.error('获取所有组失败', error);
            throw error;
        }
    }

    async updateGroup(groupType, updates) {
        try {
            const group = await db.models.Group.findOne({
                where: { groupType }
            });

            if (!group) {
                throw new Error(`Group ${groupType} not found`);
            }

            // 更新组信息
            await group.update({
                description: updates.description,
                status: updates.status,
                lastUsed: new Date()
            });

            logger.info('组更新成功', {
                groupType,
                updates
            });

            return {
                success: true,
                group: {
                    id: group.id,
                    groupType: group.groupType,
                    description: group.description,
                    status: group.status,
                    updatedAt: group.updatedAt
                }
            };
        } catch (error) {
            logger.error('更新组失败', {
                error: error.message,
                groupType
            });
            throw error;
        }
    }

    async deleteGroup(groupType) {
        try {
            // 检查组是否存在
            const group = await db.models.Group.findOne({
                where: { groupType }
            });

            if (!group) {
                throw new Error(`Group ${groupType} not found`);
            }

            // 检查组内是否有钱包
            const walletsCount = await db.models.Wallet.count({
                where: { groupType }
            });

            if (walletsCount > 0) {
                throw new Error(`Cannot delete group ${groupType}: group contains ${walletsCount} wallets`);
            }

            // 删除组
            await group.destroy();

            // 从有效组类型列表中移除
            this.validGroupTypes = this.validGroupTypes.filter(g => g !== groupType);

            logger.info('组删除成功', { groupType });

            return {
                success: true,
                message: `Group ${groupType} deleted successfully`
            };
        } catch (error) {
            logger.error('删除组失败', {
                error: error.message,
                groupType
            });
            throw error;
        }
    }

    // 获取组统计信息
    async getGroupStats(groupType) {
        try {
            const group = await this.getGroup(groupType);
            const wallets = await this.getGroupWallets(groupType);
            const balances = await this.getGroupBalances(groupType);

            return {
                group,
                stats: {
                    totalWallets: wallets.length,
                    activeWallets: wallets.filter(w => w.status === 'active').length,
                    totalBalance: balances.totalBalance,
                    averageBalance: balances.averageBalance
                },
                wallets: wallets.map(w => ({
                    ...w,
                    balance: balances.wallets.find(b => b.publicKey === w.publicKey)?.balance || 0
                }))
            };
        } catch (error) {
            logger.error('获取组统计信息失败', {
                error: error.message,
                groupType
            });
            throw error;
        }
    }

    async getWalletPrivateKey(groupType, accountNumber) {
        try {
            // 验证输入
            this.validateInput(groupType, accountNumber);

            // 获取钱包记录
            const wallet = await db.models.Wallet.findOne({
                where: { 
                    groupType, 
                    accountNumber,
                    status: 'active'  // 只返回活跃的钱包
                }
            });

            if (!wallet) {
                throw new Error(`Wallet not found: ${groupType}-${accountNumber}`);
            }

            // 解密私钥
            const privateKey = await this.encryptionManager.decrypt(
                wallet.encryptedPrivateKey,
                wallet.iv,
                wallet.salt,
                wallet.authTag
            );

            logger.info('钱包私钥获取成功', {
                groupType,
                accountNumber,
                publicKey: wallet.publicKey
            });

            return {
                publicKey: wallet.publicKey,
                privateKey: privateKey  // base64 格式
            };
        } catch (error) {
            logger.error('获取钱包私钥失败:', {
                error: error.message,
                groupType,
                accountNumber
            });
            throw error;
        }
    }

    // 导入钱包
    async importWallet(groupType, accountNumber, privateKey) {
        // 开启数据库事务
        let transaction = null;
        let wallet = null;
        let subscriptionId = null;

        try {
            transaction = await db.sequelize.transaction();
            logger.info('开始导入钱包:', {
                groupType,
                accountNumber
            });

            // 第一阶段: 关键操作 - 钱包导入和数据库操作
            // 解码私钥
            const decodedPrivateKey = bs58.decode(privateKey);
            const keypair = Keypair.fromSecretKey(decodedPrivateKey);

            // 检查钱包余额
            const balance = await this.solanaService.getBalance(keypair.publicKey.toString());

            // 加密私钥
            const privateKeyBase64 = Buffer.from(keypair.secretKey).toString('base64');
            const encryptedData = await this.encryptionManager.encrypt(privateKeyBase64);

            // 查找现有钱包
            const existingWallet = await db.models.Wallet.findOne({
                where: {
                    groupType,
                    accountNumber
                },
                transaction
            });

            if (existingWallet) {
                // 更新现有钱包
                await existingWallet.update({
                    publicKey: keypair.publicKey.toString(),
                    encryptedPrivateKey: encryptedData.encryptedData,
                    iv: encryptedData.iv,
                    salt: encryptedData.salt,
                    authTag: encryptedData.authTag,
                    status: 'active',
                    metadata: {
                        imported: true,
                        importedAt: new Date().toISOString(),
                        previousPublicKey: existingWallet.publicKey
                    }
                }, { transaction });

                wallet = existingWallet;
            } else {
                // 创建新钱包
                wallet = await db.models.Wallet.create({
                    groupType,
                    accountNumber,
                    publicKey: keypair.publicKey.toString(),
                    encryptedPrivateKey: encryptedData.encryptedData,
                    iv: encryptedData.iv,
                    salt: encryptedData.salt,
                    authTag: encryptedData.authTag,
                    status: 'active',
                    metadata: {
                        imported: true,
                        importedAt: new Date().toISOString()
                    }
                }, { transaction });
            }

            // 提交事务
            await transaction.commit();
            transaction = null;
            // 第二阶段: 非关键操作 - WebSocket 订阅和缓存更新
            try {
                // 更新 Redis 缓存
                if (this.redis) {
                    const cacheKey = `wallet:${groupType}:${accountNumber}`;
                    const cacheData = JSON.stringify({
                        publicKey: keypair.publicKey.toString(),
                        balance: balance / LAMPORTS_PER_SOL,
                        lastUpdated: new Date().toISOString()
                    });

                    await this.redis.set(cacheKey, cacheData, { EX: 3600 });
                }

                // 尝试设置余额订阅
                try {
                    subscriptionId = await this.solanaService.subscribeToBalance({
                        publicKey: keypair.publicKey.toString(),
                        groupType,
                        accountNumber,
                        lastKnownBalance: balance / LAMPORTS_PER_SOL
                    });

                    logger.info('余额订阅设置成功:', {
                        groupType,
                        accountNumber,
                        publicKey: keypair.publicKey.toString(),
                        subscriptionId
                    });
                } catch (subscriptionError) {
                    // 订阅失败不影响导入结果
                    logger.warn('余额订阅设置失败 (非致命错误):', {
                        error: subscriptionError.message,
                        groupType,
                        accountNumber,
                        publicKey: keypair.publicKey.toString()
                    });
                }
            } catch (nonCriticalError) {
                // 非关键操作失败不影响导入结果
                logger.warn('非关键操作失败 (缓存/订阅):', {
                    error: nonCriticalError.message,
                    groupType,
                    accountNumber
                });
            }

            // 返回导入结果
            return {
                ...wallet.toJSON(),
                balance: balance / LAMPORTS_PER_SOL,
                subscriptionId  // 可能为 null,如果订阅失败
            };

        } catch (error) {
            if (transaction) {
                try {
                    await transaction.rollback();
                } catch (rollbackError) {
                    logger.error('事务回滚失败:', {
                        error: rollbackError.message,
                        originalError: error.message
                    });
                }
            }

            logger.error('钱包导入失败:', {
                error: error.message,
                stack: error.stack,
                groupType,
                accountNumber
            });

            throw error;
        }
    }

    // 取消余额订阅
    async unsubscribeFromBalance(groupType, accountNumber) {
        const subscriptionKey = `${groupType}:${accountNumber}`;
        const subscription = this.balanceSubscriptions.get(subscriptionKey);

        if (subscription) {
            try {
                await this.solanaService.unsubscribeFromAccount(subscription.subscriptionId);
                this.balanceSubscriptions.delete(subscriptionKey);

                logger.info('取消余额订阅成功:', {
                    groupType,
                    accountNumber,
                    publicKey: subscription.publicKey,
                    subscriptionId: subscription.subscriptionId
                });
            } catch (error) {
                logger.error('取消余额订阅失败:', {
                    error: error.message,
                    groupType,
                    accountNumber,
                    subscriptionId: subscription.subscriptionId
                });
                throw error;
            }
        }
    }

    // 1对多转账
    async oneToMany(fromGroupType, fromAccountNumber, toGroupType, toAccountRange, amount = null) {
        try {
            logger.info("fromGroupType, fromAccountNumber, toGroupType, toAccountRange, amount",
                {fromGroupType, fromAccountNumber, toGroupType, toAccountRange, amount})
            // 获取源钱包
            const fromWallet = await this.getWalletKeypair(fromGroupType, fromAccountNumber);
            if (!fromWallet) {
                throw new CustomError(
                    ErrorCodes.WALLET.NOT_FOUND,
                    `源钱包不存在: ${fromGroupType}-${fromAccountNumber}`
                );
            }

            // 解析目标账户范围
            const [start, end] = toAccountRange.split('-').map(Number);
            if (isNaN(start) || isNaN(end) || start > end) {
                throw new CustomError(
                    ErrorCodes.TRANSACTION.INVALID_PARAMS,
                    '无效的账户范围格式，请使用如 "1-5" 的格式'
                );
            }
            
            // 获取所有目标钱包
            const toWallets = await Promise.all(
                Array.from({ length: end - start + 1 }, async (_, i) => {
                    const currentAccountNumber = start + i;
                    const wallet = await this.getWallet(toGroupType, currentAccountNumber);
                    if (!wallet) {
                        throw new CustomError(
                            ErrorCodes.WALLET.NOT_FOUND,
                            `目标钱包不存在: ${toGroupType}-${currentAccountNumber}`
                        );
                    }

                    logger.info('获取到目标钱包:', {
                        groupType: toGroupType,
                        accountNumber: currentAccountNumber,
                        wallet
                    });

                    // 确保返回的钱包对象包含所有必要信息
                    return {
                        groupType: toGroupType,
                        accountNumber: currentAccountNumber,
                        publicKey: wallet.publicKey,
                        keypair: wallet.keypair
                    };
                })
            );

            // 执行转账
            const results = await Promise.all(
                toWallets.map(async (toWallet) => {
                    try {
                        logger.info('准备转账到钱包:', {
                            groupType: toWallet.groupType,
                            accountNumber: toWallet.accountNumber,
                            publicKey: toWallet.publicKey
                        });

                        const result = await this.solanaService.transfer(
                            fromWallet,
                            toWallet.publicKey,
                            amount
                        );

                        // 更新余额缓存
                        await this._updateBalanceAfterTransfer(
                            toWallet.groupType,
                            toWallet.accountNumber,
                            toWallet.publicKey
                        );

                        return {
                            status: 'success',
                            signature: result,
                            toPublicKey: toWallet.publicKey
                        };
                    } catch (error) {
                        logger.error('转账失败:', {
                            error: error.message,
                            toWallet: {
                                groupType: toWallet.groupType,
                                accountNumber: toWallet.accountNumber,
                                publicKey: toWallet.publicKey
                            }
                        });

                        return {
                            status: 'failed',
                            error: error.message,
                            toPublicKey: toWallet.publicKey
                        };
                    }
                })
            );

            // 更新源钱包余额缓存
            await this._updateBalanceAfterTransfer(
                fromGroupType,
                fromAccountNumber,
                fromWallet.publicKey.toString()
            );

            return {
                fromWallet: fromWallet.publicKey.toString(),
                toWallets: toWallets.map(w => w.publicKey),
                perAccountAmount: amount,
                results
            };
        } catch (error) {
            logger.error('一对多转账失败:', {
                error: error.message,
                stack: error.stack,
                params: {
                    fromGroupType,
                    fromAccountNumber,
                    toGroupType,
                    toAccountRange,
                    amount
                }
            });

            throw new CustomError(
                ErrorCodes.TRANSACTION.TRANSFER_FAILED,
                `一对多转账失败: ${error.message}`
            );
        }
    }
    async getWalletTokens(groupType, accountNumber) {
        try {
            logger.info('开始获取钱包代币信息:', {
                groupType,
                accountNumber
            });

            // 1. 先获取钱包
            const wallet = await this.getWallet(groupType, accountNumber);
            if (!wallet) {
                throw new Error(`钱包不存在: ${groupType}-${accountNumber}`);
            }

            // 2. 获取该钱包的所有代币账户
            const walletPublicKey = new PublicKey(wallet.publicKey);
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                walletPublicKey,
                {
                    programId: TOKEN_PROGRAM_ID
                }
            );

            // 3. 提取代币信息
            const tokens = tokenAccounts.value.map(item => {
                const accountInfo = item.account.data.parsed.info;
                return {
                    name: accountInfo.mint, // 代币地址，可以根据需要获取名称
                    address: accountInfo.mint,
                    amount: accountInfo.tokenAmount.uiAmount
                };
            });

            logger.info('获取钱包代币信息成功:', {
                groupType,
                accountNumber,
                tokenCount: tokens.length
            });

            return {
                wallet: {
                    groupType,
                    accountNumber,
                    publicKey: wallet.publicKey
                },
                tokens
            };
        } catch (error) {
            logger.error('获取钱包代币失败:', {
                error: error.message,
                groupType,
                accountNumber
            });
            throw error;
        }
    }

    async getEnhancedTokenInfo(mintAddress) {
        try {
            logger.info('获取增强的代币信息:', { mintAddress });

            const mintPublicKey = new PublicKey(mintAddress);

            // 获取代币铸造信息
            const mintInfo = await getMint(
                this.connection,
                mintPublicKey,
                'confirmed',
                TOKEN_PROGRAM_ID
            );

            // 获取代币所有账户
            const accounts = await this.connection.getTokenLargestAccounts(mintPublicKey);

            // 获取每个账户的详细信息
            const accountsInfo = await Promise.all(
                accounts.value.map(async (account) => {
                    try {
                        const accountInfo = await getAccount(
                            this.connection,
                            account.address,
                            'confirmed',
                            TOKEN_PROGRAM_ID
                        );

                        return {
                            address: account.address.toString(),
                            amount: account.amount,
                            uiAmount: Number(account.amount) / Math.pow(10, mintInfo.decimals),
                            owner: accountInfo.owner.toString(),
                            delegate: accountInfo.delegate?.toString(),
                            delegatedAmount: accountInfo.delegatedAmount?.toString(),
                            isFrozen: accountInfo.isFrozen
                        };
                    } catch (error) {
                        logger.error('获取账户信息失败:', {
                            error: error.message,
                            accountAddress: account.address.toString()
                        });
                        return null;
                    }
                })
            );

            const tokenInfo = {
                address: mintAddress,
                decimals: mintInfo.decimals,
                freezeAuthority: mintInfo.freezeAuthority?.toString(),
                mintAuthority: mintInfo.mintAuthority?.toString(),
                supply: {
                    raw: mintInfo.supply.toString(),
                    ui: Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals)
                },
                isInitialized: mintInfo.isInitialized,
                largestAccounts: accountsInfo.filter(Boolean),
                programId: TOKEN_PROGRAM_ID.toString()
            };

            logger.info('代币信息获取成功:', {
                mintAddress,
                supply: tokenInfo.supply.ui,
                decimals: tokenInfo.decimals,
                accountsCount: tokenInfo.largestAccounts.length
            });

            return tokenInfo;
        } catch (error) {
            logger.error('获取增强的代币信息失败:', {
                error: error.message,
                stack: error.stack,
                mintAddress
            });
            throw error;
        }
    }

// 获取代币的供应信息
    async getTokenSupplyInfo(mintAddress) {
        try {
            const mintPublicKey = new PublicKey(mintAddress);
            const mintInfo = await getMint(
                this.connection,
                mintPublicKey,
                'confirmed',
                TOKEN_PROGRAM_ID
            );

            return {
                mintAddress,
                supply: mintInfo.supply.toString(),
                decimals: mintInfo.decimals,
                uiSupply: Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals),
                mintAuthority: mintInfo.mintAuthority?.toString(),
                freezeAuthority: mintInfo.freezeAuthority?.toString()
            };
        } catch (error) {
            logger.error('获取代币供应信息失败:', {
                error: error.message,
                mintAddress
            });
            throw error;
        }
    }

// 获取钱包的所有代币账户
    async getWalletTokenAccounts(walletAddress) {
        try {
            const walletPublicKey = new PublicKey(walletAddress);

            // 获取所有代币账户
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                walletPublicKey,
                {
                    programId: TOKEN_PROGRAM_ID
                }
            );

            // 处理每个代币账户的信息
            const accountsInfo = tokenAccounts.value.map(account => {
                const accountInfo = account.account.data.parsed.info;
                return {
                    tokenAddress: accountInfo.mint,
                    accountAddress: account.pubkey.toString(),
                    balance: {
                        raw: accountInfo.tokenAmount.amount,
                        ui: accountInfo.tokenAmount.uiAmount
                    },
                    decimals: accountInfo.tokenAmount.decimals,
                    owner: accountInfo.owner,
                    state: accountInfo.state
                };
            });

            logger.info('获取钱包代币账户成功:', {
                walletAddress,
                accountCount: accountsInfo.length
            });

            return accountsInfo;
        } catch (error) {
            logger.error('获取钱包代币账户失败:', {
                error: error.message,
                stack: error.stack,
                walletAddress
            });
            throw error;
        }
    }

// 检查代币账户是否存在
    async checkTokenAccount(walletAddress, mintAddress) {
        try {
            const walletPublicKey = new PublicKey(walletAddress);
            const mintPublicKey = new PublicKey(mintAddress);

            const accounts = await this.connection.getParsedTokenAccountsByOwner(
                walletPublicKey,
                {
                    mint: mintPublicKey
                }
            );

            if (accounts.value.length === 0) {
                return {
                    exists: false,
                    account: null
                };
            }

            const accountInfo = accounts.value[0].account.data.parsed.info;
            return {
                exists: true,
                account: {
                    address: accounts.value[0].pubkey.toString(),
                    balance: accountInfo.tokenAmount.uiAmount,
                    decimals: accountInfo.tokenAmount.decimals,
                    owner: accountInfo.owner
                }
            };
        } catch (error) {
            logger.error('检查代币账户失败:', {
                error: error.message,
                walletAddress,
                mintAddress
            });
            throw error;
        }
    }

    async getTokenAccountInfo(walletAddress, mintAddress) {
        try {
            logger.info('获取代币账户信息:', {
                walletAddress,
                mintAddress
            });

            // 获取关联代币账户地址
            const associatedTokenAddress = await getAssociatedTokenAddress(
                new PublicKey(mintAddress),
                new PublicKey(walletAddress)
            );

            // 获取账户信息
            const accountInfo = await this.connection.getParsedAccountInfo(associatedTokenAddress);

            if (!accountInfo.value) {
                return null;
            }

            const tokenAmount = accountInfo.value.data.parsed.info.tokenAmount;

            return {
                address: associatedTokenAddress.toString(),
                mint: mintAddress,
                owner: walletAddress,
                amount: tokenAmount.uiAmount,
                decimals: tokenAmount.decimals,
                uiAmountString: tokenAmount.uiAmountString
            };
        } catch (error) {
            logger.error('获取代币账户信息失败:', {
                error: error.message,
                stack: error.stack,
                walletAddress,
                mintAddress
            });
            return null;
        }
    }

    async getTokenInfo(mintAddress) {
        try {
            logger.info('获取代币详细信息:', { mintAddress });

            // 获取代币元数据
            const tokenMetadata = await this.solanaService.getTokenMetadata(mintAddress);

            // 获取代币供应量
            const supply = await this.connection.getTokenSupply(new PublicKey(mintAddress));

            // 获取代币账户数量
            const tokenAccounts = await this.connection.getTokenAccountsByOwner(
                new PublicKey(mintAddress),
                { programId: TOKEN_PROGRAM_ID }
            );

            const tokenInfo = {
                address: mintAddress,
                name: tokenMetadata?.name || 'Unknown Token',
                symbol: tokenMetadata?.symbol || '-',
                decimals: supply.value.decimals,
                totalSupply: supply.value.uiAmount,
                holderCount: tokenAccounts.value.length,
                metadata: tokenMetadata
            };

            // 缓存结果
            if (this.redis) {
                const cacheKey = `token:info:${mintAddress}`;
                await this.redis.set(cacheKey, JSON.stringify(tokenInfo), 'EX', 300);
            }

            return tokenInfo;
        } catch (error) {
            logger.error('获取代币详细信息失败:', {
                error: error.message,
                stack: error.stack,
                mintAddress
            });
            throw error;
        }
    }
    // 修改批量更新余额的辅助方法
    async _updateWalletBalances(wallets) {
        try {
            // 验证输入
            wallets.forEach(wallet => {
                if (!wallet.groupType || !wallet.accountNumber) {
                    logger.error('无效的钱包数据:', wallet);
                    throw new Error('Invalid wallet data: missing required fields');
                }
            });

            // 更新 Redis 缓存
            if (this.redis) {
                await Promise.all(wallets.map(async wallet => {
                    // 获取最新的链上余额
                    const latestBalance = await this.solanaService.getBalance(wallet.publicKey);
                    const balanceInSOL = latestBalance / LAMPORTS_PER_SOL;

                    const cacheKey = `wallet:balance:${wallet.groupType}:${wallet.accountNumber}`;
                    
                    logger.info('更新钱包余额缓存:', {
                        cacheKey,
                        wallet: {
                            groupType: wallet.groupType,
                            accountNumber: wallet.accountNumber,
                            publicKey: wallet.publicKey,
                            oldBalance: wallet.balance,
                            newBalance: balanceInSOL
                        }
                    });

                    await this.redis.set(cacheKey, balanceInSOL.toString());
                }));
            }

            // 更新 WebSocket 订阅
            wallets.forEach(wallet => {
                const subscriptionKey = `${wallet.groupType}:${wallet.accountNumber}`;
                const subscription = this.balanceSubscriptions.get(subscriptionKey);
                if (subscription) {
                    subscription.lastKnownBalance = wallet.balance;
                }
            });
        } catch (error) {
            logger.error('更新钱包余额缓存失败:', {
                error: error.message,
                stack: error.stack,
                wallets
            });
            throw error;
        }
    }

    // 多对一转账（归集）
    async manyToOne(fromGroupType, fromAccountRange, toGroupType, toAccountNumber) {
        try {
            logger.info('开始多对一归集:', {
                fromGroupType,
                fromAccountRange,
                toGroupType,
                toAccountNumber
            });

            // 获取目标钱包
            const toWallet = await this.getWallet(toGroupType, toAccountNumber);
            if (!toWallet) {
                throw new CustomError(
                    ErrorCodes.WALLET.NOT_FOUND,
                    `目标钱包不存在: ${toGroupType}-${toAccountNumber}`
                );
            }

            logger.info('目标钱包获取成功:', {
                groupType: toGroupType,
                accountNumber: toAccountNumber,
                publicKey: toWallet.publicKey.toString()
            });

            // 解析账号范围
            const [start, end] = fromAccountRange.split('-').map(Number);
            if (isNaN(start) || isNaN(end) || start > end) {
                throw new CustomError(
                    ErrorCodes.TRANSACTION.INVALID_PARAMS,
                    '无效的账户范围格式，请使用如 "1-5" 的格式'
                );
            }

            logger.info('开始获取源钱包:', {
                fromGroupType,
                accountRange: `${start}-${end}`
            });

            // 获取所有源钱包
            const fromWallets = await Promise.all(
                Array.from({ length: end - start + 1 }, async (_, i) => {
                    const accountNumber = start + i;
                    try {
                        const wallet = await this.getWalletKeypair(fromGroupType, accountNumber);
                        if (!wallet) {
                            logger.warn('源钱包不存在:', {
                                groupType: fromGroupType,
                                accountNumber
                            });
                            return null;
                        }
                        logger.info('源钱包获取成功:', {
                            groupType: fromGroupType,
                            accountNumber,
                            publicKey: wallet.publicKey.toString()
                        });
                        return wallet;
                    } catch (error) {
                        logger.error('获取源钱包失败:', {
                            error: error.message,
                            groupType: fromGroupType,
                            accountNumber
                        });
                        return null;
                    }
                })
            );

            const validWallets = fromWallets.filter(w => w !== null);
            logger.info('源钱包获取完成:', {
                total: end - start + 1,
                valid: validWallets.length,
                wallets: validWallets.map(w => ({
                    publicKey: w.publicKey.toString()
                }))
            });

            const MINIMUM_BALANCE = 5000; // 保留 5000 lamports 作为手续费

            // 获取每个钱包的余额并计算转账金额
            const transfers = await Promise.all(
                validWallets.map(async (fromWallet) => {
                    try {
                        const balanceIn = await this.solanaService.getBalance(fromWallet.publicKey.toString());
                        const balanceInLamports=balanceIn*LAMPORTS_PER_SOL;
                        // 添加更详细的余额日志
                        logger.info('钱包余额详情:', {
                            publicKey: fromWallet.publicKey.toString(),
                            balanceInLamports: balanceInLamports,
                            balanceInSOL: balanceInLamports / LAMPORTS_PER_SOL,
                            minimumRequired: MINIMUM_BALANCE,
                            difference: balanceInLamports - MINIMUM_BALANCE,
                            hasEnoughBalance: balanceInLamports > MINIMUM_BALANCE,
                            details: {
                                currentBalance: `${balanceInLamports} lamports (${balanceInLamports / LAMPORTS_PER_SOL} SOL)`,
                                requiredBalance: `${MINIMUM_BALANCE} lamports (${MINIMUM_BALANCE / LAMPORTS_PER_SOL} SOL)`,
                                shortfall: `${MINIMUM_BALANCE - balanceInLamports} lamports (${(MINIMUM_BALANCE - balanceInLamports) / LAMPORTS_PER_SOL} SOL)`
                            }
                        });

                        if (balanceInLamports <= MINIMUM_BALANCE) {
                            logger.warn('钱包余额不足:', {
                                publicKey: fromWallet.publicKey.toString(),
                                currentBalance: {
                                    lamports: balanceInLamports,
                                    sol: balanceInLamports / LAMPORTS_PER_SOL
                                },
                                required: {
                                    lamports: MINIMUM_BALANCE,
                                    sol: MINIMUM_BALANCE / LAMPORTS_PER_SOL
                                },
                                shortfall: {
                                    lamports: MINIMUM_BALANCE - balanceInLamports,
                                    sol: (MINIMUM_BALANCE - balanceInLamports) / LAMPORTS_PER_SOL
                                }
                            });
                            return null;
                        }

                        // 计算可转账的 lamports 数量
                        const transferLamports = balanceInLamports - MINIMUM_BALANCE;
                        
                        // 确保转账金额大于 0
                        if (transferLamports <= 0) {
                            logger.warn('可转账金额为 0:', {
                                publicKey: fromWallet.publicKey.toString(),
                                balanceInLamports,
                                minimumRequired: MINIMUM_BALANCE
                            });
                            return null;
                        }

                        // 转换为 SOL (这里不需要再减去 MINIMUM_BALANCE，因为已经在 lamports 中减过了)
                        const transferAmount = transferLamports / LAMPORTS_PER_SOL;

                        logger.info('可转账金额计算完成:', {
                            fromPublicKey: fromWallet.publicKey.toString(),
                            balanceInLamports,
                            balanceInSOL: balanceInLamports / LAMPORTS_PER_SOL,
                            transferLamports,
                            transferAmountSOL: transferAmount,
                            reservedBalance: MINIMUM_BALANCE
                        });

                        return {
                            fromWallet,
                            amount: transferAmount,
                            originalBalance: balanceInLamports
                        };
                    } catch (error) {
                        logger.error('获取钱包余额失败:', {
                            error: error.message,
                            stack: error.stack,
                            publicKey: fromWallet.publicKey.toString()
                        });
                        return null;
                    }
                })
            );

            // 过滤掉余额不足的钱包
            const validTransfers = transfers.filter(t => t && t.amount > 0);

            logger.info('转账检查完成:', {
                totalWallets: validWallets.length,
                validTransfers: validTransfers.length,
                walletBalances: transfers.map(t => ({
                    publicKey: t?.fromWallet.publicKey.toString(),
                    balanceInLamports: t?.originalBalance || 0,
                    balanceInSOL: (t?.originalBalance || 0) / LAMPORTS_PER_SOL,
                    transferAmount: t?.amount || 0
                }))
            });

            if (validTransfers.length === 0) {
                throw new CustomError(
                    ErrorCodes.TRANSACTION.NO_VALID_TRANSFERS,
                    '没有可用的转账: 所有钱包余额都不足最小转账金额 (5000 lamports)'
                );
            }

            // 格式化余额的辅助函数
            const formatBalance = (balance) => {
                return Number((balance / LAMPORTS_PER_SOL).toFixed(9));
            };

            // 执行转账
            const results = await Promise.all(
                validTransfers.map(async ({ fromWallet, amount }) => {
                    try {
                        const result = await this.solanaService.transfer(
                            fromWallet,
                            toWallet.publicKey.toString(),
                            amount
                        );

                        // 格式化结果中的数值
                        return {
                            ...result,
                            amount: formatBalance(result.lamports),
                            beforeBalance: formatBalance(result.beforeBalance * LAMPORTS_PER_SOL),
                            afterBalance: formatBalance(result.afterBalance * LAMPORTS_PER_SOL),
                            fee: formatBalance(result.fee * LAMPORTS_PER_SOL)
                        };
                    } catch (error) {
                        return {
                            status: 'failed',
                            error: error instanceof CustomError ? error.message : `转账失败: ${error.message}`,
                            fromPublicKey: fromWallet.publicKey.toString(),
                            toPublicKey: toWallet.publicKey.toString(),
                            amount: formatBalance(amount * LAMPORTS_PER_SOL)
                        };
                    }
                })
            );

            logger.info('多对一转账完成:', {
                fromGroupType,
                fromAccountRange,
                toGroupType,
                toAccountNumber,
                totalTransfers: validTransfers.length,
                successCount: results.filter(r => r.status === 'success').length,
                results: results.map(r => ({
                    ...r,
                    amount: formatBalance(r.lamports || r.amount * LAMPORTS_PER_SOL),
                    fee: r.fee ? formatBalance(r.fee * LAMPORTS_PER_SOL) : undefined
                }))
            });

            return {
                success: true,
                fromWallets: validTransfers.map(t => t.fromWallet.publicKey.toString()),
                toWallet: toWallet.publicKey.toString(),
                results: results.map(r => ({
                    ...r,
                    amount: formatBalance(r.lamports || r.amount * LAMPORTS_PER_SOL),
                    fee: r.fee ? formatBalance(r.fee * LAMPORTS_PER_SOL) : undefined
                }))
            };
        } catch (error) {
            logger.error('多对一归集失败:', {
                error: error.message,
                stack: error.stack,
                fromGroupType,
                fromAccountRange,
                toGroupType,
                toAccountNumber,
                errorCode: error instanceof CustomError ? error.code : undefined
            });
            throw error;
        }
    }

    // 多对多转账
    async manyToMany(transfers) {
        try {
            const results = await Promise.all(
                transfers.map(async transfer => {
                    const fromWallet = await this.getWallet(transfer.fromGroup, transfer.fromAccount);
                    const toWallet = await this.getWallet(transfer.toGroup, transfer.toAccount);
                    
                    if (!fromWallet || !toWallet) {
                        throw new Error('Wallet not found');
                    }

                    return this.solanaService.transfer(
                        fromWallet,
                        toWallet,
                        transfer.amount
                    );
                })
            );

            return results;
        } catch (error) {
            logger.error('多对多转账失败:', error);
            throw error;
        }
    }

    // 关闭钱包账户
    async closeWallet(groupType, accountNumber, recipientGroupType, recipientAccountNumber) {
        try {
            // 获取源钱包
            const sourceWallet = await this.getWallet(groupType, accountNumber);
            if (!sourceWallet) {
                throw new Error(`Source wallet not found: ${groupType}/${accountNumber}`);
            }

            // 获取接收钱包
            const recipientWallet = await this.getWallet(recipientGroupType, recipientAccountNumber);
            if (!recipientWallet) {
                throw new Error(`Recipient wallet not found: ${recipientGroupType}/${recipientAccountNumber}`);
            }

            logger.info('开始关闭钱包:', {
                fromPublicKey: sourceWallet.publicKey.toString(),
                toPublicKey: recipientWallet.publicKey.toString()
            });

            // 获取源钱包的 Keypair
            const sourceKeypair = await this.getWalletKeypair(groupType, accountNumber);
            if (!sourceKeypair) {
                throw new Error('Failed to get source wallet keypair');
            }

            // 关闭账户并转移余额
            const signature = await this.solanaService.closeAccount(
                sourceKeypair,
                recipientWallet.publicKey.toString()
            );

            // 更新数据库中的钱包状态
            await db.models.Wallet.update(
                { 
                    status: 'closed',
                    metadata: {
                        closedAt: new Date().toISOString(),
                        closedBy: recipientWallet.publicKey.toString(),
                        signature
                    }
                },
                {
                    where: {
                        groupType,
                        accountNumber
                    }
                }
            );

            // 取消余额订阅
            await this.unsubscribeFromBalance(groupType, accountNumber);

            logger.info('钱包关闭成功:', {
                groupType,
                accountNumber,
                recipientGroupType,
                recipientAccountNumber,
                signature
            });

            return {
                success: true,
                signature,
                sourceWallet: sourceWallet.publicKey.toString(),
                recipientWallet: recipientWallet.publicKey.toString()
            };
        } catch (error) {
            logger.error('关闭钱包失败:', {
                error: error.message,
                groupType,
                accountNumber,
                recipientGroupType,
                recipientAccountNumber
            });
            throw error;
        }
    }
    // Add this method to WalletService class
    async getAllGroupsInfo() {
        try {
            logger.info('开始获取所有组信息');

            // 从数据库获取所有组信息
            const groups = await db.models.Group.findAll({
                order: [['createdAt', 'DESC']],
                attributes: [
                    'id',
                    'groupType',
                    'description',
                    'status',
                    'createdAt',
                    'lastUsed',
                    'metadata',
                    'updatedAt'
                ]
            });

            // 转换为标准格式
            const groupsInfo = groups.map(group => ({
                id: group.id,
                groupType: group.groupType,
                description: group.description,
                status: group.status,
                createdAt: group.createdAt,
                lastUsed: group.lastUsed,
                metadata: group.metadata,
                updatedAt: group.updatedAt
            }));

            logger.info('获取所有组信息成功', {
                totalGroups: groupsInfo.length
            });

            return groupsInfo;
        } catch (error) {
            logger.error('获取所有组信息失败:', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }
    async getBasicGroupInfo(groupType) {
        try {
            logger.info('开始获取组基本信息:', { groupType });

            // 获取组信息
            const group = await db.models.Group.findOne({
                where: { groupType }
            });

            if (!group) {
                throw new Error(`Group ${groupType} not found`);
            }

            // 只返回基本信息
            const groupInfo = {
                id: group.id,
                groupType: group.groupType,
                description: group.description,
                status: group.status,
                createdAt: group.createdAt,
                lastUsed: group.lastUsed,
                metadata: group.metadata
            };

            logger.info('组基本信息获取成功:', {
                groupType,
                groupId: group.id
            });

            return groupInfo;
        } catch (error) {
            logger.error('获取组基本信息失败:', {
                error: error.message,
                stack: error.stack,
                groupType
            });
            throw error;
        }
    }

    // 批量关闭钱包
    async batchCloseWallets(fromGroupType, accountRange, mainGroupType, mainAccountNumber) {
        try {
            logger.info('开始批量关闭账户:', {
                fromGroupType,
                accountRange,
                mainGroupType,
                mainAccountNumber
            });

            // 1. 参数验证
            if (!mainGroupType || !mainAccountNumber) {
                throw new Error('Main account information is required');
            }

            // 2. 获取主账户
            const mainWallet = await this.getWallet(mainGroupType, mainAccountNumber);
            if (!mainWallet) {
                throw new Error('Main wallet not found');
            }

            // 3. 解析账号范围
            const [start, end] = accountRange.split('-').map(Number);
            if (isNaN(start) || isNaN(end) || start > end) {
                throw new Error('Invalid account range');
            }

            // 4. 获取批处理配置
            const totalAccounts = end - start + 1;
            const config = this._getBatchCloseConfig(totalAccounts);

            // 5. 创建批次
            const batches = this._createCloseBatches(start, end, config.batchSize);

            // 6. 处理结果初始化
            const results = {
                successful: [],
                failed: [],
                skipped: [],
                summary: {
                    totalAccounts,
                    processedAccounts: 0,
                    solTransferred: 0,
                    tokensTransferred: [],
                    closed: 0
                }
            };

            // 7. 批量处理
            for (let i = 0; i < batches.length; i += config.concurrentBatches) {
                const currentBatches = batches.slice(i, i + config.concurrentBatches);

                // 处理当前批次
                const batchResults = await Promise.all(
                    currentBatches.map(batch =>
                        this._processCloseBatch(batch, fromGroupType, mainWallet, config)
                    )
                );

                // 合并结果
                batchResults.forEach(batchResult => {
                    results.successful.push(...batchResult.successful);
                    results.failed.push(...batchResult.failed);
                    results.skipped.push(...batchResult.skipped);
                    results.summary.solTransferred += batchResult.solTransferred;
                    results.summary.closed += batchResult.closed;
                    // 合并Token转移记录
                    batchResult.tokensTransferred.forEach(tokenInfo => {
                        const existingToken = results.summary.tokensTransferred.find(
                            t => t.mint === tokenInfo.mint
                        );
                        if (existingToken) {
                            existingToken.amount += tokenInfo.amount;
                        } else {
                            results.summary.tokensTransferred.push(tokenInfo);
                        }
                    });
                });

                // 更新进度
                results.summary.processedAccounts += currentBatches.reduce(
                    (sum, batch) => sum + batch.length, 0
                );

                // 批次间延迟
                if (i + config.concurrentBatches < batches.length) {
                    await this._sleep(config.delayBetweenBatches);
                }
            }

            return results;

        } catch (error) {
            logger.error('批量关闭账户失败:', {
                error: error.message,
                stack: error.stack,
                params: {
                    fromGroupType,
                    accountRange,
                    mainGroupType,
                    mainAccountNumber
                }
            });
            throw error;
        }
    }
    /**
     * 创建账户关闭的批次数组
     * @param {number} start - 起始账号
     * @param {number} end - 结束账号
     * @param {number} batchSize - 每个批次的大小
     * @returns {Array<Array<number>>} 批次数组
     * @throws {Error} 参数验证失败时抛出错误
     */
    _createCloseBatches(start, end, batchSize) {
        try {
            // 参数验证
            if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(batchSize)) {
                throw new Error('所有参数必须为整数');
            }

            if (start > end) {
                throw new Error('起始账号不能大于结束账号');
            }

            if (batchSize <= 0) {
                throw new Error('批次大小必须大于0');
            }

            const batches = [];
            let currentBatch = [];
            const totalAccounts = end - start + 1;

            logger.info('开始创建关闭批次', {
                start,
                end,
                batchSize,
                totalAccounts
            });

            for (let accountNumber = start; accountNumber <= end; accountNumber++) {
                currentBatch.push(accountNumber);

                if (currentBatch.length === batchSize || accountNumber === end) {
                    batches.push([...currentBatch]);

                    logger.debug('创建新批次', {
                        batchNumber: batches.length,
                        batchSize: currentBatch.length,
                        accounts: currentBatch
                    });

                    currentBatch = [];
                }
            }

            logger.info('批次创建完成', {
                totalBatches: batches.length,
                totalAccounts: totalAccounts
            });

            return batches;

        } catch (error) {
            logger.error('创建关闭批次失败', {
                error: error.message,
                params: { start, end, batchSize }
            });
            throw error;
        }
    }
// 处理单个批次
    async _processCloseBatch(accountNumbers, fromGroupType, mainWallet, config) {
        const results = {
            successful: [],
            failed: [],
            skipped: [],
            solTransferred: 0,
            tokensTransferred: [],
            closed: 0
        };

        for (const accountNumber of accountNumbers) {
            try {
                // 1. 获取源钱包
                const sourceWallet = await this.getWallet(fromGroupType, accountNumber);
                if (!sourceWallet) {
                    results.skipped.push({
                        accountNumber,
                        reason: 'Wallet not found'
                    });
                    continue;
                }

                // 2. 先检查并转移 Token 余额 (需要 SOL 作为手续费)
                const tokenTransfers = await this._transferTokenBalances(
                    sourceWallet,
                    mainWallet,
                    config
                );
                if (tokenTransfers.length > 0) {
                    results.tokensTransferred.push(...tokenTransfers);
                    logger.info('Token 转移完成:', {
                        fromWallet: sourceWallet.publicKey.toString(),
                        toWallet: mainWallet.publicKey.toString(),
                        transfers: tokenTransfers
                    });
                }

                // 3. 然后再转移并关闭账户 (一次性转移所有剩余 SOL)
                const solBalance = await this._transferSolBalance(
                    sourceWallet,
                    mainWallet,
                    config
                );
                if (solBalance > 0) {
                    results.solTransferred += solBalance;
                    logger.info('SOL 转移完成:', {
                        fromWallet: sourceWallet.publicKey.toString(),
                        toWallet: mainWallet.publicKey.toString(),
                        amount: solBalance
                    });
                }

                // 4. 更新数据库状态
                await db.models.Wallet.update(
                    {
                        status: 'closed',
                        metadata: {
                            closedAt: new Date().toISOString(),
                            closedBy: mainWallet.publicKey.toString()
                        }
                    },
                    {
                        where: {
                            groupType:fromGroupType,
                            accountNumber
                        }
                    }
                );
                results.closed++;

                results.successful.push({
                    accountNumber,
                    solTransferred: solBalance,
                    tokensTransferred: tokenTransfers
                });

            } catch (error) {
                logger.error('处理账户关闭失败:', {
                    error: error.message,
                    fromGroupType,
                    accountNumber,
                    stack: error.stack
                });

                results.failed.push({
                    accountNumber,
                    error: error.message
                });
            }
        }

        return results;
    }




// 转移SOL余额
    async _transferSolBalance(sourceWallet, mainWallet, config) {
        const balance = await this.getBalance(
            sourceWallet.groupType,
            sourceWallet.accountNumber
        );

        if (balance > 0.001) { // 保留0.001 SOL作为关闭账户手续费
            const transferAmount = balance - 0.001;
            await this.transfer(
                sourceWallet.groupType,
                sourceWallet.accountNumber,
                mainWallet.groupType,
                mainWallet.accountNumber,
                transferAmount
            );
            return transferAmount;
        }

        return 0;
    }

// 转移Token余额
    async _transferTokenBalances(sourceWallet, mainWallet, config) {
        const tokenAccounts = await this.getWalletTokens(
            sourceWallet.groupType,
            sourceWallet.accountNumber
        );

        const transfers = [];
        for (const token of tokenAccounts.tokens) {
            if (token.amount > 0) {
                await this.transferToken(
                    sourceWallet.groupType,
                    sourceWallet.accountNumber,
                    mainWallet.groupType,
                    mainWallet.accountNumber,
                    token.address,
                    token.amount
                );
                transfers.push({
                    mint: token.address,
                    amount: token.amount
                });
            }
        }

        return transfers;
    }

    // 获取批处理配置
    _getBatchCloseConfig(totalAccounts) {
        if (totalAccounts <= 4) return BATCH_CLOSE_CONFIG.SMALL;
        if (totalAccounts <= 50) return BATCH_CLOSE_CONFIG.MEDIUM;
        if (totalAccounts <= 100) return BATCH_CLOSE_CONFIG.LARGE;
        if (totalAccounts <= 500) return BATCH_CLOSE_CONFIG.XLARGE;
        return BATCH_CLOSE_CONFIG.XXLARGE;
    }

    // 添加新方法用于获取 Keypair
    async getWalletKeypair(groupType, accountNumber) {
        try {
            logger.info('获取钱包 Keypair:', {
                groupType,
                accountNumber
            });

            // 从数据库获取钱包信息
            const wallet = await db.models.Wallet.findOne({
                where: {
                    groupType,
                    accountNumber,
                    status: 'active'
                }
            });
            logger.info('获取钱包 wallet:', {
                wallet
            });
            if (!wallet) {
                throw new Error(`Wallet not found: ${groupType}-${accountNumber}`);
            }

            // 解密私钥
            const privateKeyString = await this.encryptionManager.decrypt(
                wallet.encryptedPrivateKey,
                wallet.iv,
                wallet.salt,
                wallet.authTag
            );
            logger.info('获取钱包 privateKeyString:', {
                privateKeyString
            });
            // 将 base64 格式的私钥转换为 Uint8Array
            const privateKeyBytes = Buffer.from(privateKeyString, 'base64');
            logger.info('获取钱包 privateKeyBytes:', {
                privateKeyBytes
            });
            // 创建并返回 Keypair
            return Keypair.fromSecretKey(new Uint8Array(privateKeyBytes));

        } catch (error) {
            logger.error('获取钱包 Keypair 失败:', {
                error: error.message,
                groupType,
                accountNumber
            });
            throw error;
        }
    }

    // 获取代币余额
    async getTokenBalance(groupType, accountNumber, mintAddress) {
        try {
            // 1. 清理 mintAddress 字符串
            const cleanMintAddress = mintAddress.trim();

            // 2. 获取钱包
            const wallet = await this.getWallet(groupType, accountNumber);
            if (!wallet) {
                throw new Error(`Wallet not found: ${groupType}-${accountNumber}`);
            }

            // 3. 转换为 PublicKey 对象
            const ownerPublicKey = new PublicKey(wallet.publicKey);
            const mintPublicKey = new PublicKey(cleanMintAddress);

            logger.info('开始获取代币余额:', {
                groupType,
                accountNumber,
                mintAddress: cleanMintAddress,
                publicKey: wallet.publicKey
            });

            // 4. 获取链上余额
            const balance = await this.solanaService.getTokenBalance(
                ownerPublicKey,
                mintPublicKey
            );

            logger.info('获取代币余额成功:', {
                groupType,
                accountNumber,
                mintAddress: cleanMintAddress,
                publicKey: wallet.publicKey,
                balance: balance.toString()
            });

            return balance;
        } catch (error) {
            logger.error('获取代币余额失败:', {
                error: error.message,
                groupType,
                accountNumber,
                mintAddress,
                stack: error.stack
            });
            throw error;
        }
    }

    // 批量查询代币余额
    async batchGetTokenBalances(groupType, accountNumber, mintAddresses) {
        try {
            // 1. 获取钱包
            const wallet = await this.getWallet(groupType, accountNumber);
            if (!wallet) {
                throw new Error(`Wallet not found: ${groupType}/${accountNumber}`);
            }

            const ownerPublicKey = wallet.publicKey;  // 这里已经是 PublicKey 实例

            // 2. 批量订阅这些代币的余额变动
            if (this.solanaService.tokenSubscriptionService) {
                await this.solanaService.tokenSubscriptionService.batchSubscribeToTokenBalances([{
                    ownerAddress: ownerPublicKey.toString(),
                    mintAddresses
                }]);
                
                logger.info('批量订阅代币余额变动:', {
                    groupType,
                    accountNumber,
                    mintAddresses
                });
            }

            // 3. 并行查询所有代币余额
            const balances = await Promise.all(
                mintAddresses.map(async (mintAddress) => {
                    try {
                        const balance = await this.solanaService.tokenSubscriptionService.getTokenBalance(
                            ownerPublicKey.toString(),
                            mintAddress
                        );
                        return {
                            mintAddress,
                            balance: balance.toString(),
                            success: true
                        };
                    } catch (error) {
                        return {
                            mintAddress,
                            error: error.message,
                            success: false
                        };
                    }
                })
            );

            logger.info('批量获取代币余额完成:', {
                groupType,
                accountNumber,
                totalTokens: mintAddresses.length,
                successCount: balances.filter(b => b.success).length,
                failedCount: balances.filter(b => !b.success).length
            });

            return balances;
        } catch (error) {
            logger.error('批量获取代币余额失败:', {
                error: error.message,
                groupType,
                accountNumber,
                mintAddresses
            });
            throw error;
        }
    }

    async getFullBalance(groupType, accountNumber) {
        try {
            const wallet = await this.getWallet(groupType, accountNumber);
            if (!wallet) {
                throw new Error(`Wallet not found: ${groupType}/${accountNumber}`);
            }

            const balance = await this.getBalance(groupType, accountNumber);
            const tokenBalances = await this.getTokenBalance(groupType, accountNumber, 'token_address');

            return {
                groupType,
                accountNumber,
                publicKey: wallet.publicKey,
                balance,
                tokenBalances
            };
        } catch (error) {
            logger.error('获取完整余额失败:', {
                error: error.message,
                groupType,
                accountNumber
            });
            throw error;
        }
    }

    // 在转账后更新余额缓存和订阅
    async _updateBalanceAfterTransfer(groupType, accountNumber, publicKey) {
        try {
            // 获取最新余额
            const balance = await this.solanaService.getBalance(publicKey);
            const balanceInSOL = balance / LAMPORTS_PER_SOL;

            // 更新 Redis 缓存
            if (this.redis) {
                const cacheKey = `wallet:balance:${groupType}:${accountNumber}`;
                await this.redis.set(cacheKey, balanceInSOL.toString());
            }

            if (this.solanaService && typeof this.solanaService.subscribeToBalance === 'function') {
                await this.solanaService.subscribeToBalance({
                    publicKey,
                    groupType,
                    accountNumber,
                    lastKnownBalance: balanceInSOL
                });
            }

            return balanceInSOL;
        } catch (error) {
            logger.error('更新余额失败:', {
                error: error.message,
                groupType,
                accountNumber,
                publicKey
            });
            throw error;
        }
    }

    async createAndBuy(groupType, accountNumber, metadata, solAmount) {
        try {
            // 获取钱包
            const wallet = await this.getWallet(groupType, accountNumber);
            
            // 创建和购买代币
            const result = await this.solanaService.createAndBuy(
                wallet.keypair,
                metadata,
                solAmount
            );

            // 保存交易记录
            await db.models.Transaction.create({
                signature: result.signature,
                mint: result.mint,
                owner: result.owner,
                type: 'create_and_buy',
                amount: solAmount.toString(),
                // 添加代币相关信息
                tokenAmount: result.tokenAmount.toString(),
                tokenDecimals: result.tokenDecimals || 9,
                pricePerToken: result.pricePerToken?.toString(),
                slippage: result.slippage || 0,
                status: 'success',
                raw: {
                    ...result,
                    metadata,
                    timestamp: new Date().toISOString()
                }
            });

            logger.info('代币创建和购买成功:', {
                mint: result.mint,
                owner: result.owner,
                signature: result.signature,
                solAmount,
                tokenAmount: result.tokenAmount,
                metadata: {
                    name: metadata.name,
                    symbol: metadata.symbol,
                    uri: result.metadataUri
                }
            });

            return {
                success: true,
                mint: result.mint,
                owner: result.owner,
                signature: result.signature,
                solAmount,
                tokenAmount: result.tokenAmount,
                metadata: {
                    name: metadata.name,
                    symbol: metadata.symbol,
                    uri: result.metadataUri
                }
            };
        } catch (error) {
            logger.error('创建和购买代币失败:', {
                error: error.message,
                stack: error.stack,
                groupType,
                accountNumber,
                metadata
            });
            throw error;
        }
    }

    // 买入代币
    async buyTokens(groupType, accountNumber, mint, solAmount) {
        try {
            const wallet = await this.getWallet(groupType, accountNumber);
            const result = await this.solanaService.buyTokens(wallet.keypair, mint, solAmount);

            // 保存交易记录
            await db.models.Transaction.create({
                signature: result.signature,
                mint: mint,
                owner: wallet.publicKey,
                type: 'buy',
                amount: solAmount.toString(),
                // 添加代币相关信息
                tokenAmount: result.tokenAmount.toString(),
                tokenDecimals: result.tokenDecimals || 9,
                pricePerToken: result.pricePerToken?.toString(),
                slippage: result.slippage || 0,
                status: 'success',
                raw: {
                    ...result,
                    timestamp: new Date().toISOString()
                }
            });

            return {
                success: true,
                signature: result.signature,
                solAmount,
                tokenAmount: result.tokenAmount
            };
        } catch (error) {
            logger.error('买入代币失败:', {
                error: error.message,
                stack: error.stack,
                groupType,
                accountNumber,
                mint,
                solAmount
            });
            throw error;
        }
    }
}