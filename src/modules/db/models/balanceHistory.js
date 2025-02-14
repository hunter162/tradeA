import { DataTypes } from 'sequelize';
import { sequelize } from '../connection.js';

export const BalanceHistory = sequelize.define('balance_history', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    groupType: {
        type: DataTypes.STRING,
        allowNull: false,
        field: 'group_type',
        references: {
            model: 'groups',
            key: 'group_type'
        }
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
    previousBalance: {
        type: DataTypes.DECIMAL(20, 9),  // SOL 有 9 位小数
        allowNull: false,
        field: 'previous_balance'
    },
    currentBalance: {
        type: DataTypes.DECIMAL(20, 9),
        allowNull: false,
        field: 'current_balance'
    },
    changeAmount: {
        type: DataTypes.DECIMAL(20, 9),
        allowNull: false,
        field: 'change_amount'
    },
    transactionType: {
        type: DataTypes.ENUM('transfer_in', 'transfer_out', 'airdrop', 'other'),
        allowNull: false,
        field: 'transaction_type'
    },
    transactionHash: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'transaction_hash'
    },
    metadata: {
        type: DataTypes.JSON,
        defaultValue: {}
    }
}, {
    tableName: 'balance_history',
    timestamps: true,
    underscored: true,
    indexes: [
        {
            fields: ['group_type', 'account_number'],
            name: 'balance_history_wallet_index'
        },
        {
            fields: ['public_key'],
            name: 'balance_history_pubkey_index'
        },
        {
            fields: ['transaction_hash'],
            name: 'balance_history_tx_index'
        }
    ]
}); 