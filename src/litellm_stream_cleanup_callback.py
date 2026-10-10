"""Close acquired Chat-to-Responses streams when a gateway turn is cancelled.

The pinned LiteLLM completion bridge has no close hook. Its existing stream
wrapper owns cancellation shielding and idempotent SDK connection cleanup.
Remove this compatibility module when LiteLLM supplies the bridge hook itself.
"""
from litellm.integrations.custom_logger import CustomLogger
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


install_stream_cleanup()
stream_cleanup_callback = CustomLogger()
