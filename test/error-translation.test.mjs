import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayErrorStatus, translateGatewayError } from '../src/error-translation.mjs';

test('context overflow keeps the full requested token count before a component breakdown', () => {
  const bodyText = JSON.stringify({error: {message: "This model's maximum context length is 262144 tokens. However, you requested about 282974 tokens (132890 of text input, 150084 of tool input)."}});
  assert.equal(gatewayErrorStatus({status: 500, bodyText}), 400);
  const result = translateGatewayError({status: 500, bodyText, modelName: 'test', providerName: 'test'});
  assert.equal(result.error.code, 'context_length_exceeded');
  assert.match(result.error.message, /282,974 tokens/);
  assert.match(result.error.message, /262,144-token context/);
});
