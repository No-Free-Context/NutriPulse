import { ResourceDecorator as Resource, ExecutionContext } from '@nitrostack/core';

/**
 * context Resources
 * 
 * TODO: Add description
 */
export class contextResources {
  @Resource({
    uri: 'context://example',
    name: 'Example Resource',
    description: 'TODO: Add description',
    mimeType: 'application/json',
  })
  async exampleResource(context: ExecutionContext) {
    // TODO: Implement resource logic
    return {
      type: 'text' as const,
      text: JSON.stringify({ example: 'data' }, null, 2),
    };
  }
}
