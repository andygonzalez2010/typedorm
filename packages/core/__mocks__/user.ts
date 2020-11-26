import {INDEX_TYPE} from '@typedorm/common';
import {Attribute} from '../../common/decorators/attribute.decorator';
import {Entity} from '../../common/decorators/entity.decorator';
import {table} from './table';

export interface UserPrimaryKey {
  id: string;
}

export interface UserGSI1 {
  status: string;
  name?: string;
}

@Entity({
  table,
  name: 'user',
  primaryKey: {
    partitionKey: 'USER#{{id}}',
    sortKey: 'USER#{{id}}',
  },
  indexes: {
    GSI1: {
      partitionKey: 'USER#STATUS#{{status}}',
      sortKey: 'USER#{{name}}',
      type: INDEX_TYPE.GSI,
    },
  },
})
export class User implements UserPrimaryKey, UserGSI1 {
  @Attribute()
  id: string;

  @Attribute()
  name: string;

  @Attribute()
  status: string;

  @Attribute()
  age: number;
}
