import crypto from 'crypto';
import { logger } from './logger.js';

export class EncryptionManager {
    constructor(masterKey) {
        if (!masterKey) {
            throw new Error('Master key is required for encryption');
        }
        this.masterKey = masterKey;
        this.algorithm = 'aes-256-gcm';
        this.iterations = 10000;
        this.keyLength = 32;
        this.digest = 'sha256';
    }

    async encrypt(data) {
        const salt = crypto.randomBytes(16);
        const iv = crypto.randomBytes(12);
        
        const key = crypto.pbkdf2Sync(this.masterKey, salt, 100000, 32, 'sha256');
        
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const encryptedData = Buffer.concat([
            cipher.update(data, 'utf8'),
            cipher.final()
        ]);
        
        const authTag = cipher.getAuthTag();

        return {
            encryptedData: encryptedData.toString('base64'),
            iv: iv.toString('base64'),
            salt: salt.toString('base64'),
            authTag: authTag.toString('base64')
        };
    }

    async decrypt(encryptedData, iv, salt, authTag) {
        const key = crypto.pbkdf2Sync(
            this.masterKey,
            Buffer.from(salt, 'base64'),
            100000,
            32,
            'sha256'
        );

        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            key,
            Buffer.from(iv, 'base64')
        );

        decipher.setAuthTag(Buffer.from(authTag, 'base64'));

        const decrypted = Buffer.concat([
            decipher.update(Buffer.from(encryptedData, 'base64')),
            decipher.final()
        ]);

        return decrypted.toString('utf8');
    }

    // 生成新的加密密钥
    generateNewKey() {
        return crypto.randomBytes(32).toString('base64');
    }

    // 验证加密数据的完整性
    async verifyEncryption(encryptedData, ivString, originalData) {
        try {
            const decrypted = await this.decrypt(encryptedData, ivString, '', '');
            return decrypted === originalData;
        } catch {
            return false;
        }
    }
} 