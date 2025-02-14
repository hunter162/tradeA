import { DataTypes } from 'sequelize';

export default (sequelize) => {
    const TradeExecution = sequelize.define('TradeExecution', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        strategyId: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        batchId: {
            type: DataTypes.STRING,
            allowNull: false
        },
        round: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        type: {
            type: DataTypes.ENUM('buy', 'sell'),
            allowNull: false
        },
        accountNumber: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        signature: {
            type: DataTypes.STRING,
            allowNull: true
        },
        amount: {
            type: DataTypes.STRING,
            allowNull: false
        },
        status: {
            type: DataTypes.ENUM('pending', 'success', 'failed'),
            defaultValue: 'pending'
        },
        error: {
            type: DataTypes.TEXT,
            allowNull: true
        }
    });

    return TradeExecution;
}; 