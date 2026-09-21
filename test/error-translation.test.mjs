import assert from 'node:assert/strict';
import test from 'node:test';
import {
  gatewayErrorStatus,
  translateGatewayError,
} from '../src/error-translation.mjs';

test('context overflow keeps the full requested token count before a component breakdown', () => {
  const bodyText = JSON.stringify({error: {message: "This model's maximum context length is 262144 tokens. However, you requested about 282974 tokens (132890 of text input, 150084 of tool input)."}});
  assert.equal(gatewayErrorStatus({status: 500, bodyText}), 400);
  const result = translateGatewayError({status: 500, bodyText, modelName: 'test', providerName: 'test'});
  assert.equal(result.error.code, 'context_length_exceeded');
  assert.match(result.error.message, /282,974 tokens/);
  assert.match(result.error.message, /262,144-token context/);
});

test('authenticated forwarder validation keeps only recognized safe local errors', () => {
  const localBody = JSON.stringify({ error: {
    type: 'invalid_request_error',
    code: 'request_body_too_large',
    message: 'provider-controlled detail must not survive',
  } });
  assert.equal(gatewayErrorStatus({ status: 413, bodyText: localBody, localForwarderError: true }), 413);
  assert.deepEqual(
    translateGatewayError({
      status: 413,
      bodyText: localBody,
      localForwarderError: true,
      modelName: 'test',
      providerName: 'test',
    }),
    { error: {
      type: 'invalid_request_error',
      code: 'request_body_too_large',
      message: 'Request body is too large.',
    } },
  );

  const provider = translateGatewayError({
    status: 413,
    bodyText: localBody,
    localForwarderError: false,
    modelName: 'test',
    providerName: 'test',
  });
  assert.equal(provider.error.code, '413');
  assert.match(provider.error.message, /provider-controlled detail/);

  const unknown = translateGatewayError({
    status: 400,
    bodyText: JSON.stringify({ error: { code: 'provider_owned', message: 'provider detail' } }),
    localForwarderError: true,
    modelName: 'test',
    providerName: 'test',
  });
  assert.equal(unknown.error.code, '400');
  assert.match(unknown.error.message, /provider detail/);
});
