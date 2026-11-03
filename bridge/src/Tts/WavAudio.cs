using System;
using System.IO;

namespace JunBridge.Tts;

public class WavAudio {
  public float[] Samples { get; private set; }  // interleaved, -1..1
  public int Channels { get; private set; }
  public int SampleRate { get; private set; }
  public int FrameCount => Samples.Length / Channels;

  // Parses a RIFF/WAVE buffer (PCM 8/16/24/32-bit and IEEE float 32-bit);
  // throws InvalidDataException on anything unsupported
  public static WavAudio Parse(byte[] data) {
    if (data == null || data.Length < 44) {
      throw new InvalidDataException("Buffer is too small to be a WAV file");
    }

    using var stream = new MemoryStream(data);
    using var reader = new BinaryReader(stream);

    if (ReadFourCc(reader) != "RIFF") {
      throw new InvalidDataException("Missing RIFF header");
    }

    reader.ReadUInt32(); // Overall size, unreliable for streamed files
    if (ReadFourCc(reader) != "WAVE") {
      throw new InvalidDataException("Missing WAVE header");
    }

    ushort audioFormat = 0;
    ushort channels = 0;
    uint sampleRate = 0;
    ushort bitsPerSample = 0;
    byte[] pcmData = null;

    // Walk chunks until we have both "fmt " and "data"
    while (stream.Position + 8 <= stream.Length) {
      var chunkId = ReadFourCc(reader);
      var chunkSize = reader.ReadUInt32();
      var chunkStart = stream.Position;

      if (chunkId == "fmt ") {
        audioFormat = reader.ReadUInt16();
        channels = reader.ReadUInt16();
        sampleRate = reader.ReadUInt32();
        reader.ReadUInt32(); // Byte rate
        reader.ReadUInt16(); // Block align
        bitsPerSample = reader.ReadUInt16();

        if (audioFormat == 0xFFFE && chunkSize >= 40) {
          // WAVE_FORMAT_EXTENSIBLE: real format is in the GUID sub-format
          reader.ReadUInt16(); // Extension size
          reader.ReadUInt16(); // Valid bits
          reader.ReadUInt32(); // Channel mask
          audioFormat = reader.ReadUInt16();
        }
      } else if (chunkId == "data") {
        // Some streaming servers write chunkSize = 0 or 0xFFFFFFFF; take the rest of the buffer then
        var available = stream.Length - chunkStart;
        var size = (chunkSize == 0 || chunkSize > available) ? available : chunkSize;
        pcmData = reader.ReadBytes((int)size);
      }

      if (pcmData != null && sampleRate != 0) {
        break;
      }

      // Chunks are word-aligned
      var nextPosition = chunkStart + chunkSize + (chunkSize % 2);
      if (nextPosition <= chunkStart || nextPosition > stream.Length) {
        break;
      }
      stream.Position = nextPosition;
    }

    if (pcmData == null || sampleRate == 0 || channels == 0) {
      throw new InvalidDataException("WAV file has no usable fmt/data chunks");
    }

    var samples = DecodeSamples(pcmData, audioFormat, bitsPerSample);

    return new WavAudio {
      Samples = samples,
      Channels = channels,
      SampleRate = (int)sampleRate
    };
  }

  private static float[] DecodeSamples(byte[] pcm, ushort audioFormat, ushort bitsPerSample) {
    switch (audioFormat) {
      case 1: // PCM
        return bitsPerSample switch {
          16 => DecodePcm16(pcm),
          24 => DecodePcm24(pcm),
          32 => DecodePcm32(pcm),
          8 => DecodePcm8(pcm),
          _ => throw new InvalidDataException($"Unsupported PCM bit depth: {bitsPerSample}")
        };

      case 3: // IEEE float
        if (bitsPerSample != 32) {
          throw new InvalidDataException($"Unsupported float bit depth: {bitsPerSample}");
        }
        return DecodeFloat32(pcm);

      default:
        throw new InvalidDataException($"Unsupported WAV format code: {audioFormat}");
    }
  }

  private static float[] DecodePcm8(byte[] pcm) {
    var samples = new float[pcm.Length];
    for (var i = 0; i < pcm.Length; i++) {
      samples[i] = (pcm[i] - 128) / 128f;
    }
    return samples;
  }

  private static float[] DecodePcm16(byte[] pcm) {
    var count = pcm.Length / 2;
    var samples = new float[count];
    for (var i = 0; i < count; i++) {
      samples[i] = BitConverter.ToInt16(pcm, i * 2) / 32768f;
    }
    return samples;
  }

  private static float[] DecodePcm24(byte[] pcm) {
    var count = pcm.Length / 3;
    var samples = new float[count];
    for (var i = 0; i < count; i++) {
      var offset = i * 3;
      var value = pcm[offset] | (pcm[offset + 1] << 8) | (pcm[offset + 2] << 16);
      if ((value & 0x800000) != 0) {
        value |= unchecked((int)0xFF000000); // Sign-extend
      }
      samples[i] = value / 8388608f;
    }
    return samples;
  }

  private static float[] DecodePcm32(byte[] pcm) {
    var count = pcm.Length / 4;
    var samples = new float[count];
    for (var i = 0; i < count; i++) {
      samples[i] = BitConverter.ToInt32(pcm, i * 4) / 2147483648f;
    }
    return samples;
  }

  private static float[] DecodeFloat32(byte[] pcm) {
    var count = pcm.Length / 4;
    var samples = new float[count];
    for (var i = 0; i < count; i++) {
      samples[i] = BitConverter.ToSingle(pcm, i * 4);
    }
    return samples;
  }

  private static string ReadFourCc(BinaryReader reader) {
    var bytes = reader.ReadBytes(4);
    if (bytes.Length < 4) {
      throw new InvalidDataException("Unexpected end of WAV data");
    }
    return System.Text.Encoding.ASCII.GetString(bytes);
  }
}
