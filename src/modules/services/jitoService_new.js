import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import axios from 'axios';

// 日志配置
const logger = {
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args)
};

export class JitoService {
    constructor(connection, config = {}) {
        this.connection = connection;
        this.config = {
            endpoints: [
                'https://mainnet.block-engine.jito.wtf:443/api/v1',
                'https://amsterdam.mainnet.block-engine.jito.wtf:443/api/v1',
                'https://frankfurt.mainnet.block-engine.jito.wtf:443/api/v1',
                'https://ny.mainnet.block-engine.jito.wtf:443/api/v1',
                'https://tokyo.mainnet.block-engine.jito.wtf:443/api/v1'
            ],
            uuid: null,
            tipAmount: 2_000_000, // 默认 0.002 SOL
            maxBundleSize: 5,
            retryAttempts: 3,
            retryDelayMs: 1000,
            ...config
        };
        this.bestEndpoint = null;
    }
    async cleanup() {
        try {
            logger.info('开始清理 Jito 服务资源');

            // 清理任何活跃的 bundle 监控
            // 这里可以终止任何正在进行的监控任务

            // 重置服务状态
            this.bestEndpoint = null;

            // 如果有任何活跃的 WebSocket 连接，关闭它们
            // 目前的实现没有保持 WebSocket 连接，但如果将来添加了，可以在这里处理

            logger.info('Jito 服务资源清理完成');
        } catch (error) {
            logger.error('清理 Jito 服务资源时出错:', {
                error: error.message,
                stack: error.stack
            });
            // 即使清理失败也不抛出错误，因为这是一个清理操作
        }
    }
    /**
     * 初始化服务并选择最佳端点
     */
    async initialize() {
        const endpoints = this.config.endpoints;
        let bestLatency = Infinity;
        let bestEndpoint = endpoints[0];

        for (const endpoint of endpoints) {
            try {
                const start = Date.now();
                // 使用 getTipAccounts 进行端点测试，因为它是轻量级操作
                await axios.post(`${endpoint}/bundles`, {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "getTipAccounts",
                    params: []
                }, {
                    // 设置较短的超时时间
                    timeout: 3000,
                    headers: {
                        'Content-Type': 'application/json',
                        ...(this.config.uuid ? { 'x-jito-auth': this.config.uuid } : {})
                    }
                });

                const latency = Date.now() - start;
                logger.info(`端点 ${endpoint} 延迟: ${latency}ms`);

                if (latency < bestLatency) {
                    bestLatency = latency;
                    bestEndpoint = endpoint;
                }
            } catch (error) {
                let errorMessage = error.message;
                if (error.response) {
                    errorMessage = `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`;
                } else if (error.request) {
                    errorMessage = 'No response received';
                }
                logger.warn(`端点 ${endpoint} 不可用: ${errorMessage}`);
            }
        }

        if (bestLatency === Infinity) {
            throw new Error('所有端点都不可用');
        }

        this.bestEndpoint = bestEndpoint;
        logger.info(`选择最佳端点: ${this.bestEndpoint} (延迟: ${bestLatency}ms)`);
    }

    /**
     * 获取所有 tip 账户
     */
    async getTipAccounts() {
        try {
            const response = await axios.post(`${this.bestEndpoint}/bundles`, {
                jsonrpc: "2.0",
                id: 1,
                method: "getTipAccounts",
                params: []
            });

            if (!response?.data?.result) {
                throw new Error('Invalid getTipAccounts response');
            }

            return response.data.result;
        } catch (error) {
            logger.error('获取 tip 账户失败:', error);
            throw error;
        }
    }

    /**
     * 随机获取一个 tip 账户
     */
    async getTipAccount() {
        const tipAccounts = await this.getTipAccounts();
        if (!tipAccounts || tipAccounts.length === 0) {
            throw new Error('No tip accounts available');
        }
        return tipAccounts[Math.floor(Math.random() * tipAccounts.length)];
    }

    /**
     * 为单个交易添加小费
     */
    /**
     * 为单个交易添加小费
     */
    async addTipToTransaction(transaction, options = {}) {
        // 获取tip账户，优先使用传入的，否则获取一个
        const tipAccount = options.tipAccount || await this.getTipAccount();
        const LAMPORTS_PER_SOL = 1000000000;

        // 设置tip金额，优先使用传入的tipAmountSol，否则使用config中的默认值
        let tipAmount;
        if (options.tipAmountSol !== undefined) {
            tipAmount = Math.floor(options.tipAmountSol * LAMPORTS_PER_SOL);
        } else {
            tipAmount = this.config.tipAmount;
        }

        const tipPubkey = new PublicKey(tipAccount);

        // 检查交易是否设置了feePayer
        if (!transaction.feePayer) {
            throw new Error('Transaction feePayer is required');
        }

        // 创建全新的交易而不是修改现有交易
        const newTransaction = new Transaction();
        newTransaction.feePayer = transaction.feePayer;
        newTransaction.recentBlockhash = transaction.recentBlockhash;

        if (transaction.lastValidBlockHeight) {
            newTransaction.lastValidBlockHeight = transaction.lastValidBlockHeight;
        }

        // 创建小费指令
        const tipInstruction = SystemProgram.transfer({
            fromPubkey: transaction.feePayer,
            toPubkey: tipPubkey,
            lamports: tipAmount
        });

        // 先添加小费指令
        newTransaction.add(tipInstruction);

        // 再添加原交易的所有指令
        transaction.instructions.forEach(ix => newTransaction.add(ix));

        // 关键部分：始终重新签名整个交易
        if (options.wallet) {
            // 清除可能存在的无效部分签名
            newTransaction.signatures = [];

            // 使用钱包完全签名整个交易
            newTransaction.sign(options.wallet);

            logger.info('添加小费后重新签名交易:', {
                wallet: options.wallet.publicKey.toString(),
                tipAmount: tipAmount,
                signatureCount: newTransaction.signatures.length
            });
        } else {
            throw new Error('必须提供钱包来签名小费交易');
        }

        return newTransaction;
    }

    verifyTransactionSignatures(transactions) {
        for (let i = 0; i < transactions.length; i++) {
            const tx = transactions[i];

            // 检查feePayer是否设置
            if (!tx.feePayer) {
                throw new Error(`交易 #${i+1} 没有设置feePayer`);
            }

            // 检查是否有最近的区块哈希
            if (!tx.recentBlockhash) {
                throw new Error(`交易 #${i+1} 没有设置recentBlockhash`);
            }

            // 检查feePayer是否已签名
            const feePayerSigned = tx.signatures.some(s =>
                s.publicKey.equals(tx.feePayer) && s.signature !== null
            );

            if (!feePayerSigned) {
                throw new Error(`交易 #${i+1} 缺少feePayer的签名: ${tx.feePayer.toBase58()}`);
            }

            // 检查所有指令的必要签名
            const requiredSigners = new Set();
            requiredSigners.add(tx.feePayer.toBase58());

            tx.instructions.forEach((ix, ixIndex) => {
                ix.keys.forEach((key, keyIndex) => {
                    if (key.isSigner) {
                        requiredSigners.add(key.pubkey.toBase58());
                    }
                });
            });

            // 验证所有必要的签名都存在
            for (const requiredSigner of requiredSigners) {
                const signerPubkey = new PublicKey(requiredSigner);
                const hasSigned = tx.signatures.some(s =>
                    s.publicKey.equals(signerPubkey) && s.signature !== null
                );

                if (!hasSigned) {
                    throw new Error(`交易 #${i+1} 缺少必要的签名: ${requiredSigner}`);
                }
            }

            logger.info(`交易 #${i+1} 签名验证通过`, {
                feePayer: tx.feePayer.toBase58(),
                signatureCount: tx.signatures.length,
                requiredSignersCount: requiredSigners.size
            });
        }
    }
    /**
     * 批量发送交易
     */
    async sendBatchTransactions(transactions, options = {}) {
        const {
            tipAmount = this.config.tipAmount,
            maxBundleSize = this.config.maxBundleSize
        } = options;

        const bundleIds = [];
        
        // 获取最新区块哈希
        const { blockhash } = await this.connection.getLatestBlockhash();

        // 将交易分成批次处理
        for (let i = 0; i < transactions.length; i += maxBundleSize) {
            const batch = transactions.slice(i, i + maxBundleSize);
            
            // 为每个交易添加小费并更新区块哈希
            const txsWithTip = await Promise.all(batch.map(async tx => {
                tx.recentBlockhash = blockhash;
                return this.addTipToTransaction(tx, { tipAmount });
            }));

            const bundleId = await this.sendBundle(txsWithTip);
            bundleIds.push(bundleId);
            
            logger.info(`已处理 ${i + batch.length}/${transactions.length} 笔交易`);
        }

        return bundleIds;
    }

    /**
     * 发送单个 bundle
     */
    async sendBundle(transactions) {
        // 验证 bundle 大小
        if (transactions.length > 5) {
            throw new Error('Bundle 不能超过5笔交易');
        }

        // 验证是否包含 tip 交易
        const hasTip = await this.validateTipInBundle(transactions);
        if (!hasTip) {
            throw new Error('Bundle 必须包含 tip 交易');
        }
        // 验证所有交易都有必要的签名
        this.verifyTransactionSignatures(transactions);


        for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
            try {
                // 序列化交易，使用 base64 编码（更快）
                const serializedTxs = transactions.map(tx => {
                    try {
                        return tx.serialize().toString('base64');
                    } catch (error) {
                        logger.error('交易序列化失败:', {
                            error: error.message,
                            feePayer: tx.feePayer?.toBase58(),
                            signaturesCount: tx.signatures.length,
                            signatures: tx.signatures.map(s => ({
                                pubkey: s.publicKey.toBase58(),
                                hasSignature: s.signature !== null
                            }))
                        });
                        throw error;
                    }
                });

                // 构建请求头
                const headers = {
                    'Content-Type': 'application/json'
                };
                // 发送到 Jito
                const response = await axios.post(`${this.bestEndpoint}/bundles`, {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "sendBundle",
                    params: [
                        serializedTxs,
                        {
                            encoding: "base64"
                        }
                    ]
                }, { headers });

                // 验证响应
                if (!response?.data?.result) {
                    throw new Error('Invalid response from Jito service');
                }

                const bundleId = response.data.result;
                logger.info(`Bundle 发送成功, ID: ${bundleId}`);
                return bundleId;

            } catch (error) {
                logger.warn(`发送 bundle 失败，尝试 ${attempt}/${this.config.retryAttempts}`, error);

                if (attempt === this.config.retryAttempts) {
                    throw new Error(`Bundle 发送失败: ${error.message}`);
                }

                // 指数退避重试
                await new Promise(resolve =>
                    setTimeout(resolve, this.config.retryDelayMs * Math.pow(2, attempt - 1))
                );
            }
        }
    }
    async validateTipInBundle(transactions) {
        try {
            // 获取当前可用的 tip 账户
            const tipAccounts = await this.getTipAccounts();
            const tipAccountSet = new Set(tipAccounts);

            // 遍历所有交易的指令，查找转账到 tip 账户的指令
            for (const tx of transactions) {
                for (const instruction of tx.instructions) {
                    // 检查是否是系统转账指令
                    if (instruction.programId.equals(SystemProgram.programId)) {
                        const { keys } = instruction;
                        // 检查接收方是否是 tip 账户
                        if (keys.length >= 2 && tipAccountSet.has(keys[1].pubkey.toBase58())) {
                            // 检查转账金额是否大于最小值
                            const data = instruction.data;
                            const amount = data.readBigUInt64LE(0);
                            if (amount >= BigInt(this.config.tipAmount)) {
                                return true;
                            }
                        }
                    }
                }
            }
            return false;
        } catch (error) {
            logger.error('验证 tip 失败:', error);
            throw error;
        }
    }
    /**
     * 监控 bundle 状态
     * @param {string} bundleId
     * @param {number} timeoutMs 可选的超时时间（毫秒）
     */
    async monitorBundle(bundleId, timeoutMs = 30000) {
        const startTime = Date.now();

        for (let attempt = 0; attempt < this.config.retryAttempts; attempt++) {
            try {
                // 使用 getInflightBundleStatuses API
                const response = await axios.post(`${this.bestEndpoint}/bundles`, {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "getInflightBundleStatuses",
                    params: [[bundleId]]
                });

                const value = response?.data?.result?.value?.[0];
                if (!value) {
                    logger.warn(`Bundle ${bundleId} 状态未找到`);
                    continue;
                }

                const status = value.status;
                const landedSlot = value.landed_slot;

                switch (status) {
                    case 'Landed':
                        logger.info(`Bundle ${bundleId} 已确认在区块 ${landedSlot} 上`);
                        // 进一步获取最终状态
                        const finalStatus = await this.getBundleStatus(bundleId);
                        return finalStatus;

                    case 'Pending':
                        if (Date.now() - startTime > timeoutMs) {
                            throw new Error('Bundle 处理超时');
                        }
                        await new Promise(resolve => setTimeout(resolve, this.config.retryDelayMs));
                        continue;

                    case 'Failed':
                        throw new Error('Bundle 处理失败');

                    case 'Invalid':
                        throw new Error('Bundle 已失效或超过5分钟');

                    default:
                        throw new Error(`未预期的状态: ${status}`);
                }
            } catch (error) {
                if (Date.now() - startTime > timeoutMs) {
                    throw new Error(`Bundle 监控超时: ${error.message}`);
                }
                logger.warn(`监控 bundle ${bundleId} 失败，尝试 ${attempt + 1}/${this.config.retryAttempts}`, error);
                await new Promise(resolve => setTimeout(resolve, this.config.retryDelayMs));
            }
        }

        throw new Error('Bundle 监控重试次数已达上限');
    }

    /**
     * 快速监控 bundle 状态
     * @param {string} bundleId
     */
    async monitorBundleFast(bundleId) {
        const startTime = Date.now();
        const maxAttempts = this.config.retryAttempts * 10;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                // 使用 getBundleStatuses API 直接查询最终状态
                const response = await axios.post(`${this.bestEndpoint}/bundles`, {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "getBundleStatuses",
                    params: [[bundleId]]
                });

                const value = response?.data?.result?.value?.[0];
                if (!value) {
                    // Bundle 可能还未处理完成，继续轮询
                    if (attempt >= maxAttempts - 1) {
                        throw new Error('Bundle 状态查询超时');
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                    continue;
                }

                const { confirmation_status, slot, err } = value;

                // 检查错误
                if (err && err.err) {
                    throw new Error(`Bundle 处理失败: ${JSON.stringify(err)}`);
                }

                // 检查确认状态
                if (confirmation_status === 'finalized' || confirmation_status === 'confirmed') {
                    logger.info(`Bundle ${bundleId} 已确认，状态: ${confirmation_status}, 区块: ${slot}`);
                    return value;
                }

                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                logger.error(`快速监控 bundle ${bundleId} 失败`, error);
                throw error;
            }
        }

        throw new Error('Bundle 快速监控超时');
    }

    /**
     * 获取 bundle 最终状态
     * @param {string} bundleId
     */
    async getBundleStatus(bundleId) {
        const response = await axios.post(`${this.bestEndpoint}/bundles`, {
            jsonrpc: "2.0",
            id: 1,
            method: "getBundleStatuses",
            params: [[bundleId]]
        });

        return response?.data?.result?.value?.[0];
    }
}