import defineTokenModel from './token.js';
import defineTransactionModel from './transaction.js';
import defineGroupModel from './group.js';
import defineWalletModel from './wallet.js';
import defineTradeStrategyModel from './tradeStrategy.js';
import defineTradeExecutionModel from './tradeExecution.js';

export {
    defineTokenModel,
    defineTransactionModel,
    defineGroupModel,
    defineWalletModel,
    defineTradeStrategyModel,
    defineTradeExecutionModel
};

const initializeModels = (sequelize) => {
    const models = {
        Token: defineTokenModel(sequelize),
        Transaction: defineTransactionModel(sequelize),
        Group: defineGroupModel(sequelize),
        Wallet: defineWalletModel(sequelize),
        TradeStrategy: defineTradeStrategyModel(sequelize),
        TradeExecution: defineTradeExecutionModel(sequelize)
    };

    Object.values(models).forEach(model => {
        if (model.associate) {
            model.associate(models);
        }
    });

    models.TradeStrategy.hasMany(models.TradeExecution, {
        foreignKey: 'strategyId',
        as: 'executions'
    });

    models.TradeExecution.belongsTo(models.TradeStrategy, {
        foreignKey: 'strategyId',
        as: 'strategy'
    });

    return models;
};

export default initializeModels; 