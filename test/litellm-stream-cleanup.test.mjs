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
