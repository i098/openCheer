"""openCheer voice sidecar: microphone -> Deepgram STT (Pipecat).

Stdout lines: "LEVEL <0..1>" (microphone loudness, ~15 per second) and "SAY <text>" (each final transcript).

Run alone:  DEEPGRAM_API_KEY=... python voice/voice.py [--wav file.wav]
--wav feeds a 16 kHz mono 16-bit wav through the same pipeline instead of the microphone.
"""
import asyncio
import os
import sys
import time
import wave

import numpy as np

from pipecat.frames.frames import InputAudioRawFrame, StartFrame, TranscriptionFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineTask
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.deepgram.stt import DeepgramSTTService

LEVEL_GAIN = 8  # level = RMS (0..1 of full scale) * this, capped at 1: normal speech ~0.3, a shout 1
LEVEL_HZ = 15  # LEVEL lines per second


class LevelMeter(FrameProcessor):
    """Prints the loudest frame RMS of each 1/LEVEL_HZ interval as LEVEL <0..1>."""

    peak, last = 0.0, 0.0

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            x = np.frombuffer(frame.audio, dtype=np.int16).astype(np.float64) / 32768
            if x.size:
                self.peak = max(self.peak, float(np.sqrt(np.mean(x * x))))
            now = time.monotonic()
            if now - self.last >= 1 / LEVEL_HZ:
                self.last = now
                print(f"LEVEL {min(1.0, self.peak * LEVEL_GAIN):.3f}", flush=True)
                self.peak = 0.0
        await self.push_frame(frame, direction)


class Sayer(FrameProcessor):
    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):
            text = " ".join(frame.text.split())  # one line
            if text:
                print(f"SAY {text}", flush=True)
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
    task = PipelineTask(Pipeline([source, LevelMeter(), stt, Sayer()]))
    if wav:
        source.task = task
    await PipelineRunner(handle_sigint=True).run(task)


asyncio.run(main())
