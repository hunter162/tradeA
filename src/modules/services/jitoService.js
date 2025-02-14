import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { logger } from '../utils.js';
import axios from 'axios';

// Jito 小费账户列表
const TIP_ADDRESS_LIST = [
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", // 0纽约 quick
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe", // 1纽约 机群
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY", // 2东京 
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49", // 3洛杉矶 
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", // 4达拉斯 
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt", // 5阿姆斯特丹
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL", // 6法兰克福
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"  // 7伦敦, 华沙
];

// Nozomi 配置
export const NOZOMI_CONFIG = {
    TIP_ADDRESS: new PublicKey("TEMPaMeCRFAS9EKF53Jd6KpHxgL47uWLcpFArU1Fanq"),
    MIN_TIP_AMOUNT: 1000000, // 0.001 SOL
    URL: "https://pit1.secure.nozomi.temporal.xyz",
    UUID: "ff1f753e-b436-4088-a9bc-b0948ffb927d"
};

export class JitoService {
    constructor(connection) {
        this.connection = connection;
        logger.info('初始化优先上链服务');
    }

    async addPriorityFee(transaction, options = { type: 'jito', tipAmountSol: 0.001 }) {
        try {
            const { type, tipAmountSol } = options;

            logger.info('🚀 开始优先上链流程', {
                type: type.toUpperCase(),
                tipAmount: `${tipAmountSol} SOL`,
                channel: type === 'nozomi' ? 'Nozomi 通道' : 'Jito 通道'
            });

            // 转换 SOL 到 lamports
            const tipAmount = Math.floor(tipAmountSol * LAMPORTS_PER_SOL);

            // 获取小费账户
            const tipPubkey = type === 'nozomi' 
                ? NOZOMI_CONFIG.TIP_ADDRESS 
                : new PublicKey(TIP_ADDRESS_LIST[Math.floor(Math.random() * TIP_ADDRESS_LIST.length)]);
            
            // 创建小费指令
            const tipInstruction = SystemProgram.transfer({
                fromPubkey: transaction.feePayer,
                toPubkey: tipPubkey,
                lamports: tipAmount
            });

            // 获取所有需要签名的公钥
            const signers = new Set();
            transaction.instructions.forEach(ix => {
                ix.keys.forEach(key => {
                    if (key.isSigner) {
                        signers.add(key.pubkey.toBase58());
                    }
                });
            });

            // 创建新交易
            const newTransaction = new Transaction();
            
            // 设置交易属性
            newTransaction.feePayer = transaction.feePayer;
            newTransaction.recentBlockhash = transaction.recentBlockhash;

            // 添加指令
            newTransaction.add(tipInstruction);
            transaction.instructions.forEach(ix => newTransaction.add(ix));

            // 添加所有需要的签名者
            signers.forEach(signerKey => {
                newTransaction.addSignature(new PublicKey(signerKey), Buffer.alloc(64));
            });

            logger.info('✅ 优先上链交易准备完成', {
                type: type.toUpperCase(),
                tipAccount: tipPubkey.toBase58(),
                tipAmount: `${tipAmountSol} SOL`,
                signers: Array.from(signers),
                instructions: newTransaction.instructions.length
            });

            return newTransaction;
        } catch (error) {
            logger.error('❌ 优先上链失败', {
                error: error.message,
                type: options.type.toUpperCase(),
                stack: error.stack
            });
            throw error;
        }
    }
} 