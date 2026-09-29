#!/usr/bin/env python3
"""
Мост к X-Voice: русская речь голосом актёра из оригинала.

Запускается сервисом dubpipe-worker в собственном окружении X-Voice — у модели
свои зависимости (CTranslate2 4.5, torch 2.8), несовместимые с окружением
сервиса. Процесс живёт, пока идёт озвучка: загрузка модели стоит десятки
секунд, реплика — секунду-две.

Длительность реплики задаётся явно: её уже выбрала стадия подгонки, и модель
проговаривает текст ровно в это время своим темпом, а не растягивается потом.
X-Voice — наследник F5-TTS, где заданная длина включает образец голоса: к
длине реплики прибавляется длина образца.

Протокол — по строке JSON в каждую сторону:
  на вход   {"ref": "/…/ref.wav", "ref_text": "...", "ref_lang": "en",
             "text": "...", "lang": "ru", "duration": 2.4, "steps": 32, "out": "/…/out.wav"}
  на выход  {"ok": true, "duration": 2.41}  либо  {"ok": false, "error": "..."}
Первой строкой: {"ready": true} — модель загружена.

Использование: python clone_bridge.py <каталог репозитория X-Voice>
"""
import json
import os
import sys
import tempfile
import time

# Всё, что X-Voice печатает сам, уходит в stderr: stdout — только протокол.
protocol = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr


def emit(payload):
    protocol.write(json.dumps(payload, ensure_ascii=False) + "\n")
    protocol.flush()


#: Настройки как в примере X-Voice Stage1; веса — с Hugging Face по пути репозитория.
CONFIG = """
model = "XVoice_Base_Stage1"
model_cfg = "src/x_voice/configs/XVoice_Base_Stage1.yaml"
ckpt_file = "hf://XRXRX/X-Voice/XVoice_Base_Stage1/model_600000.safetensors"
vocab_file = "hf://XRXRX/X-Voice/XVoice_Base_Stage1/vocab.txt"
ref_audio = "infer/examples/basic/basic_ref_en.wav"
ref_text = "Some call me nature, others call me mother nature."
gen_text = "Проба."
ref_lang = "en"
gen_lang = "ru"
auto_detect_lang = false
normalize_text = true
sp_type = "syllable"
vocoder_name = "vocos"
load_vocoder_from_local = true
target_rms = 0.1
cross_fade_duration = 0.15
nfe_step = 32
cfg_strength = 2.5
layered = true
cfg_strength2 = 4.0
cfg_schedule = "square"
cfg_decay_time = 0.6
sway_sampling_coef = -1.0
speed = 1.0
denoise_ref = true
loudness_norm = true
post_processing = true
reverse = false
"""


def load(xvoice_dir):
    """Загружает модель: модуль CLI X-Voice делает это при импорте."""
    handle, config = tempfile.mkstemp(suffix=".toml")
    with os.fdopen(handle, "w", encoding="utf-8") as stream:
        stream.write(CONFIG)
    sys.argv = ["clone_bridge", "-c", config]
    os.chdir(xvoice_dir)
    sys.path.insert(0, os.path.join(xvoice_dir, "src"))
    import x_voice.infer.infer_cli_stage1 as cli  # noqa: E402

    os.remove(config)
    return cli


class Voices:
    """Образцы голосов, уже подготовленные моделью: шумоподавление стоит секунд."""

    def __init__(self, cli):
        self.cli = cli
        self.cache = {}

    def get(self, path, text, lang):
        key = (path, text, lang)
        if key not in self.cache:
            import soundfile as sf

            audio, prepared = self.cli.preprocess_ref_audio_text(path, text)
            prepared = self.cli.normalize_text_for_lang(prepared, lang, self.cli.normalizer_cache)
            prepared = self.cli.ensure_ref_text_punctuation(prepared)
            self.cache[key] = (audio, prepared, sf.info(audio).duration)
        return self.cache[key]


#: Столько секунд X-Voice отводит на образец и текст вместе (utils_infer:
#: remaining_seconds = 22 - ref_seconds). Длиннее — он режет текст на куски.
XVOICE_WINDOW_SECONDS = 22


def split_for_duration(cli, text, lang, ref_text, ref_lang, ref_seconds, duration):
    """
    Куски текста и длительность каждого — так, чтобы в сумме вышла `duration`.

    X-Voice режет длинный текст на куски сам и каждому отдаёт заданную длину
    целиком: реплика на 14 с превращалась в два куска по 14 с, и дубляж
    наезжал на следующую реплику на 14 секунд. Поэтому режем здесь, теми же
    правилами (по концам предложений, по числу слогов), а время делим между
    кусками пропорционально слогам. Каждый кусок в пределах окна — второй раз
    X-Voice его не режет.
    """
    # Правила резки — из самого X-Voice: модуль CLI их не реэкспортирует.
    from x_voice.infer import utils_infer

    remaining = max(XVOICE_WINDOW_SECONDS - ref_seconds, 1.0)
    max_units = max(int(utils_infer.count_units(ref_text, ref_lang) / ref_seconds * remaining), 1)
    chunks = utils_infer.chunk_text_by_units(text, lang, max_units)
    if len(chunks) <= 1:
        return [(text, duration)]
    units = [utils_infer.count_units(chunk, lang) for chunk in chunks]
    total = sum(units)
    return [(chunk, duration * unit / total) for chunk, unit in zip(chunks, units)]


def say(cli, voices, request):
    import numpy as np
    import soundfile as sf

    lang = request.get("lang", "ru")
    ref_lang = cli.normalize_lang_code(request.get("ref_lang") or "en")
    ref_audio, ref_text, ref_seconds = voices.get(request["ref"], request.get("ref_text", ""), ref_lang)
    text = cli.normalize_text_for_lang(request["text"], lang, cli.normalizer_cache)
    duration = float(request["duration"])
    pieces = []
    rate = 24000
    for piece, seconds in split_for_duration(cli, text, lang, ref_text, ref_lang, ref_seconds, duration):
        audio, rate = synthesize(cli, ref_audio, ref_text, ref_lang, ref_seconds, piece, lang, seconds, request)
        pieces.append(audio)
    audio = np.concatenate(pieces) if len(pieces) > 1 else pieces[0]
    sf.write(request["out"], audio, rate, subtype="PCM_16")
    return len(audio) / rate


def synthesize(cli, ref_audio, ref_text, ref_lang, ref_seconds, text, lang, duration, request):
    """Один кусок ровно в `duration` секунд (в F5-подобных длина — вместе с образцом)."""
    audio, rate, _ = cli.infer_xvoice_process(
        ref_audio, ref_text, [text], ref_lang, [[(lang, text)]],
        cli.tokenizer, cli.ipa_tokenizer_getter, cli.ema_model, cli.vocoder, cli.lang_to_id_map,
        srp_model=None,
        mel_spec_type_value=cli.vocoder_name,
        target_rms_value=cli.target_rms,
        cross_fade_duration_value=cli.cross_fade_duration,
        nfe_step_value=int(request.get("steps") or cli.nfe_step),
        cfg_strength_value=cli.cfg_strength,
        layered=cli.layered,
        cfg_strength2_value=cli.cfg_strength2,
        cfg_schedule_value=cli.cfg_schedule,
        cfg_decay_time_value=cli.cfg_decay_time,
        sway_sampling_coef_value=cli.sway_sampling_coef,
        local_speed=1.0,
        fix_duration_value=ref_seconds + duration,
        sp_type="syllable",
        reverse=False,
        denoise_ref=cli.denoise_ref,
        loudness_norm=cli.loudness_norm,
        post_processing=cli.post_processing,
        remove_silence_chunk=False,
        device_name=cli.device,
    )
    if isinstance(audio, list):
        audio = audio[0]
    return audio, rate


def main():
    if len(sys.argv) < 2:
        emit({"ready": False, "error": "нужен путь к репозиторию X-Voice"})
        return 2
    started = time.time()
    try:
        cli = load(os.path.abspath(sys.argv[1]))
    except Exception as error:  # noqa: BLE001 — причина уходит вызывающему как есть
        emit({"ready": False, "error": f"X-Voice не загрузился: {type(error).__name__}: {error}"})
        return 3
    voices = Voices(cli)
    emit({"ready": True, "seconds": round(time.time() - started, 1)})

    for line in protocol_input():
        try:
            request = json.loads(line)
            emit({"ok": True, "duration": round(say(cli, voices, request), 3)})
        except Exception as error:  # noqa: BLE001
            emit({"ok": False, "error": f"{type(error).__name__}: {str(error)[:300]}"})
    return 0


def protocol_input():
    for line in sys.stdin:
        line = line.strip()
        if line:
            yield line


if __name__ == "__main__":
    sys.exit(main())
