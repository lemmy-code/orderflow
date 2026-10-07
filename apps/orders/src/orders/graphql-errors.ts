import { GraphQLError } from 'graphql';
import { InvalidInputError, OrderNotFoundError } from './errors';
import { InvalidStateError } from './order-state';

/** Maps domain errors to stable GraphQL error codes; anything else stays an internal error. */
export async function withGraphQLErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof InvalidInputError) throw new GraphQLError(e.message, { extensions: { code: 'BAD_USER_INPUT' } });
    if (e instanceof OrderNotFoundError) throw new GraphQLError(e.message, { extensions: { code: 'NOT_FOUND' } });
    if (e instanceof InvalidStateError) throw new GraphQLError(e.message, { extensions: { code: 'INVALID_STATE' } });
    throw e;
  }
}
