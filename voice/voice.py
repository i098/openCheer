"""openCheer voice sidecar: microphone -> Deepgram STT (Pipecat) -> prints CHEER on a cheer phrase.

Run alone:  DEEPGRAM_API_KEY=... python voice/voice.py [--wav file.wav]
--wav feeds a 16 kHz mono 16-bit wav through the same pipeline instead of the microphone.
"""
import asyncio
import os
import re
import sys
import time
import wave

from pipecat.frames.frames import InputAudioRawFrame, StartFrame, TranscriptionFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineTask
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.deepgram.stt import DeepgramSTTService

PHRASES = ["lets go", "you got this", "come on claude", "keep going", "faster claude"]
COOLDOWN_S = 3  # same as cheerCooldownMs in overlay.html

norm = lambda t: re.sub(r"[^a-z ]", "", t.lower().replace("'", ""))


class CheerMatcher(FrameProcessor):
    last = -COOLDOWN_S

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):
            text = norm(frame.text)
            print(f"heard: {text}", file=sys.stderr, flush=True)
            if any(p in text for p in PHRASES) and time.monotonic() - self.last >= COOLDOWN_S:
                self.last = time.monotonic()
                print("CHEER", flush=True)
        await self.push_frame(frame, direction)


class WavSource(FrameProcessor):
    """Test input: streams a wav in real time, then 2 s of silence so Deepgram finalizes."""

    def __init__(self, path):
        super().__init__()
        self.path, self.task = path, None

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
        if isinstance(frame, StartFrame):
            self.create_task(self.play())

    async def play(self):
        with wave.open(self.path) as w:
            rate, data = w.getframerate(), w.readframes(w.getnframes())
        data += b"\0" * (rate * 2 * 2)
        step = rate // 50 * 2  # 20 ms
        for i in range(0, len(data), step):
            await self.push_frame(InputAudioRawFrame(audio=data[i:i + step], sample_rate=rate, num_channels=1))
            await asyncio.sleep(0.02)
        await asyncio.sleep(2)  # let the last transcript arrive
        await self.task.cancel()


async def main():
    key = os.environ.get("DEEPGRAM_API_KEY")
    if not key:
        sys.exit("DEEPGRAM_API_KEY is not set")
    wav = sys.argv[sys.argv.index("--wav") + 1] if "--wav" in sys.argv else None
    if wav:
        source = WavSource(wav)
    else:
        from pipecat.transports.local.audio import LocalAudioTransport, LocalAudioTransportParams
        transport = LocalAudioTransport(LocalAudioTransportParams(audio_in_enabled=True))
        source = transport.input()
    stt = DeepgramSTTService(api_key=key, sample_rate=16000)
    task = PipelineTask(Pipeline([source, stt, CheerMatcher()]))
    if wav:
        source.task = task
    await PipelineRunner(handle_sigint=True).run(task)


asyncio.run(main())
