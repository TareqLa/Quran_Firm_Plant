// Quran Firm Plant - Faster Whisper features
// transformers.js zero-pads every clip to the full 30 s Whisper window before computing
// its log-mel spectrogram (~0.8 s of JavaScript per pass, even for a 3 s phrase). Every
// frame past the end of the audio comes out the same value, and the normalizing maximum
// comes from the real frames, so compute only those (plus a zero tail) and fill in the
// rest: the exact same features, an order of magnitude faster for a short phrase.

import { Tensor } from '@huggingface/transformers';

export function speedUpFeatureExtraction(pipe) {
  const extractor = pipe.processor?.feature_extractor;
  if (!extractor?._extract_fbank_features) return;
  const { n_samples, n_fft, hop_length, nb_max_frames } = extractor.config;
  const original = extractor._call.bind(extractor);

  extractor._call = async (audio, options = {}) => {
    // A zero tail longer than the analysis window, so the last frames are pure padding
    const length = audio.length + 2 * n_fft + hop_length;
    if (options.max_length != null || length >= n_samples) return original(audio, options);
    try {
      const waveform = new Float32Array(length);
      waveform.set(audio);
      const short = await extractor._extract_fbank_features(waveform);
      const [bins, frames] = short.dims;
      const data = short.data;
      // The last frame is pure padding: the value every padded frame gets.
      const full = new Float32Array(bins * nb_max_frames).fill(data[frames - 1]);
      for (let m = 0; m < bins; m++) full.set(data.subarray(m * frames, (m + 1) * frames), m * nb_max_frames);
      return { input_features: new Tensor('float32', full, [1, bins, nb_max_frames]) };
    } catch {
      return original(audio, options);
    }
  };
}
