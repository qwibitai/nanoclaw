import asyncio
import logging
from typing import Optional

from google import genai
from google.genai import types

from . import config
from .workspace import WorkspaceClient

logger = logging.getLogger(__name__)


class GeminiBridge:
    """Bridges browser WebSocket audio <-> Gemini Live API session."""

    def __init__(self, workspace: Optional[WorkspaceClient] = None):
        self.client = genai.Client(
            http_options={"api_version": "v1beta"},
            api_key=config.GEMINI_API_KEY,
        )
        self.session = None
        self._ctx = None
        self.workspace = workspace

    def _build_config(self) -> types.LiveConnectConfig:
        tools = [
            types.Tool(google_search=types.GoogleSearch()),
        ]
        # Add Workspace functions if credentials are configured
        if self.workspace:
            tools.append(types.Tool(function_declarations=config.WORKSPACE_FUNCTIONS))

        return types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name="Kore"
                    )
                )
            ),
            context_window_compression=types.ContextWindowCompressionConfig(
                trigger_tokens=104857,
                sliding_window=types.SlidingWindow(target_tokens=52428),
            ),
            tools=tools,
            system_instruction=types.Content(
                parts=[types.Part.from_text(text=config.SYSTEM_PROMPT)],
                role="user",
            ),
        )

    async def connect(self):
        """Open Gemini Live session."""
        self._ctx = self.client.aio.live.connect(
            model=config.GEMINI_MODEL,
            config=self._build_config(),
        )
        self.session = await self._ctx.__aenter__()
        logger.info("Gemini Live session opened (workspace=%s)", bool(self.workspace))
        return self.session

    async def send_audio(self, pcm_bytes: bytes):
        """Send raw PCM audio chunk from browser to Gemini."""
        if self.session:
            await self.session.send(
                input={"data": pcm_bytes, "mime_type": "audio/pcm"}
            )

    async def send_text(self, text: str):
        """Send text input to Gemini."""
        if self.session:
            await self.session.send(input=text, end_of_turn=True)

    async def receive_responses(self, callback):
        """
        Continuously receive from Gemini and call callback with audio/text.
        Handles tool_call responses for Workspace function calling.
        callback signature: async callback(msg_type: str, data: bytes|str)
        """
        while True:
            try:
                if not self.session:
                    await asyncio.sleep(0.1)
                    continue
                turn = self.session.receive()
                async for response in turn:
                    if data := response.data:
                        await callback("audio", data)
                    if text := response.text:
                        await callback("text", text)
                    if response.tool_call:
                        await self._handle_tool_calls(response.tool_call, callback)

                # Turn ended (normal completion or barge-in interruption).
                # Signal browser to flush any queued audio immediately.
                await callback("turn_complete", "")
            except Exception as e:
                logger.error(f"Gemini receive error: {e}")
                break

    async def _handle_tool_calls(self, tool_call, callback):
        """Execute function calls from Gemini and send results back."""
        responses = []
        for fc in tool_call.function_calls:
            logger.info(f"Function call: {fc.name}({fc.args})")
            await callback("text", f"\n[Calling {fc.name}...]\n")

            if self.workspace:
                result = await self.workspace.dispatch(fc.name, fc.args or {})
            else:
                result = {"error": "Google Workspace not configured"}

            logger.info(f"Function result: {fc.name} -> {str(result)[:200]}")
            responses.append(types.FunctionResponse(
                id=fc.id,
                name=fc.name,
                response=result,
            ))

        await self.session.send_tool_response(function_responses=responses)

    async def disconnect(self):
        """Clean up Gemini session."""
        try:
            if self._ctx:
                await self._ctx.__aexit__(None, None, None)
        except Exception as e:
            logger.warning(f"Error closing Gemini session: {e}")
        self.session = None
        self._ctx = None
        logger.info("Gemini Live session closed")
