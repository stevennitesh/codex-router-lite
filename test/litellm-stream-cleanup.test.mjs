import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeLiteLlmConfig } from "../src/litellm-config.mjs";

const root = path.resolve(import.meta.dirname, "..");
const localPython = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const python = process.env.MODEL_ROUTER_TEST_LITELLM_PYTHON || (existsSync(localPython) ? localPython : undefined);

test("rendered gateway config publishes its private cleanup callback first", () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-gateway-callback-"));
  try {
    const target = path.join(scratch, "litellm.yaml");
    writeLiteLlmConfig(target);
    assert.match(readFileSync(target, "utf8"), /callbacks: \[litellm_stream_cleanup_callback.stream_cleanup_callback\]/u);
    assert.equal(readFileSync(path.join(scratch, "litellm_stream_cleanup_callback.py"), "utf8"), readFileSync(path.join(root, "src/litellm_stream_cleanup_callback.py"), "utf8"));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("gateway cancellation closes real acquired SDK streams without another read or request", {
  skip: python ? false : "supply the hash-locked gateway interpreter with MODEL_ROUTER_TEST_LITELLM_PYTHON",
  timeout: 60000,
}, () => {
  const script = String.raw`
import asyncio, importlib.util, os, sys, unittest
os.environ['LITELLM_LOCAL_MODEL_COST_MAP'] = 'True'
os.environ['LITELLM_TELEMETRY'] = 'False'
import anyio, httpx
from openai import AsyncOpenAI, AsyncStream
from openai.types.chat import ChatCompletionChunk
from litellm import CustomStreamWrapper
from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy.common_request_processing import _UpstreamClosingStreamingResponse
from litellm.responses.litellm_completion_transformation.streaming_iterator import LiteLLMCompletionStreamingIterator as Iterator
spec = importlib.util.spec_from_file_location('router_cleanup', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class AcquiredBody(httpx.AsyncByteStream):
    def __init__(self):
        self.calls = 0
    async def __aiter__(self):
        raise AssertionError('cleanup must not acquire another provider read')
        yield b''
    async def aclose(self):
        self.calls += 1
        await anyio.sleep(0)

async def main():
    def forbidden(_request):
        raise AssertionError('cleanup must not request the provider')
    client = AsyncOpenAI(api_key='offline-fixture', http_client=httpx.AsyncClient(transport=httpx.MockTransport(forbidden)))
    try:
        for cancelled in [False, True]:
            body = AcquiredBody()
            response = httpx.Response(200, request=httpx.Request('POST', 'http://127.0.0.1/offline'), stream=body)
            sdk = AsyncStream(cast_to=ChatCompletionChunk, response=response, client=client)
            wrapper = CustomStreamWrapper.__new__(CustomStreamWrapper)
            wrapper.completion_stream = sdk
            iterator = Iterator.__new__(Iterator)
            iterator.litellm_custom_stream_wrapper = wrapper
            with anyio.CancelScope() as scope:
                if cancelled: scope.cancel()
                await iterator.aclose()
            await iterator.aclose()
            assert body.calls == 1
            assert response.is_closed
            assert wrapper.completion_stream is None
        # Exercise the real ASGI disconnect owner between provider reads.
        body = AcquiredBody()
        response = httpx.Response(200, request=httpx.Request('POST', 'http://127.0.0.1/offline'), stream=body)
        wrapper = CustomStreamWrapper.__new__(CustomStreamWrapper)
        wrapper.completion_stream = AsyncStream(cast_to=ChatCompletionChunk, response=response, client=client)
        iterator = Iterator.__new__(Iterator)
        iterator.litellm_custom_stream_wrapper = wrapper
        sent = asyncio.Event()
        async def chunks():
            yield 'data: {"type":"response.created"}\n\n'
            await asyncio.Event().wait()
        async def send(message):
            if message['type'] == 'http.response.body': sent.set()
        async def receive():
            await sent.wait()
            return {'type': 'http.disconnect'}
        streaming = _UpstreamClosingStreamingResponse(chunks(), media_type='text/event-stream', upstream_generator=iterator)
        await streaming({'type': 'http', 'asgi': {'spec_version': '2.0'}}, receive, send)
        assert body.calls == 1
        assert response.is_closed
        assert wrapper.completion_stream is None
        saved = Iterator.aclose
        async def native_close(self): return 'upstream-owned'
        try:
            Iterator.aclose = native_close
            assert module.install_stream_cleanup() is False
            assert Iterator.aclose is native_close
        finally:
            Iterator.aclose = saved
        assert module.install_stream_cleanup() is False
        assert type(module.stream_cleanup_callback) is CustomLogger
    finally:
        await client.close()
asyncio.run(main())
print('acquired SDK streams closed once; active cancellation shielded; upstream hook preserved; no provider requests')
`;
  const result = spawnSync(python, ["-I", "-B", "-c", script, path.join(root, "src/litellm_stream_cleanup_callback.py")], {
    encoding: "utf8", windowsHide: true, timeout: 45000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no provider requests/u);
});

test("private gateway schema hook preserves sync/async declarations and delegates foreign endpoints", {
  skip: python ? false : "supply the hash-locked gateway interpreter with MODEL_ROUTER_TEST_LITELLM_PYTHON",
  timeout: 60000,
}, () => {
  const script = String.raw`
import asyncio, copy, importlib.util, os, sys
os.environ['LITELLM_LOCAL_MODEL_COST_MAP'] = 'True'
os.environ['LITELLM_TELEMETRY'] = 'False'
trusted = 'http://127.0.0.1:32123/v1'
os.environ['CODEX_ROUTER_API_FORWARD_BASE_URL'] = trusted
from litellm.llms.openai.chat.gpt_transformation import OpenAIGPTConfig
original = OpenAIGPTConfig._sanitized_tools_update_for_openai
spec = importlib.util.spec_from_file_location('router_cleanup', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
config = OpenAIGPTConfig()
pattern = '^(?<word>[a-z]+)$'
schema = {'type': 'object', '$defs': {'word': {'type': 'string', 'pattern': pattern}},
    'properties': {'word': {'$ref': '#/$defs/word'}, 'plain': {'type': 'string', 'pattern': '^[a-z]+$'}},
    'patternProperties': {pattern: {'type': 'string', 'pattern': pattern}},
    'anyOf': [{'required': ['word']}, {'required': ['plain']}],
    'required': ['word'], 'additionalProperties': False}
tools = [{'type': 'function', 'function': {'name': 'match_word', 'strict': True, 'parameters': schema}}]
before = copy.deepcopy(tools)
params = {'custom_llm_provider': 'openai', 'api_base': trusted}

async def main():
    for asynchronous in [False, True]:
        kwargs = {'model': 'offline-fixture', 'messages': [{'role': 'user', 'content': 'synthetic'}],
            'optional_params': {'tools': copy.deepcopy(tools)}, 'litellm_params': params, 'headers': {}}
        result = await config.async_transform_request(**kwargs) if asynchronous else config.transform_request(**kwargs)
        assert result['tools'] == tools
        assert tools == before
    # Compare delegation against the captured actual pinned method, not a
    # reconstructed Python-regex approximation.
    for base in [None, '', trusted + '/', trusted + '/extra', trusted + '?spoof=1',
            'http://127.0.0.1:32124/v1', 'http://localhost:32123/v1',
            'http://127.0.0.1:32123@foreign.invalid/v1', 'https://api.openai.com/v1', 'http://foreign.invalid/v1']:
        foreign = {'custom_llm_provider': 'openai', 'api_base': base}
        expected = original(config, {'tools': copy.deepcopy(tools)}, foreign)
        actual = config._sanitized_tools_update_for_openai({'tools': copy.deepcopy(tools)}, foreign)
        assert actual == expected, base
        assert 'pattern' not in actual['tools'][0]['function']['parameters']['$defs']['word']
    for provider in ['anthropic', 'openrouter', None]:
        foreign = {'custom_llm_provider': provider, 'api_base': trusted}
        assert config._sanitized_tools_update_for_openai({'tools': tools}, foreign) == original(config, {'tools': tools}, foreign)
    installed = OpenAIGPTConfig._sanitized_tools_update_for_openai
    assert module.install_private_schema_preservation() is False
    assert OpenAIGPTConfig._sanitized_tools_update_for_openai is installed
    # Environment drift after installation cannot broaden the frozen boundary.
    os.environ['CODEX_ROUTER_API_FORWARD_BASE_URL'] = 'http://foreign.invalid/v1'
    assert config._sanitized_tools_update_for_openai({'tools': tools}, params) == {}
    foreign = {'custom_llm_provider': 'openai', 'api_base': os.environ['CODEX_ROUTER_API_FORWARD_BASE_URL']}
    assert config._sanitized_tools_update_for_openai({'tools': tools}, foreign) == original(config, {'tools': tools}, foreign)
    try:
        for invalid in ['', 'https://api.openai.com/v1', 'http://foreign.invalid/v1',
                'http://127.0.0.1:32123@foreign.invalid/v1', trusted + '?spoof=1', trusted + '/',
                'http://127.0.0.1:bad/v1', 'http://127.0.0.1:032123/v1', trusted + '\r\n', '\t' + trusted]:
            OpenAIGPTConfig._sanitized_tools_update_for_openai = original
            os.environ['CODEX_ROUTER_API_FORWARD_BASE_URL'] = invalid
            assert module.install_private_schema_preservation() is False, invalid
            assert OpenAIGPTConfig._sanitized_tools_update_for_openai is original
    finally:
        OpenAIGPTConfig._sanitized_tools_update_for_openai = installed
    assert tools == before
asyncio.run(main())
print('trusted sync/async schemas preserved; foreign/hosted/spoofed bases delegated; no provider requests')
`;
  const result = spawnSync(python, ["-I", "-B", "-c", script, path.join(root, "src/litellm_stream_cleanup_callback.py")], {
    encoding: "utf8", windowsHide: true, timeout: 45000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no provider requests/u);
});

test("pinned disconnect monitor cancels pending work and retires normal/error receive tasks", {
  skip: python ? false : "supply the hash-locked gateway interpreter with MODEL_ROUTER_TEST_LITELLM_PYTHON",
  timeout: 60000,
}, () => {
  const script = String.raw`
import asyncio, os
from types import SimpleNamespace
os.environ['LITELLM_LOCAL_MODEL_COST_MAP'] = 'True'
os.environ['LITELLM_TELEMETRY'] = 'False'
from fastapi import HTTPException
from litellm.proxy.common_request_processing import _await_llm_call_cancelling_on_disconnect as await_call

async def main():
    started, stopped = asyncio.Event(), asyncio.Event()
    async def receive():
        started.set()
        try: await asyncio.Event().wait()
        finally: stopped.set()
    async def completes():
        await started.wait()
        return 'completed'
    assert await await_call(SimpleNamespace(receive=receive), asyncio.create_task(completes())) == 'completed'
    await asyncio.wait_for(stopped.wait(), 1)
    async def disconnect(): return {'type': 'http.disconnect'}
    pending = asyncio.create_task(asyncio.Event().wait())
    try:
        await await_call(SimpleNamespace(receive=disconnect), pending)
        raise AssertionError('disconnect must cancel pending work')
    except HTTPException as error:
        assert error.status_code == 499
    assert pending.cancelled()
    # A receive failure must not manufacture caller cancellation. Its monitor
    # exits while the normal result remains authoritative.
    received = asyncio.Event()
    async def broken_receive():
        received.set()
        raise RuntimeError('synthetic receive failure')
    async def completes_after_receive():
        await received.wait()
        return 'completed after receive failure'
    assert await await_call(SimpleNamespace(receive=broken_receive), asyncio.create_task(completes_after_receive())) == 'completed after receive failure'
    await asyncio.sleep(0)
    assert not [task for task in asyncio.all_tasks() if task is not asyncio.current_task() and not task.done()]
asyncio.run(main())
print('pending work cancelled; normal/error receive monitors retired; no provider requests')
`;
  const result = spawnSync(python, ["-I", "-B", "-c", script], {
    encoding: "utf8", windowsHide: true, timeout: 45000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no provider requests/u);
});
