import util from 'util';
import bs58 from 'bs58';
import fs from 'fs/promises';
import path from 'path';
import { Keypair } from '@solana/web3.js';

// 增强的日志系统
export const logger = {
    info: (message, ...args) => {
        const timestamp = new Date().toISOString();
        if (args.length > 0) {
            console.log(`[${timestamp}] [INFO]: ${message}`, 
                args.map(arg => util.inspect(arg, { depth: null, colors: true })).join(' '));
        } else {
            console.log(`[${timestamp}] [INFO]: ${message}`);
        }
    },
    
    error: (message, error = null) => {
        const timestamp = new Date().toISOString();
        console.error(`[${timestamp}] [ERROR]: ${message}`);
        if (error) {
            if (error instanceof Error) {
                console.error(`[${timestamp}] [ERROR_DETAILS]: {
                    message: ${error.message},
                    stack: ${error.stack},
                    name: ${error.name}
                }`);
            } else {
                console.error(`[${timestamp}] [ERROR_DETAILS]:`, 
                    util.inspect(error, { depth: null, colors: true }));
            }
        }
    },
    
    warn: (message, ...args) => {
        const timestamp = new Date().toISOString();
        if (args.length > 0) {
            console.warn(`[${timestamp}] [WARN]: ${message}`, 
                args.map(arg => util.inspect(arg, { depth: null, colors: true })).join(' '));
        } else {
            console.warn(`[${timestamp}] [WARN]: ${message}`);
        }
    },
    
    debug: (message, ...args) => {
        const timestamp = new Date().toISOString();
        if (args.length > 0) {
            console.debug(`[${timestamp}] [DEBUG]: ${message}`, 
                args.map(arg => util.inspect(arg, { depth: null, colors: true })).join(' '));
        } else {
            console.debug(`[${timestamp}] [DEBUG]: ${message}`);
        }
    }
};

export const helpers = {
    formatDate: (date) => {
        return new Date(date).toLocaleDateString();
    },
    generateId: () => {
        return Math.random().toString(36).substr(2, 9);
    },
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    saveKeypair: (keypair, label) => {
        const keypairData = {
            publicKey: keypair.publicKey.toBase58(),
            secretKey: Array.from(keypair.secretKey),
            secretKeyBase58: bs58.encode(keypair.secretKey),
            secretKeyBase64: Buffer.from(keypair.secretKey).toString('base64'),
            label,
            timestamp: new Date().toISOString()
        };
        logger.info(`保存密钥对 ${label}`, {
            publicKey: keypairData.publicKey,
            secretKeyBase64: keypairData.secretKeyBase64,
            timestamp: keypairData.timestamp
        });
        return keypairData;
    },
    async getImageData(imagePath) {
        try {
            const imageBuffer = await fs.readFile(imagePath);
            const base64Image = imageBuffer.toString('base64');
            const mimeType = path.extname(imagePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
            return `data:${mimeType};base64,${base64Image}`;
        } catch (error) {
            logger.error('读取图片失败', error);
            // 返回一个 1x1 的透明像素作为默认图片
            return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        }
    },
    async saveWalletToFile(keypair, filename) {
        try {
            const walletData = {
                publicKey: keypair.publicKey.toBase58(),
                secretKey: Array.from(keypair.secretKey),
                secretKeyBase58: bs58.encode(keypair.secretKey),
                secretKeyBase64: Buffer.from(keypair.secretKey).toString('base64'),
                timestamp: new Date().toISOString()
            };

            const walletDir = path.join(process.cwd(), 'wallets');
            await fs.mkdir(walletDir, { recursive: true });
            await fs.writeFile(
                path.join(walletDir, `${filename}.json`),
                JSON.stringify(walletData, null, 2)
            );

            logger.info(`钱包信息已保存到文件: ${filename}.json`);
            return walletData;
        } catch (error) {
            logger.error('保存钱包信息失败', error);
            throw error;
        }
    },
    async loadWalletFromFile(filename) {
        try {
            const walletPath = path.join(process.cwd(), 'wallets', `${filename}.json`);
            const walletData = JSON.parse(await fs.readFile(walletPath, 'utf8'));
            return Keypair.fromSecretKey(new Uint8Array(walletData.secretKey));
        } catch (error) {
            logger.error('读取钱包信息失败', error);
            return null;
        }
    }
}; 