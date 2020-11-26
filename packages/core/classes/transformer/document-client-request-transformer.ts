import {DocumentClient} from 'aws-sdk/clients/dynamodb';
import {
  EntityTarget,
  FindKeyListOperator,
  FindKeyScalarOperator,
  FindKeySimpleOperator,
  INDEX_TYPE,
  PrimaryKeyAttributes,
  QUERY_ORDER,
  RequireOnlyOne,
  RETURN_VALUES,
  ScalarType,
  UpdateAttributes,
} from '@typedorm/common';
import {getUniqueAttributePrimaryKey} from '../../helpers/get-unique-attr-primary-key';
import {isEmptyObject} from '../../helpers/is-empty-object';
import {parseKey} from '../../helpers/parse-key';
import {Condition} from '../condition/condition';
import {KeyCondition} from '../condition/key-condition';
import {Connection} from '../connection/connection';
import {ExpressionBuilder} from '../expression-builder';
import {EntityManagerUpdateOptions} from '../manager/entity-manager';
import {AttributeMetadata} from '../metadata/attribute-metadata';
import {AutoGeneratedAttributeMetadata} from '../metadata/auto-generated-attribute-metadata';
import {IndexOptions} from '../../../common/table';
import {BaseTransformer} from './base-transformer';

export interface ManagerToDynamoQueryItemsOptions {
  /**
   * Sort key condition
   * @default none - no sort key condition is applied
   */
  keyCondition?: RequireOnlyOne<
    {
      [key in FindKeyScalarOperator]: ScalarType;
    } &
      {
        [key in FindKeyListOperator]: [ScalarType, ScalarType];
      }
  >;

  /**
   * Max number of records to query
   * @default - implicit dynamo db query limit is applied
   */
  limit?: number;

  /**
   * Order to query items in
   * @default ASC
   */
  orderBy?: QUERY_ORDER;
}

export interface ManagerToDynamoPutItemOptions {
  /**
   * @default false
   */
  overwriteIfExists: boolean;
}

export class DocumentClientRequestTransformer extends BaseTransformer {
  private _expressionBuilder: ExpressionBuilder;

  constructor(connection: Connection) {
    super(connection);
    this._expressionBuilder = new ExpressionBuilder();
  }

  toDynamoGetItem<PrimaryKey, Entity>(
    entityClass: EntityTarget<Entity>,
    primaryKey: PrimaryKey
  ): DocumentClient.GetItemInput {
    const metadata = this.connection.getEntityByTarget(entityClass);

    const tableName = this.getTableNameForEntity(entityClass);

    const parsedPrimaryKey = this.getParsedPrimaryKey(
      metadata.table,
      metadata.schema.primaryKey,
      primaryKey
    );

    if (isEmptyObject(parsedPrimaryKey)) {
      throw new Error('Primary could not be resolved');
    }

    return {
      TableName: tableName,
      Key: {
        ...parsedPrimaryKey,
      },
    };
  }

  toDynamoPutItem<Entity>(
    entity: Entity,
    options?: ManagerToDynamoPutItemOptions
  ): DocumentClient.PutItemInput | DocumentClient.PutItemInput[] {
    const {table, name} = this.connection.getEntityByTarget(entity.constructor);

    const uniqueAttributes = this.connection.getUniqueAttributesForEntity(
      entity.constructor
    ) as AttributeMetadata[];

    const dynamoEntity = this.toDynamoEntity(entity);
    let uniqueAttributePutItems = [] as DocumentClient.PutItemInput[];
    // apply attribute not exist condition when creating unique
    const uniqueRecordConditionExpression = this._expressionBuilder.buildConditionExpression(
      new Condition().attributeNotExist(table.partitionKey)
    );

    if (uniqueAttributes.length) {
      uniqueAttributePutItems = uniqueAttributes.map(attr => {
        const attributeValue =
          (attr as AutoGeneratedAttributeMetadata)?.value ??
          (entity as any)[attr.name];

        if (!attributeValue) {
          throw new Error(
            `All unique attributes are required, Could not resolve value for unique attribute "${attr.name}."`
          );
        }

        const uniqueItemPrimaryKey = getUniqueAttributePrimaryKey(
          table,
          name,
          attr.name,
          attributeValue
        );

        return {
          Item: uniqueItemPrimaryKey,
          TableName: table.name,
          ...uniqueRecordConditionExpression,
        } as DocumentClient.PutItemInput;
      });
    }

    let dynamoPutItem = {
      Item: {
        ...dynamoEntity,
      },
      TableName: table.name,
    } as DocumentClient.PutItemInput;

    // always prevent overwriting data until explicitly told to do otherwise
    if (!options?.overwriteIfExists) {
      dynamoPutItem = {...dynamoPutItem, ...uniqueRecordConditionExpression};
    }

    if (uniqueAttributePutItems.length) {
      return [dynamoPutItem, ...uniqueAttributePutItems];
    }
    return dynamoPutItem;
  }

  toDynamoUpdateItem<PrimaryKey, Entity>(
    entityClass: EntityTarget<Entity>,
    primaryKey: PrimaryKeyAttributes<PrimaryKey, any>,
    body: UpdateAttributes<PrimaryKey, Entity>,
    options?: EntityManagerUpdateOptions
  ): DocumentClient.UpdateItemInput {
    // default values
    const {nestedKeySeparator = '.', returnValues = RETURN_VALUES.ALL_NEW} =
      options ?? {};

    if (!this.connection.hasMetadata(entityClass)) {
      throw new Error(`No metadata found for class "${entityClass.name}".`);
    }

    const metadata = this.connection.getEntityByTarget(entityClass);

    const tableName = metadata.table.name;

    const parsedPrimaryKey = this.getParsedPrimaryKey(
      metadata.table,
      metadata.schema.primaryKey,
      primaryKey
    );

    if (isEmptyObject(parsedPrimaryKey)) {
      throw new Error('Primary could not be resolved');
    }

    // TODO: add support for updating unique attributes
    this.connection.getUniqueAttributesForEntity(entityClass).forEach(attr => {
      // key that is marked as unique, can not be updated
      if (body[attr.name]) {
        throw new Error(``);
      }
    });

    // get all the attributes for entity that are marked as to be auto update
    const autoUpdateAttributes = this.connection.getAutoUpdateAttributes(
      entityClass
    );

    // check if auto update attributes are not referenced by primary key
    const formattedAutoUpdateAttributes = autoUpdateAttributes.reduce(
      (acc, attr) => {
        if ((primaryKey as any)[attr.name]) {
          throw new Error(
            `Failed to build update expression, key "${attr.name}" is marked as to up auto updated but is also referenced by primary key`
          );
        }
        acc[attr.name] = attr.autoGenerateValue(attr.strategy);
        return acc;
      },
      {} as {[key: string]: any}
    );

    const attributesToUpdate = {...body, ...formattedAutoUpdateAttributes};

    // get all affected indexes for attributes
    const affectedIndexes = this.getAffectedIndexesForAttributes<
      PrimaryKey,
      Entity
    >(entityClass, attributesToUpdate, {
      nestedKeySeparator,
    });

    const {
      UpdateExpression,
      ExpressionAttributeNames,
      ExpressionAttributeValues,
    } = this._expressionBuilder.buildUpdateExpression({
      ...attributesToUpdate,
      ...affectedIndexes,
    });

    return {
      TableName: tableName,
      Key: {
        ...parsedPrimaryKey,
      },
      UpdateExpression,
      ExpressionAttributeNames,
      ExpressionAttributeValues,
      ReturnValues: returnValues,
    };
  }

  toDynamoDeleteItem<PrimaryKey, Entity>(
    entityClass: EntityTarget<Entity>,
    primaryKey: PrimaryKey
  ): DocumentClient.DeleteItemInput {
    const metadata = this.connection.getEntityByTarget(entityClass);

    const tableName = metadata.table.name;

    const parsedPrimaryKey = this.getParsedPrimaryKey(
      metadata.table,
      metadata.schema.primaryKey,
      primaryKey
    );

    if (isEmptyObject(parsedPrimaryKey)) {
      throw new Error('Primary could not be resolved');
    }

    return {
      TableName: tableName,
      Key: {
        ...parsedPrimaryKey,
      },
    };
  }

  toDynamoQueryItem<PartitionKeyAttributes, Entity>(
    entityClass: EntityTarget<Entity>,
    partitionKeyAttributes: PartitionKeyAttributes & {
      queryIndex?: string;
    },
    queryOptions?: ManagerToDynamoQueryItemsOptions
  ): DocumentClient.QueryInput {
    const {table, schema} = this.connection.getEntityByTarget(entityClass);

    let indexToQuery: IndexOptions;
    if (partitionKeyAttributes.queryIndex) {
      const matchingIndex = table.getIndexByKey(
        partitionKeyAttributes.queryIndex
      );
      if (!matchingIndex) {
        throw new Error(
          `Requested to query items from index "${partitionKeyAttributes.queryIndex}", but no such index exists on table "${table.name}".`
        );
      }

      const matchingIndexOnEntity =
        schema.indexes && schema.indexes[partitionKeyAttributes.queryIndex];

      if (!matchingIndexOnEntity) {
        throw new Error(
          `Requested to query items from index "${partitionKeyAttributes.queryIndex}", but no such index exists on entity.`
        );
      }
      indexToQuery = matchingIndex;
    }

    const parsedPartitionKey = {} as {name: string; value: any};
    // query will be executed against main table or
    // if querying local  index, then partition key will be same as main table
    if (!indexToQuery || indexToQuery?.type === INDEX_TYPE.LSI) {
      parsedPartitionKey.name = table.partitionKey;
      parsedPartitionKey.value = parseKey(
        schema.primaryKey[table.partitionKey],
        partitionKeyAttributes
      );
      // query is to be executed against global secondary index
    } else {
      parsedPartitionKey.name = indexToQuery.partitionKey;
      parsedPartitionKey.value = parseKey(
        schema.indexes[partitionKeyAttributes.queryIndex][
          indexToQuery.partitionKey
        ],
        partitionKeyAttributes
      );
    }
    const partitionKeyCondition = new KeyCondition().equals(
      parsedPartitionKey.name,
      parsedPartitionKey.value
    );

    if (!queryOptions || isEmptyObject(queryOptions)) {
      return {
        TableName: table.name,
        IndexName: partitionKeyAttributes.queryIndex,
        ...this._expressionBuilder.buildKeyConditionExpression(
          partitionKeyCondition
        ),
      };
    }

    // resolve sort key
    const parsedSortKey = {} as {name: string};
    if (!indexToQuery) {
      // if trying to query table that does not use composite key, it should not be allowed
      if (!table.usesCompositeKey()) {
        throw new Error(
          `Table ${table.name} does not use composite key, thus querying a sort key is not allowed`
        );
      }
      parsedSortKey.name = table.sortKey;
    } else {
      parsedSortKey.name = indexToQuery.sortKey;
    }

    // at this point we have resolved partition key and table to query
    const {keyCondition, limit, orderBy: order} = queryOptions;

    let queryInputParams = {
      TableName: table.name,
      IndexName: partitionKeyAttributes.queryIndex,
      Limit: limit,
      ScanIndexForward: !order || order === QUERY_ORDER.ASC,
    } as DocumentClient.QueryInput;

    if (keyCondition && !isEmptyObject(keyCondition)) {
      // build sort key condition
      const sortKeyCondition = new KeyCondition();
      if (keyCondition.BETWEEN && keyCondition.BETWEEN.length) {
        sortKeyCondition.between(parsedSortKey.name, keyCondition.BETWEEN);
      } else if (keyCondition.BEGINS_WITH) {
        sortKeyCondition.beginsWith(
          parsedSortKey.name,
          keyCondition.BEGINS_WITH
        );
      } else {
        const operator = Object.keys(keyCondition)[0] as FindKeySimpleOperator;
        sortKeyCondition.addBaseOperatorCondition(
          operator,
          parsedSortKey.name,
          keyCondition[operator]
        );
      }

      // if condition resolution was successful, we can merge both partition and sort key conditions now
      const keyConditionExpression = this._expressionBuilder.buildKeyConditionExpression(
        partitionKeyCondition.merge(sortKeyCondition)
      );

      queryInputParams = {
        ...queryInputParams,
        ...keyConditionExpression,
      };
    }

    return {
      ...queryInputParams,
    };
  }
}
