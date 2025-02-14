export const ENCRYPTION_CONFIG = {
    masterKey: process.env.MASTER_KEY || 'your-default-master-key-here',
    algorithm: 'aes-256-gcm',
    iterations: 10000,
    keyLength: 32,
    digest: 'sha256'
}; 