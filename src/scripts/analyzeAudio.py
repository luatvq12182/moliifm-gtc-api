"""
Đo chất lượng tín hiệu của một file ghi âm luyện nói.

KHÔNG chấm phát âm — việc đó cần NGHE, mà máy chạy script này thì không nghe
được. Cái nó làm là đo những thứ ĐO ĐƯỢC, và chính những thứ đó đã giải thích
phần lớn các trường hợp "chấm sai" từ trước tới nay:

  - Dải tần thực tế: phát qua loa điện thoại rồi thu lại thì mất hết dải cao,
    mà dải cao là thứ phân biệt s/sh/x. Đo được thì biết ngay bản thu đi đường nào.
  - Mức tín hiệu và vỡ tiếng: quá nhỏ hoặc bị cắt đỉnh đều làm hỏng việc chấm.
  - Khoảng lặng đầu/cuối: liên quan tới lỗi căn chỉnh âm tiết đầu câu.
  - Nền nhiễu: tỉ lệ tín hiệu/nhiễu thấp thì mọi kết luận đều đáng ngờ.

Chạy:  python3 src/scripts/analyzeAudio.py <file.wav> [file2.wav ...]
"""

import sys
import wave
import math
import struct
import cmath

FFT_SIZE = 1024
HOP = 512


def read_wav(path):
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError("Chỉ hỗ trợ WAV 16-bit")
        channels = w.getnchannels()
        rate = w.getframerate()
        raw = w.readframes(w.getnframes())
    samples = struct.unpack("<%dh" % (len(raw) // 2), raw)
    if channels > 1:  # trộn về mono
        samples = [sum(samples[i:i + channels]) / channels
                   for i in range(0, len(samples) - channels + 1, channels)]
    return [s / 32768.0 for s in samples], rate


def fft(a):
    """Radix-2 Cooley-Tukey, lặp. Độ dài phải là luỹ thừa của 2."""
    n = len(a)
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            a[i], a[j] = a[j], a[i]
    length = 2
    while length <= n:
        ang = -2 * math.pi / length
        wl = cmath.exp(1j * ang)
        for i in range(0, n, length):
            w = 1 + 0j
            for k in range(i, i + length // 2):
                u = a[k]
                v = a[k + length // 2] * w
                a[k] = u + v
                a[k + length // 2] = u - v
                w *= wl
        length <<= 1
    return a


HANN = [0.5 - 0.5 * math.cos(2 * math.pi * i / (FFT_SIZE - 1)) for i in range(FFT_SIZE)]


def analyze(path):
    x, rate = read_wav(path)
    n = len(x)
    dur = n / rate

    peak = max((abs(v) for v in x), default=0.0)
    clipped = sum(1 for v in x if abs(v) >= 0.999)

    # Năng lượng theo cửa sổ 20ms, dùng để tách tiếng nói khỏi khoảng lặng.
    win = int(rate * 0.02)
    frames = []
    for off in range(0, n - win + 1, win):
        s = sum(v * v for v in x[off:off + win])
        frames.append(math.sqrt(s / win))
    if not frames:
        print("  (file quá ngắn)")
        return

    fpeak = max(frames)
    ordered = sorted(frames)
    noise_floor = ordered[len(ordered) // 5]           # phân vị 20
    speech_thr = max(noise_floor * 4, fpeak * 0.05)
    speech_idx = [i for i, v in enumerate(frames) if v > speech_thr]

    lead = speech_idx[0] * 0.02 if speech_idx else 0
    tail = (len(frames) - 1 - speech_idx[-1]) * 0.02 if speech_idx else 0
    speech_rms = (sum(frames[i] for i in speech_idx) / len(speech_idx)) if speech_idx else 0
    snr = 20 * math.log10(speech_rms / noise_floor) if noise_floor > 0 and speech_rms > 0 else float("inf")

    # Phổ trung bình, CHỈ trên các cửa sổ có tiếng nói.
    speech_start = speech_idx[0] * win if speech_idx else 0
    speech_end = (speech_idx[-1] + 1) * win if speech_idx else n
    spec = [0.0] * (FFT_SIZE // 2)
    count = 0
    for off in range(speech_start, max(speech_start, speech_end - FFT_SIZE), HOP):
        block = x[off:off + FFT_SIZE]
        if len(block) < FFT_SIZE:
            break
        buf = [complex(block[i] * HANN[i], 0.0) for i in range(FFT_SIZE)]
        fft(buf)
        for k in range(FFT_SIZE // 2):
            spec[k] += abs(buf[k]) ** 2
        count += 1
    if count == 0:
        print("  (không tìm thấy đoạn có tiếng nói)")
        return
    spec = [v / count for v in spec]

    bin_hz = rate / FFT_SIZE
    total = sum(spec) or 1.0

    def band_energy(lo, hi):
        return sum(spec[k] for k in range(len(spec)) if lo <= k * bin_hz < hi)

    # ------------------------------------------------------------------
    # THƯỚC ĐO — đã hiệu chỉnh bằng mẫu TTS sạch 16kHz cùng câu (25/08/2026).
    #
    # LẦN ĐẦU TÔI ĐO SAI: dùng "tần số chứa 95% năng lượng" rồi cảnh báo khi
    # dưới 3500Hz. Nhưng tiếng nói vốn dốc rất mạnh về phía tần số thấp — MẪU
    # TTS SẠCH cũng chỉ đạt 1453Hz theo thước đo đó. Ngưỡng ấy vô nghĩa, và nó
    # gắn cờ đỏ cho mọi file.
    #
    # Sai lầm thứ hai: bản thu học viên cho 98% năng lượng dưới 500Hz và tôi
    # suýt kết luận "mất dải cao". Thực ra đó là NHIỄU ÂM TRẦM che lấp phép đo —
    # cắt dải dưới 300Hz đi thì phổ trở lại gần bình thường.
    #
    # Nên đo hai chỉ số TÁCH BẠCH, mỗi cái so với mốc của tiếng nói sạch:
    #   rumble    — tỉ lệ năng lượng dưới 300Hz (nhiễu trầm, rung bàn, ù điện)
    #   brightness— tỉ lệ dải 1-8kHz TRONG phần trên 300Hz (độ "sáng" của tiếng)
    # ------------------------------------------------------------------
    REF_RUMBLE = 0.29     # mẫu TTS sạch
    REF_BRIGHTNESS = 0.30 # mẫu TTS sạch, sau khi bỏ dải dưới 300Hz

    rumble = band_energy(0, 300) / total
    above300 = band_energy(300, rate / 2) or 1.0
    brightness = band_energy(1000, rate / 2) / above300

    print(f"  Thời lượng      : {dur:.2f}s   ({rate} Hz)")
    print(f"  Đỉnh            : {20 * math.log10(peak) if peak > 0 else -99:.1f} dBFS"
          f"{'   *** VỠ TIẾNG (' + str(clipped) + ' mẫu chạm trần) ***' if clipped > 8 else ''}")
    print(f"  Mức tiếng nói   : {20 * math.log10(speech_rms) if speech_rms > 0 else -99:.1f} dBFS"
          + ("   *** QUÁ NHỎ ***" if speech_rms > 0 and 20 * math.log10(speech_rms) < -35 else ""))
    print(f"  Tỉ lệ tín/nhiễu : {snr:.1f} dB" + ("   *** THẤP ***" if snr < 20 else ""))
    print(f"  Lặng đầu / cuối : {lead:.2f}s / {tail:.2f}s")

    print(f"  Nhiễu âm trầm   : {rumble * 100:.0f}% năng lượng dưới 300Hz"
          f"   (tiếng nói sạch ~{REF_RUMBLE * 100:.0f}%)", end="")
    print("   *** NHIỀU ***" if rumble > REF_RUMBLE * 1.8 else "")

    print(f"  Độ sáng của tiếng: {brightness * 100:.0f}% nằm trên 1kHz"
          f"   (tiếng nói sạch ~{REF_BRIGHTNESS * 100:.0f}%)", end="")
    if brightness < REF_BRIGHTNESS * 0.4:
        print("   *** RẤT TỐI — nghi băng hẹp (Bluetooth/khử ồn mạnh) ***")
    elif brightness < REF_BRIGHTNESS * 0.7:
        print("   *** TỐI — nghi phát qua loa rồi thu lại ***")
    else:
        print("")

    print("  Phân bố năng lượng:")
    for lo, hi in [(0, 300), (300, 500), (500, 1000), (1000, 2000), (2000, 4000), (4000, 8000)]:
        pct = 100 * band_energy(lo, hi) / total
        print(f"    {lo:>5}-{hi:<5}Hz  {pct:5.1f}%  {'#' * max(0, min(40, int(pct / 2)))}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    for p in sys.argv[1:]:
        print("=" * 70)
        print(p)
        print("=" * 70)
        try:
            analyze(p)
        except Exception as e:
            print(f"  Lỗi: {e}")
        print()
