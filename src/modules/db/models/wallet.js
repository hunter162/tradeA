import { DataTypes } from 'sequelize';

export default (sequelize) => {
    const Wallet = sequelize.define('Wallet', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        groupType: {
            type: DataTypes.STRING,
            allowNull: false,
            field: 'group_type'
        },
        accountNumber: {
            type: DataTypes.INTEGER,
            allowNull: false,
            field: 'account_number'
        },
        publicKey: {
            type: DataTypes.STRING,
            allowNull: false,
            field: 'public_key'
        },
        encryptedPrivateKey: {
            type: DataTypes.TEXT,
            allowNull: false,
            field: 'encrypted_private_key'
        },
        iv: {
            type: DataTypes.STRING,
            allowNull: false
        },
        salt: {
            type: DataTypes.STRING,
            allowNull: false
        },
        authTag: {
            type: DataTypes.STRING,
            allowNull: false,
            field: 'auth_tag'
        },
        status: {
            type: DataTypes.STRING,
            allowNull: false,
            defaultValue: 'active'
        },
        metadata: {
            type: DataTypes.JSON,
            allowNull: true
        }
    }, {
        tableName: 'wallets',
        timestamps: true,
        underscored: true
    });

    Wallet.associate = (models) => {
        // 移除所有关联
    };

    return Wallet;
}; 