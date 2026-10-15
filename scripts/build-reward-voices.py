"""Build original Solatel reward dialogue locally with Apache-2.0 Kokoro.

Install kokoro-onnx==0.6.1, soundfile and imageio-ffmpeg. Model files are
from https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1
and live under ignored .artifacts/kokoro-model. No model ships to players.
"""
from pathlib import Path
import sys,subprocess
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'.artifacts/kokoro-tools'))
import numpy as np
import onnxruntime as rt
import imageio_ffmpeg
from kokoro_onnx import Kokoro

LINES=[('money-in-the-bag','Money in the bag!'),('got-him','Got him! And my money!'),('in-the-bag','In the bag!'),('paid','Ha! Just got paid!'),('yee-haw','Yee-haw! Got it!')]
def main():
    model=ROOT/'.artifacts/kokoro-model'
    opts=rt.SessionOptions();opts.intra_op_num_threads=2;opts.inter_op_num_threads=1
    session=rt.InferenceSession(str(model/'kokoro-v1.0.int8.onnx'),opts,providers=['CPUExecutionProvider'])
    kokoro=Kokoro.from_session(session,str(model/'voices-v1.0.bin'))
    out=ROOT/'assets/sounds/rewards';out.mkdir(parents=True,exist_ok=True)
    for name,text in LINES:
        samples,rate=kokoro.create(text,voice='am_fenrir',speed=1.08,lang='en-us')
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
