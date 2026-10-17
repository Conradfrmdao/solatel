"""Generate original soldier callouts with Qwen3-TTS CustomVoice (Apache-2.0).

Run in a Python environment with qwen-tts==0.1.1, soundfile, numpy and
imageio-ffmpeg. Download Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice to
.artifacts/qwen-voice-model. Existing Ryan WAVs are reused; delete one to
regenerate it. No model or runtime is shipped to players.
"""
from pathlib import Path
import subprocess
import numpy as np
import soundfile as sf
import imageio_ffmpeg
ROOT=Path(__file__).resolve().parents[1]
LINES=[('money-in-the-bag','Money in the bag!'),('got-him','Got him! And my money!'),('in-the-bag','In the bag!'),('paid','Ha! Just got paid!'),('yee-haw','Yee-haw! Got it!'),('bagged-it','Bagged it!'),('sweet-money','Sweet money!')]
DIRECTION='A soldier SHOUTING an aggressive triumphant victory callout to his squad. Full chest projection, loud emphatic shouted words, rough muscular vocal effort, excited and confident. Short punchy delivery. Dry isolated voice. No whisper, no calm narrator, no music.'

def main():
    source=ROOT/'.artifacts/soldier-voice-design'
    source.mkdir(parents=True,exist_ok=True)
    model=None
    out=ROOT/'assets/sounds/rewards';out.mkdir(parents=True,exist_ok=True)
    for name,text in LINES:
        path=source/f'{name}-ryan.wav'
        if not path.exists():
            if model is None:
                import torch
                from qwen_tts import Qwen3TTSModel
                torch.set_num_threads(2)
                torch.set_num_interop_threads(1)
                model=Qwen3TTSModel.from_pretrained(str(ROOT/'.artifacts/qwen-voice-model'),device_map='cpu',dtype=torch.float16,attn_implementation='sdpa',low_cpu_mem_usage=True)
            wavs,rate=model.generate_custom_voice(text=text,language='English',speaker='Ryan',instruct=DIRECTION,max_new_tokens=120)
            sf.write(path,wavs[0],rate)
        samples,rate=sf.read(path,dtype='float32')
        # Normalize each delivery, trim leading/trailing silence, soften the
        # ends and pack it as the same mono MP3 format as other game sounds.
        audible=np.flatnonzero(np.abs(samples)>.008)
        if audible.size:
            samples=samples[max(0,audible[0]-int(rate*.025)):min(len(samples),audible[-1]+int(rate*.08))]
        samples=samples*.83/max(float(np.max(np.abs(samples))),.01)
        fade=min(int(rate*.008),len(samples)//2)
        samples[:fade]*=np.linspace(0,1,fade);samples[-fade:]*=np.linspace(1,0,fade)
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-v','error','-y','-f','f32le','-ar',str(rate),'-ac','1','-i','pipe:0','-codec:a','libmp3lame','-b:a','96k',str(out/f'{name}.mp3')],input=samples.astype('<f4').tobytes(),check=True)
        print(name,round(len(samples)/rate,2),'seconds',flush=True)
if __name__=='__main__':main()
