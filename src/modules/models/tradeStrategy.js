import { DataTypes } from 'sequelize';

export default (sequelize) => {
    const TradeStrategy = sequelize.define('TradeStrategy', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        name: {
            type: DataTypes.STRING,
            allowNull: false
        },
        batchId: {
            type: DataTypes.STRING,
            allowNull: false,
            comment: '批次号'
        },
        type: {
            type: DataTypes.ENUM('single', 'combo'),
            allowNull: false,
            comment: '策略类型:single(单一交易),combo(组合交易)'
        },
        tokenAddress: {
            type: DataTypes.STRING,
            allowNull: false
        },
        groupType: {
            type: DataTypes.STRING,
            allowNull: false
        },
        accountRange: {
            type: DataTypes.STRING,
            allowNull: false,
            comment: '参与账号范围,如 1-5'
        },
        buyConfig: {
            type: DataTypes.JSON,
            allowNull: true,
            comment: '买入配置'
        },
        sellConfig: {
            type: DataTypes.JSON, 
            allowNull: true,
            comment: '卖出配置'
        },
        totalRounds: {
            type: DataTypes.INTEGER,
            allowNull: false,
            comment: '总轮次'
        },
        currentRound: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            comment: '当前轮次'
        },
        interval: {
            type: DataTypes.INTEGER,
            allowNull: false,
            comment: '轮次间隔(秒)'
        },
        status: {
            type: DataTypes.ENUM('pending', 'running', 'paused', 'completed', 'failed'),
            defaultValue: 'pending'
        },
        startTime: {
            type: DataTypes.DATE,
            allowNull: true
        },
        endTime: {
            type: DataTypes.DATE,
            allowNull: true
        }
    });

    return TradeStrategy;
}; 