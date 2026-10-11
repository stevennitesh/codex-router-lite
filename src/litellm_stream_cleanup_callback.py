"""Compatibility for the pinned private Chat-to-Responses gateway.

The pinned LiteLLM completion bridge has no close hook. Its existing stream
wrapper owns cancellation shielding and idempotent SDK connection cleanup.
The OpenAI Chat sanitizer also drops valid ECMAScript schema expressions at
custom endpoints. Preserve prepared schemas only at Router's private forwarder.
Retire each hook when upstream supplies the equivalent behavior and its controls
pass; never change the sanitizer for other endpoints.
"""
import os
from functools import wraps
from types import MappingProxyType
from urllib.parse import urlsplit

from litellm.integrations.custom_logger import CustomLogger
from litellm.llms.openai.chat.gpt_transformation import OpenAIGPTConfig
from litellm.responses.litellm_completion_transformation.streaming_iterator import (
    LiteLLMCompletionStreamingIterator,
)


async def _close_completion_bridge(self):
    await self.litellm_custom_stream_wrapper.aclose()


def install_stream_cleanup():
    # An upstream or previously installed hook keeps cleanup ownership.
    if hasattr(LiteLLMCompletionStreamingIterator, "aclose"):
        return False
    LiteLLMCompletionStreamingIterator.aclose = _close_completion_bridge
    return True


def install_private_schema_preservation():
    original = OpenAIGPTConfig._sanitized_tools_update_for_openai
    if getattr(original, "_codex_router_private_schema_preservation", False):
        return False
    # start.mjs supplies this exact private base. Do not expand an environment
    # override into an exemption for a hosted, foreign or malformed endpoint.
    trusted_base = os.environ.get("CODEX_ROUTER_API_FORWARD_BASE_URL", "")
    try:
        endpoint = urlsplit(trusted_base)
        private = (
            endpoint.scheme == "http"
            and endpoint.hostname == "127.0.0.1"
            and endpoint.port is not None
            and 1 <= endpoint.port <= 65535
            and trusted_base == f"http://127.0.0.1:{endpoint.port}/v1"
        )
    except ValueError:
        private = False
    if not private:
        return False
    no_update = MappingProxyType({})

    @wraps(original)
    def sanitized_tools(self, optional_params, litellm_params):
        if (
            litellm_params.get("custom_llm_provider") == "openai"
            and litellm_params.get("api_base") == trusted_base
        ):
            # Both sync and async transforms already carry the prepared tools
            # in optional_params. No override preserves them without copying or
            # applying Python regex semantics to an ECMAScript declaration.
            return no_update
        return original(self, optional_params, litellm_params)

    sanitized_tools._codex_router_private_schema_preservation = True
    OpenAIGPTConfig._sanitized_tools_update_for_openai = sanitized_tools
    return True


install_stream_cleanup()
install_private_schema_preservation()
stream_cleanup_callback = CustomLogger()
